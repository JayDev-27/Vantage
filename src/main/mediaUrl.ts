import path from 'node:path'

/**
 * media:// URLs for local files.
 *
 * `media` is registered as a standard scheme, so Chromium treats the first path
 * segment after `media://` as the URL *host*. Putting the file path there broke on
 * Windows (the drive letter `D:` is not a valid host) and only worked on macOS by
 * luck (`/Users/...` became the case-folded host `users`). We now always use the
 * fixed host `local` and keep the whole path in the URL path:
 *
 *   /Users/me/a b#c.mp4  →  media://local/Users/me/a%20b%23c.mp4
 *   D:\Videos\x.mp4      →  media://local/D%3A/Videos/x.mp4
 *
 * Each segment is encoded so #, ?, % in filenames are never read as URL syntax.
 */
export function toMediaUrl(filePath: string): string {
  const segments = filePath.split(path.sep).join('/').split('/')
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/')
  return `media://local/${encoded.replace(/^\/+/, '')}`
}

/**
 * Resolve a media:// URL back to an absolute file path. Also accepts the legacy
 * form (`media:///Users/...` / `media://users/...`) still stored in older databases.
 */
export function fromMediaUrl(url: string): string | null {
  if (!/^media:/i.test(url)) return null
  let decoded: string
  try {
    const parsed = new URL(url)
    decoded =
      parsed.hostname === 'local'
        ? decodeURIComponent(parsed.pathname)
        : decodeURIComponent('/' + url.replace(/^media:\/+/i, ''))
  } catch {
    decoded = decodeURIComponent('/' + url.replace(/^media:\/+/i, ''))
  }
  // "/D:/Videos/x.mp4" → "D:/Videos/x.mp4" on Windows.
  if (process.platform === 'win32') decoded = decoded.replace(/^\/([A-Za-z]:)/, '$1')
  return path.resolve(decoded)
}
