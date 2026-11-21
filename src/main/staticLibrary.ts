import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { isHighResolution, type WallpaperItem } from '../shared/types'
import { addWallpaperToDb, pruneStaticWallpapers, getWallpaperById } from './db'
import { toMediaUrl } from './mediaUrl'
import { getMediaDimensions } from './mediaInfo'
import { INITIAL_WALLPAPERS } from './contentSources'

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const catalogTitles = new Map(INITIAL_WALLPAPERS.map((item) => [item.id, item.title]))
const imageDimensions = new Map<string, {
  mtimeMs: number
  ctimeMs: number
  size: number
  resolution: WallpaperItem['resolution']
}>()

const SPECIAL_WORDS: Record<string, string> = {
  '2b': '2B',
  '3b': '3B',
  '9s': '9S',
  'a2': 'A2',
  'jjk': 'JJK',
  'lol': 'LoL',
  'hsr': 'HSR',
  'zzz': 'ZZZ',
  'bmw': 'BMW',
  'ae86': 'AE86'
}

function formatStaticTitle(base: string): string {
  // 1. Try matching with initial catalog wallpapers
  const catalogTitle =
    catalogTitles.get(base) || catalogTitles.get(`motionbgs-${base}`) || catalogTitles.get(`wallpaperx-${base}`)
  if (catalogTitle) return catalogTitle

  // 2. Clean prefix & separators
  let cleaned = base
    .replace(/^(motionbgs|wallpaperx|local|user)[-_]/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()

  if (!cleaned) return base

  // 3. Capitalize words cleanly
  return cleaned
    .split(' ')
    .map((word) => {
      const lower = word.toLowerCase()
      if (SPECIAL_WORDS[lower]) return SPECIAL_WORDS[lower]
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
}

export interface StaticManifest {
  items: WallpaperItem[]
  presentIds: string[]
}

/** Folders that back the Static Wallpapers catalog:
 *  - the extracted Wallpaper X `Papers` folder checked out next to the app
 *  - a user drop-in `Static` folder inside the managed Vantage Wallpapers folder
 */
export function getStaticSourceDirs(): string[] {
  const dirs: string[] = []

  const appRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const extractedPapers = path.join(appRoot, 'Extracted_Video_Wallpapers', 'Papers')
  if (fs.existsSync(extractedPapers)) {
    dirs.push(extractedPapers)
  }

  const dropIn = path.join(app.getPath('pictures'), 'Vantage Wallpapers', 'Static')
  try {
    // Create the drop-in directory once so it is also watched when the user
    // adds it after the first launch.
    fs.mkdirSync(dropIn, { recursive: true })
    dirs.push(dropIn)
  } catch {
    // The user may have denied access to Pictures; keep the bundled source
    // available and let the caller report any watch failure.
  }

  return dirs
}

export function isStaticSourcePath(filePath: string): boolean {
  const resolved = path.resolve(filePath).toLowerCase()
  return getStaticSourceDirs().some((dir) =>
    resolved.startsWith(path.resolve(dir).toLowerCase() + path.sep)
  )
}

async function scanDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        !entry.name.startsWith('.') &&
        IMAGE_EXTS.includes(path.extname(entry.name).toLowerCase())
      )
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Scan all static source folders into a manifest of WallpaperItems */
export async function buildStaticManifest(): Promise<StaticManifest> {
  const tasks: Array<{ filePath: string; id: string; base: string; license: string; attribution: string }> = []

  const dirs = getStaticSourceDirs()
  const filesByDir = await Promise.all(dirs.map(scanDir))
  for (const [index, dir] of dirs.entries()) {
    const { license, attribution } = licenseAndAttribution(dir)
    const safeDir = path.basename(dir).replace(/[^a-zA-Z0-9_-]/g, '_')
    for (const name of filesByDir[index]) {
      const base = name.replace(/\.[^/.]+$/, '')
      const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '_')
      const id = `static-${safeDir}-${safeBase}`
      tasks.push({ filePath: path.join(dir, name), id, base, license, attribution })
    }
  }

  const scannedPaths = new Set(tasks.map(({ filePath }) => filePath))
  for (const filePath of imageDimensions.keys()) {
    if (!scannedPaths.has(filePath)) imageDimensions.delete(filePath)
  }

  const scannedItems: (WallpaperItem | undefined)[] = new Array(tasks.length)
  const CONCURRENCY = 6
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const taskIdx = cursor++
      const task = tasks[taskIdx]
      const stat = await fs.promises.stat(task.filePath).catch(() => null)
      if (!stat?.isFile()) {
        imageDimensions.delete(task.filePath)
        continue
      }

      const { mtimeMs, ctimeMs, size } = stat
      const cached = imageDimensions.get(task.filePath)
      const resolution = cached && cached.mtimeMs === mtimeMs && cached.ctimeMs === ctimeMs && cached.size === size
        ? cached.resolution
        : await getMediaDimensions(task.filePath)
      imageDimensions.set(task.filePath, { mtimeMs, ctimeMs, size, resolution })
      if (!isHighResolution(resolution)) continue

      const url = toMediaUrl(task.filePath)
      scannedItems[taskIdx] = {
        id: task.id,
        title: formatStaticTitle(task.base),
        category: 'static',
        type: 'image',
        previewUrl: url,
        sourceUrl: url,
        resolution,
        source: 'static',
        license: task.license,
        attribution: task.attribution
      }
    }
  })
  await Promise.all(workers)

  const items = new Map<string, WallpaperItem>()
  for (const item of scannedItems) {
    if (item && !items.has(item.id)) items.set(item.id, item)
  }
  return { items: [...items.values()], presentIds: [...items.keys()] }
}

function licenseAndAttribution(dir: string): { license: string; attribution: string } {
  if (path.basename(dir).toLowerCase() === 'static') {
    return { license: 'Local Folder Import', attribution: 'Local File' }
  }
  return {
    license: 'Wallpaper X Extracted Collection',
    attribution: 'Extracted from Wallpaper X (user-owned)'
  }
}

function staticWallpaperMatches(existing: WallpaperItem, item: WallpaperItem): boolean {
  return (
    existing.title === item.title &&
    existing.category === item.category &&
    existing.type === item.type &&
    existing.source === item.source &&
    existing.license === item.license &&
    existing.attribution === item.attribution &&
    existing.previewUrl === item.previewUrl &&
    existing.sourceUrl === item.sourceUrl &&
    existing.resolution.width === item.resolution.width &&
    existing.resolution.height === item.resolution.height
  )
}

/** Add new or changed static wallpapers to the DB and prune removed ones */
export async function syncStaticWallpapers(refreshAssignments: (prune: () => void) => void): Promise<number> {
  const { items, presentIds } = await buildStaticManifest()
  let added = 0
  for (const item of items) {
    const existing = getWallpaperById(item.id)
    if (!existing) {
      added++
      addWallpaperToDb(item)
    } else if (!staticWallpaperMatches(existing, item)) {
      // Metadata and paths can legitimately change when the app or source
      // folder is updated, but unchanged entries must not cause thousands of
      // synchronous SQLite writes on every filesystem event.
      addWallpaperToDb(item)
    }
  }
  refreshAssignments(() => pruneStaticWallpapers(presentIds))
  return added
}
