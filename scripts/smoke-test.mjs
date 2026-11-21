#!/usr/bin/env node
/**
 * Sandbox smoke test for a built Vantage app.
 *
 *   node scripts/smoke-test.mjs <path-to-app-executable> [outDir]
 *
 * Launches the app as a brand-new install (empty, isolated user-data folder),
 * then checks over the DevTools protocol that:
 *   - the gallery window loads and lists the catalog,
 *   - every display gets a wallpaper window whose video actually plays,
 *   - on Windows, the wallpaper attached behind the desktop icons,
 *   - the main process logged no fatal errors.
 * Screenshots of every window plus the full log land in outDir.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exe = process.argv[2]
const outDir = path.resolve(process.argv[3] || 'smoke-artifacts')
if (!exe || !fs.existsSync(exe)) {
  console.error('Usage: node scripts/smoke-test.mjs <app executable> [outDir]')
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-smoke-'))
const PORT = 9555
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const log = fs.createWriteStream(path.join(outDir, 'app.log'))
const child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let logText = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => ((logText += d), log.write(d)))
let exited = null
child.on('exit', (code) => (exited = code))

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  } catch {
    return null
  }
}

async function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id))
  }
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  return {
    eval: async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value,
    shot: async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'))
    },
    close: () => ws.close()
  }
}

try {
  // 1) App starts and exposes its windows.
  let list = null
  for (let i = 0; i < 60 && !list?.some((t) => t.title.includes('Gallery')); i++) {
    if (exited !== null) break
    list = await targets()
    await sleep(1000)
  }
  check('app process stays alive', exited === null, exited !== null ? `exited with ${exited}` : '')
  const gallery = list?.find((t) => t.type === 'page' && t.title.includes('Gallery'))
  check('gallery window opens', !!gallery)

  if (gallery) {
    const g = await cdp(gallery)
    let count = 0
    for (let i = 0; i < 30 && count === 0; i++) {
      count = (await g.eval(`window.galleryApi ? galleryApi.getWallpapers('all','').then(l => l.length) : 0`)) || 0
      await sleep(1000)
    }
    check('catalog loads', count > 1000, `${count} wallpapers`)
    const tiles = await g.eval(`new Promise(r => setTimeout(() => r(document.querySelectorAll('[role=button][aria-label]').length), 2500))`)
    check('gallery renders wallpaper tiles', tiles > 0, `${tiles} tiles`)
    const displays = (await g.eval(`galleryApi.getDisplays()`)) || []
    check('displays detected', displays.length > 0, displays.map((d) => `${d.label} ${d.bounds.width}x${d.bounds.height}`).join(', '))
    await g.shot(path.join(outDir, 'gallery.png'))
    g.close()

    // 2) Every display's wallpaper window plays its video.
    list = await targets()
    const layers = (list || []).filter((t) => t.type === 'page' && t.title.includes('Wallpaper Layer'))
    const expected = process.platform === 'win32' && /Could not attach/.test(logText) ? 0 : displays.length
    check('one wallpaper window per display', layers.length === expected, `${layers.length} windows for ${displays.length} displays`)
    for (const [i, layer] of layers.entries()) {
      const w = await cdp(layer)
      let state = null
      for (let k = 0; k < 30; k++) {
        state = await w.eval(`(() => { const v = document.querySelector('video'); const c = document.querySelector('canvas'); return { video: !!v, ready: v ? v.readyState : -1, playing: v ? !v.paused && v.readyState >= 2 : false, canvas: !!c } })()`)
        if (state?.playing || state?.canvas) break
        await sleep(1000)
      }
      check(`wallpaper ${i + 1} is playing`, !!(state?.playing || state?.canvas), JSON.stringify(state))
      await w.shot(path.join(outDir, `wallpaper-${i + 1}.png`))
      w.close()
    }
  }

  // 3) Platform checks + log scan.
  if (process.platform === 'win32') {
    check('wallpaper attached behind desktop icons', /\[WindowsDesktop\] Attached wallpaper/.test(logText) && !/Could not attach/.test(logText))
  }
  const fatal = logText.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError|Cannot find module|ERR_FILE_NOT_FOUND/.test(l))
  check('no fatal errors in the log', fatal.length === 0, fatal.slice(0, 3).join(' | '))
} catch (err) {
  check('smoke test ran', false, String(err))
} finally {
  child.kill()
  await sleep(1500)
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  log.end()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
