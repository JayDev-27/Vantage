import { net, session, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MIN_WALLPAPER_SHORT_EDGE, type WallpaperItem } from '../shared/types'

const probeSources = new Map<string, string>()
let probeSession: Electron.Session | undefined
const PROBE_DOCUMENT = 'media://vantage-probe/'
const MAX_FRAME_EDGE = 3840
const THUMBNAIL_EDGE = 640

async function readLocalVideo<T>(filePath: string, script: string, timeoutMs: number): Promise<T | null> {
  if (!probeSession) {
    probeSession = session.fromPartition('vantage-video-metadata')
    probeSession.protocol.handle('media', async (request) => {
      if (request.url === PROBE_DOCUMENT) {
        return new Response('<!doctype html><body></body>', {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; media-src 'self'"
          }
        })
      }

      const fileUrl = probeSources.get(request.url)
      if (fileUrl) {
        try {
          return await net.fetch(fileUrl, { headers: request.headers })
        } catch { /* the source may have been moved or become unreadable */ }
      }
      return new Response(null, { status: 404 })
    })
  }

  const mediaUrl = `${PROBE_DOCUMENT}${randomUUID()}${extname(filePath).toLowerCase()}`
  const probe = new WebContentsView({
    webPreferences: { session: probeSession, sandbox: true, backgroundThrottling: false }
  })
  const { webContents } = probe
  let timer: ReturnType<typeof setTimeout> | undefined
  probeSources.set(mediaUrl, pathToFileURL(filePath).href)

  try {
    const readVideo = async (): Promise<T | null> => {
      await webContents.loadURL(PROBE_DOCUMENT)
      return webContents.executeJavaScript(`(${script})(${JSON.stringify(mediaUrl)})`)
    }
    return await Promise.race([
      readVideo(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    probeSources.delete(mediaUrl)
    if (!webContents.isDestroyed()) webContents.close()
  }
}

/** Use Chromium's metadata reader when system utilities cannot identify a video. */
export function probeVideoDimensions(filePath: string): Promise<WallpaperItem['resolution'] | null> {
  return readLocalVideo(filePath, `(url) => new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => resolve(video.videoWidth && video.videoHeight
      ? { width: video.videoWidth, height: video.videoHeight }
      : null)
    video.onerror = () => resolve(null)
    video.src = url
    document.body.append(video)
  })`, 5000)
}

export interface CapturedVideoFrame {
  resolution: WallpaperItem['resolution']
  full: Buffer
  thumbnail: Buffer
}

/** Decode the first displayed video frame using the same codecs as wallpaper playback. */
export async function captureVideoFirstFrame(filePath: string): Promise<CapturedVideoFrame | null> {
  const frame = await readLocalVideo<{
    resolution: WallpaperItem['resolution']
    full: string
    thumbnail: string
  }>(filePath, `(url) => new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.onerror = () => resolve(null)
    video.onloadeddata = () => {
      const width = video.videoWidth
      const height = video.videoHeight
      const shortEdge = Math.min(width, height)
      const longEdge = Math.max(width, height)
      if (shortEdge < ${MIN_WALLPAPER_SHORT_EDGE}) {
        resolve(null)
        return
      }

      // Keep ultrawide media above the resolution floor while avoiding unnecessary
      // 8K stills from larger conventional aspect ratios.
      const fullScale = Math.min(1, Math.max(${MAX_FRAME_EDGE} / longEdge, ${MIN_WALLPAPER_SHORT_EDGE} / shortEdge))
      const thumbScale = Math.min(1, ${THUMBNAIL_EDGE} / longEdge)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) {
        resolve(null)
        return
      }

      const jpeg = (scale, quality) => {
        canvas.width = Math.round(width * scale)
        canvas.height = Math.round(height * scale)
        context.imageSmoothingQuality = 'high'
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', quality)
      }

      try {
        const full = jpeg(fullScale, 0.87)
        const resolution = { width: canvas.width, height: canvas.height }
        const thumbnail = jpeg(thumbScale, 0.82)
        resolve({ full, thumbnail, resolution })
      } catch {
        resolve(null)
      }
    }
    video.src = url
    document.body.append(video)
  })`, 40000)

  const jpegPrefix = 'data:image/jpeg;base64,'
  if (!frame?.full.startsWith(jpegPrefix) || !frame.thumbnail.startsWith(jpegPrefix)) return null
  return {
    resolution: frame.resolution,
    full: Buffer.from(frame.full.slice(jpegPrefix.length), 'base64'),
    thumbnail: Buffer.from(frame.thumbnail.slice(jpegPrefix.length), 'base64')
  }
}
