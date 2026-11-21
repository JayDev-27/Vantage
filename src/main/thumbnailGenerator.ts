import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Deletes generated thumbnails that are no longer referenced by any wallpaper
 * row in the database.
 *
 * IMPORTANT: the "active" set is the basenames of files the DB currently
 * references (via `getWallpaperFileReferences`), NOT the contents of the
 * managed folder. Folder contents must not be used as the source of truth —
 * a wallpaper can legitimately live somewhere the folder scan does not cover,
 * and deleting its thumbnail would make its gallery tile vanish.
 *
 * Files written within the last few minutes are left alone so an in-flight
 * thumbnail generation is never pruned mid-write. Only files matching the
 * generated naming scheme `<name>-<16 hex>.png|.jpg` are considered.
 * Returns the number of files removed.
 */
export function pruneOrphanThumbnails(referencedBasenames: string[]): number {
  const thumbDir = path.join(app.getPath('userData'), 'thumbnails')
  if (!fs.existsSync(thumbDir)) return 0

  const referenced = new Set(referencedBasenames)
  const FRESH_WINDOW_MS = 5 * 60 * 1000
  const now = Date.now()
  let removed = 0

  let entries: string[]
  try {
    entries = fs.readdirSync(thumbDir)
  } catch {
    return 0
  }

  for (const entry of entries) {
    // This directory can contain support artifacts; only generated thumbnail
    // files are owned by this cleanup routine.
    if (!/^.+-[a-f0-9]{16}\.(?:png|jpg)$/i.test(entry) || referenced.has(entry)) continue
    // Never touch files that may still be mid-generation or non-regular files.
    let stat: fs.Stats
    try {
      stat = fs.statSync(path.join(thumbDir, entry))
    } catch {
      continue
    }
    if (!stat.isFile() || now - stat.mtimeMs < FRESH_WINDOW_MS) continue
    try {
      fs.unlinkSync(path.join(thumbDir, entry))
      removed++
    } catch {
      /* best-effort */
    }
  }
  if (removed > 0) {
    console.log(`[ThumbnailGenerator] Pruned ${removed} unreferenced thumbnail(s)`)
  }
  return removed
}
