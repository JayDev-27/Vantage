import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_WALLPAPER_ID, isHighResolution, WallpaperItem } from '../../shared/types'
export type { WallpaperItem }

/**
 * Last-resort catalog used when resources/catalog.json is missing or corrupt.
 * Keeps the app fully functional (default wallpaper, gallery) instead of
 * bricking into a black screen and a dangling DEFAULT_WALLPAPER_ID.
 */
function fallbackCatalog(): WallpaperItem[] {
  console.error('[ContentSources] Using minimal fallback catalog.')
  return [
    {
      id: DEFAULT_WALLPAPER_ID,
      title: 'Vantage Default',
      category: 'featured',
      type: 'video',
      source: 'local',
      license: 'Vantage Default',
      attribution: 'Vantage Team',
      previewUrl: '',
      sourceUrl: 'extracted/v8.mp4',
      resolution: { width: 2560, height: 1440 },
      duration: 0
    }
  ]
}

function isWallpaperItem(value: unknown): value is WallpaperItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const resolution = item.resolution
  if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) return false
  const dimensions = resolution as Record<string, unknown>
  const requiredStrings = ['id', 'title', 'category', 'type', 'source', 'license', 'previewUrl', 'sourceUrl']
  if (!requiredStrings.every((key) => typeof item[key] === 'string')) return false
  if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || Number(dimensions.width) <= 0 || Number(dimensions.height) <= 0) return false
  if (item.duration !== undefined && (!Number.isFinite(item.duration) || Number(item.duration) < 0)) return false
  if (item.attribution !== undefined && typeof item.attribution !== 'string') return false
  if (item.generatorId !== undefined && typeof item.generatorId !== 'string') return false
  return item.colorPalette === undefined || (Array.isArray(item.colorPalette) && item.colorPalette.every((color) => typeof color === 'string'))
}

/**
 * Load the wallpaper catalog and verify that the bundled default is usable.
 */
function loadCatalog(): WallpaperItem[] {
  const catalogPath = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'catalog.json')
    : path.join(app.getAppPath(), 'resources', 'catalog.json')

  try {
    const raw = fs.readFileSync(catalogPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('[ContentSources] catalog.json is not an array of items.')
      return fallbackCatalog()
    }
    const items = parsed.filter(isWallpaperItem)
    if (items.length !== parsed.length) {
      console.warn(`[ContentSources] Ignored ${parsed.length - items.length} malformed catalog item(s).`)
    }

    if (!items.some((item) => item.id === DEFAULT_WALLPAPER_ID && isHighResolution(item.resolution))) {
      console.error('[ContentSources] catalog.json has no valid default wallpaper.')
      return fallbackCatalog()
    }

    return items
  } catch (err) {
    console.error('[ContentSources] Failed to load catalog.json:', err)
    return fallbackCatalog()
  }
}

export const CATALOG_WALLPAPERS = loadCatalog()
export const INITIAL_WALLPAPERS = CATALOG_WALLPAPERS.filter(
  (item) => item.type === 'generative' || isHighResolution(item.resolution)
)
