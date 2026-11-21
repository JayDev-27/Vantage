import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { probeVideoDimensions } from './videoDimensions'

const execFileAsync = promisify(execFile)
const MEDIA_PROBE_TIMEOUT_MS = 15_000
const MEDIA_PROBE_MAX_BUFFER_BYTES = 256 * 1024

interface Dimensions {
  width: number
  height: number
}

const DEFAULT_DIMENSIONS: Dimensions = { width: 1920, height: 1080 }

async function readImageDimensions(filePath: string): Promise<Dimensions | undefined> {
  const file = await fs.promises.open(filePath, 'r')
  try {
    const header = Buffer.alloc(32)
    const { bytesRead } = await file.read(header)
    if (bytesRead < 10) return
    if (header.toString('hex', 0, 8) === '89504e470d0a1a0a' && bytesRead >= 24) {
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    }
    if (header.toString('ascii', 0, 6) === 'GIF87a' || header.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) }
    }
    if (header.toString('ascii', 0, 2) === 'BM' && bytesRead >= 26) {
      const dibSize = header.readUInt32LE(14)
      if (dibSize === 12) return { width: header.readUInt16LE(18), height: header.readUInt16LE(20) }
      if (dibSize >= 40) return { width: header.readInt32LE(18), height: Math.abs(header.readInt32LE(22)) }
    }
    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') {
      const chunkType = header.toString('ascii', 12, 16)
      if (chunkType === 'VP8X' && bytesRead >= 30) {
        return { width: header.readUIntLE(24, 3) + 1, height: header.readUIntLE(27, 3) + 1 }
      }
      if (chunkType === 'VP8L' && bytesRead >= 25 && header[20] === 0x2f) {
        const packed = header.readUInt32LE(21)
        return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
      }
      if (chunkType === 'VP8 ' && bytesRead >= 30 && header.toString('hex', 23, 26) === '9d012a') {
        return { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff }
      }
    }
    if (header.readUInt16BE(0) !== 0xffd8) return

    const marker = Buffer.alloc(9)
    const scanLimit = 4 * 1024 * 1024
    let offset = 2
    while (offset < scanLimit) {
      const { bytesRead: markerBytes } = await file.read(marker, 0, marker.length, offset)
      if (markerBytes < 4 || marker[0] !== 0xff) break
      const code = marker[1]
      if (code === 0xff) {
        offset++
        continue
      }
      if (code === 0xda || code === 0xd9) break
      const size = marker.readUInt16BE(2)
      if (size < 2) break
      if (code >= 0xc0 && code <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(code) && markerBytes >= 9 && size >= 8) {
        return { width: marker.readUInt16BE(7), height: marker.readUInt16BE(5) }
      }
      offset += 2 + size
    }
  } finally {
    await file.close()
  }
}

/**
 * Read image dimensions without decoding pixels. Use ffprobe or macOS
 * metadata tools for media that cannot be measured from these headers.
 */
export async function getMediaDimensions(filePath: string): Promise<Dimensions> {
  try {
    const ext = path.extname(filePath).toLowerCase()

    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
      const dimensions = await readImageDimensions(filePath)
      if (dimensions && dimensions.width > 0 && dimensions.height > 0) return dimensions

      if (process.platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync(
            'sips',
            ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath],
            { timeout: MEDIA_PROBE_TIMEOUT_MS, maxBuffer: MEDIA_PROBE_MAX_BUFFER_BYTES }
          )
          const wMatch = stdout.match(/pixelWidth:\s*(\d+)/)
          const hMatch = stdout.match(/pixelHeight:\s*(\d+)/)
          if (wMatch && hMatch) {
            return { width: parseInt(wMatch[1], 10), height: parseInt(hMatch[1], 10) }
          }
        } catch { /* ignore CLI failure */ }
      }
    }

    // 2. Video dimensions via ffprobe / macOS mdls
    if (['.mp4', '.mov', '.webm', '.m4v', '.mkv'].includes(ext)) {
      // 2a. Try ffprobe first (works accurately for all cached/temp files)
      try {
        const { stdout } = await execFileAsync(
          'ffprobe',
          [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=s=x:p=0',
            filePath
          ],
          { timeout: MEDIA_PROBE_TIMEOUT_MS, maxBuffer: MEDIA_PROBE_MAX_BUFFER_BYTES }
        )
        const match = stdout.trim().match(/^(\d+)x(\d+)$/)
        if (match) {
          const width = parseInt(match[1], 10)
          const height = parseInt(match[2], 10)
          if (width > 0 && height > 0) return { width, height }
        }
      } catch {
        /* ffprobe unavailable */
      }

      // 2b. macOS mdls fallback (works for indexed user files outside Caches)
      if (process.platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync(
            'mdls',
            ['-name', 'kMDItemPixelWidth', '-name', 'kMDItemPixelHeight', filePath],
            { timeout: MEDIA_PROBE_TIMEOUT_MS, maxBuffer: MEDIA_PROBE_MAX_BUFFER_BYTES }
          )
          const wMatch = stdout.match(/kMDItemPixelWidth\s*=\s*(\d+)/)
          const hMatch = stdout.match(/kMDItemPixelHeight\s*=\s*(\d+)/)
          if (wMatch && hMatch && parseInt(wMatch[1], 10) > 0 && parseInt(hMatch[1], 10) > 0) {
            return { width: parseInt(wMatch[1], 10), height: parseInt(hMatch[1], 10) }
          }
        } catch { /* ignore */ }
      }

      const dimensions = await probeVideoDimensions(filePath)
      if (dimensions) return dimensions
    }
  } catch (err) {
    console.warn('[MediaInfo] Could not read dimensions for:', filePath, err)
  }

  return DEFAULT_DIMENSIONS
}
