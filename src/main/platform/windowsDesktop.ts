/**
 * Windows: place a BrowserWindow behind the desktop icons.
 *
 * Electron's `type: 'desktop'` only exists on macOS/Linux. On Windows the
 * established technique is to ask Progman to spawn a WorkerW window (message
 * 0x052C) and re-parent our window into it. Windows 11 24H2+ creates that
 * WorkerW as a child of Progman; older builds create it as a top-level sibling
 * of the window that hosts SHELLDLL_DefView. Both layouts are handled.
 *
 * Window handles are passed as plain integers (intptr_t). Typed koffi pointers
 * reject handles that come from a different source (Electron's handle buffer,
 * EnumWindows callbacks) with "Unexpected External value, expected HWND".
 *
 * Uses koffi (prebuilt FFI, no compiler needed). Every call is best-effort: if
 * anything fails the caller skips the wallpaper on that display.
 */
import type { BrowserWindow } from 'electron'

type Koffi = typeof import('koffi')
type Handle = number | bigint
interface User32 {
  koffi: Koffi
  EnumProc: unknown
  FindWindowW: (cls: string | null, name: string | null) => Handle
  FindWindowExW: (parent: Handle, after: Handle, cls: string | null, name: string | null) => Handle
  SendMessageTimeoutW: (hwnd: Handle, msg: number, w: number, l: number, flags: number, timeout: number, result: unknown) => Handle
  EnumWindows: (cb: unknown, l: number) => boolean
  SetParent: (child: Handle, parent: Handle) => Handle
  SetWindowPos: (hwnd: Handle, after: Handle, x: number, y: number, w: number, h: number, flags: number) => boolean
  MapWindowPoints: (from: Handle, to: Handle, pts: number[], count: number) => number
}

let user32: User32 | null | undefined

function load(): User32 | null {
  if (user32 !== undefined) return user32
  if (process.platform !== 'win32') return (user32 = null)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi: Koffi = require('koffi')
    const lib = koffi.load('user32.dll')
    const EnumProc = koffi.proto('bool __stdcall VantageEnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
    user32 = {
      koffi,
      EnumProc,
      FindWindowW: lib.func('intptr_t __stdcall FindWindowW(str16 cls, str16 name)'),
      FindWindowExW: lib.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 name)'),
      SendMessageTimeoutW: lib.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)'),
      EnumWindows: lib.func('bool __stdcall EnumWindows(VantageEnumWindowsProc *cb, intptr_t l)'),
      SetParent: lib.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)'),
      SetWindowPos: lib.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
      MapWindowPoints: lib.func('int __stdcall MapWindowPoints(intptr_t from, intptr_t to, _Inout_ int *pts, uint32_t count)')
    }
    return user32
  } catch (err) {
    console.warn('[WindowsDesktop] koffi/user32 unavailable:', err)
    return (user32 = null)
  }
}

const isNull = (h: Handle | null | undefined): boolean => h === null || h === undefined || h === 0 || h === BigInt(0)

function findWorkerW(u: User32): Handle | null {
  const progman = u.FindWindowW('Progman', null)
  if (isNull(progman)) return null
  // Ask Progman to create the WorkerW layer behind the icons.
  u.SendMessageTimeoutW(progman, 0x052c, 0xd, 0x1, 0x0, 1000, [0])
  u.SendMessageTimeoutW(progman, 0x052c, 0, 0, 0x0, 1000, [0])

  // Windows 11 24H2+: WorkerW is a child of Progman.
  const child = u.FindWindowExW(progman, 0, 'WorkerW', null)
  if (!isNull(child)) return child

  // Classic layout: the WorkerW sibling that follows the window hosting SHELLDLL_DefView.
  let worker: Handle | null = null
  const cb = u.koffi.register((hwnd: Handle) => {
    const defView = u.FindWindowExW(hwnd, 0, 'SHELLDLL_DefView', null)
    if (!isNull(defView)) {
      const w = u.FindWindowExW(0, hwnd, 'WorkerW', null)
      if (!isNull(w)) worker = w
    }
    return true
  }, u.koffi.pointer(u.EnumProc as never))
  try {
    u.EnumWindows(cb, 0)
  } finally {
    u.koffi.unregister(cb)
  }
  return worker ?? progman
}

/** Electron's native handle is a buffer holding the HWND value. */
function hwndOf(win: BrowserWindow): Handle {
  const buf = win.getNativeWindowHandle()
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0)
}

/** Re-parent `win` behind the desktop icons, sized to `bounds` (screen coordinates). Returns true on success. */
export function attachToDesktop(win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }, scaleFactor = 1): boolean {
  const u = load()
  if (!u) return false
  try {
    const worker = findWorkerW(u)
    if (worker === null || isNull(worker)) return false
    const hwnd = hwndOf(win)
    if (isNull(u.SetParent(hwnd, worker))) {
      console.warn('[WindowsDesktop] SetParent failed')
      return false
    }
    // Child windows are positioned relative to the WorkerW client area (physical pixels).
    const pts = [Math.round(bounds.x * scaleFactor), Math.round(bounds.y * scaleFactor)]
    u.MapWindowPoints(0, worker, pts, 1)
    const SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040
    u.SetWindowPos(hwnd, 0, pts[0], pts[1], Math.round(bounds.width * scaleFactor), Math.round(bounds.height * scaleFactor), SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    console.log(`[WindowsDesktop] Attached wallpaper behind desktop icons at ${pts[0]},${pts[1]} (${bounds.width}x${bounds.height} @${scaleFactor}x)`)
    return true
  } catch (err) {
    console.warn('[WindowsDesktop] attach failed:', err)
    return false
  }
}
