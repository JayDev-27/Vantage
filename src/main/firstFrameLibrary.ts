import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isHighResolution, type WallpaperItem } from '../shared/types'
import { getSavedFirstFrame, getWallpaperById, isFirstFrameSuppressed, saveFirstFrameToDb } from './db'
import { fromMediaUrl, toMediaUrl } from './mediaUrl'
import { cacheKeyForUrl, ensureCached, getCacheDir, isAllowedRemoteMediaUrl } from './videoCache'
import { captureVideoFirstFrame } from './videoDimensions'

const pending = new Map<string, Promise<boolean>>()
const captureGenerations = new Map<string, number>()
let captureQueue: Promise<unknown> = Promise.resolve()
let stopped = false

export function getFirstFrameDirectory(): string {
  return path.join(app.getPath('userData'), 'first-frames')
}

export function stopFirstFrameCapture(): void {
  stopped = true
}

async function isSavedFile(url: string): Promise<boolean> {
  const file = fromMediaUrl(url)
  const stat = file ? await fs.stat(file).catch(() => null) : null
  return Boolean(stat?.isFile() && stat.size > 0)
}

export async function removeSavedFrameFiles(still: WallpaperItem): Promise<void> {
  const directory = getFirstFrameDirectory()
  await Promise.all([still.sourceUrl, still.previewUrl].map(async (url) => {
    const file = fromMediaUrl(url)
    if (!file || path.dirname(file) !== directory || !/^[a-f0-9-]{36}(?:-thumb)?\.jpg$/i.test(path.basename(file))) return
    await fs.unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') console.warn('[FirstFrames] Could not remove generated image:', file, err)
    })
  }))
}

export function cancelFirstFrameCapture(videoId: string): void {
  captureGenerations.set(videoId, (captureGenerations.get(videoId) ?? 0) + 1)
}

interface CaptureOptions {
  cachedPath?: string
  restoreSuppressed?: boolean
}

async function captureAndSave(videoId: string, { cachedPath, restoreSuppressed = false }: CaptureOptions, generation: number): Promise<boolean> {
  const cancelled = () => stopped || (captureGenerations.get(videoId) ?? 0) !== generation
  if (cancelled() || (!restoreSuppressed && isFirstFrameSuppressed(videoId))) return false
  const video = getWallpaperById(videoId)
  if (video?.type !== 'video' || !isHighResolution(video.resolution)) {
    throw new Error('Choose a 2K or higher video wallpaper to save its first frame.')
  }

  const localPath = fromMediaUrl(video.sourceUrl)
  const stat = localPath ? await fs.stat(localPath).catch(() => null) : null
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([video.sourceUrl, stat?.size, stat?.mtimeMs, stat?.ctimeMs]))
    .digest('hex')
  if (cancelled()) return false
  const saved = getSavedFirstFrame(videoId)
  if (saved?.fingerprint === fingerprint) {
    const files = await Promise.all([isSavedFile(saved.still.sourceUrl), isSavedFile(saved.still.previewUrl)])
    if (files.every(Boolean)) return false
  }

  if (localPath && !stat?.isFile()) throw new Error('The source video could not be found.')
  if (!localPath && !isAllowedRemoteMediaUrl(video.sourceUrl)) {
    throw new Error('This video source is unavailable for frame capture.')
  }

  const file = localPath ?? cachedPath ?? await ensureCached(video.sourceUrl)
  if (cancelled()) return false
  // One retry: the first decode can miss its window on slow or busy machines.
  const frame = (await captureVideoFirstFrame(file)) ?? (cancelled() ? null : await captureVideoFirstFrame(file))
  if (cancelled()) return false
  if (!frame) throw new Error('Could not capture a first frame at 2K or higher.')

  // Publish the pair in one database transaction after both immutable JPEGs are on disk.
  const directory = getFirstFrameDirectory()
  const stem = randomUUID()
  const full = path.join(directory, `${stem}.jpg`)
  const thumb = path.join(directory, `${stem}-thumb.jpg`)
  let committed = false
  try {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(full, frame.full, { flag: 'wx' })
    await fs.writeFile(thumb, frame.thumbnail, { flag: 'wx' })
    if (cancelled()) return false
    committed = saveFirstFrameToDb(video, {
      id: `static-frame-${video.id}`,
      title: video.title,
      category: 'static',
      type: 'image',
      source: 'static',
      resolution: frame.resolution,
      previewUrl: toMediaUrl(thumb),
      sourceUrl: toMediaUrl(full),
      license: video.license,
      attribution: video.attribution
    }, fingerprint, restoreSuppressed)
  } finally {
    if (!committed) await Promise.allSettled([fs.unlink(full), fs.unlink(thumb)])
  }
  if (!committed) return false

  if (saved) await removeSavedFrameFiles(saved.still)
  return true
}

export function saveVideoFirstFrame(videoId: string, options: CaptureOptions = {}): Promise<boolean> {
  if (stopped) return Promise.resolve(false)
  const generation = captureGenerations.get(videoId) ?? 0
  const key = JSON.stringify([videoId, generation, Boolean(options.restoreSuppressed)])
  const existing = pending.get(key)
  if (existing) return existing

  const job = captureQueue.then(() => captureAndSave(videoId, options, generation))
    .finally(() => pending.delete(key))
  pending.set(key, job)
  captureQueue = job.catch(() => {})
  return job
}

export async function backfillFirstFrames(videos: WallpaperItem[], onSaved: () => void): Promise<void> {
  const cacheDir = getCacheDir()
  const cachedFiles = await fs.readdir(cacheDir).catch(() => [])
  const cacheByKey = new Map<string, string>()
  for (const file of cachedFiles) {
    const key = /^([a-f0-9]{40})\.(?:mp4|webm|mov|m4v|mkv)$/i.exec(file)?.[1]
    if (key) cacheByKey.set(key, path.join(cacheDir, file))
  }

  // Only decode files already on this machine. Submit one job at a time so a
  // request from the gallery can run ahead of the rest of the backfill.
  for (const video of videos) {
    if (stopped) return
    const cachedPath = cacheByKey.get(cacheKeyForUrl(video.sourceUrl))
    if (!cachedPath && !fromMediaUrl(video.sourceUrl)) continue
    const saved = await saveVideoFirstFrame(video.id, { cachedPath }).catch(() => false)
    if (saved) onSaved()
  }
}
