#!/usr/bin/env node
/**
 * Catalog audit + repair.
 *
 *   node scripts/audit-catalog.mjs            # report only
 *   node scripts/audit-catalog.mjs --write    # apply fixes to resources/catalog.json
 *   node scripts/audit-catalog.mjs --links    # also HEAD-check every remote sourceUrl
 *
 * Fixes applied with --write:
 *   - keyword-based category correction (anime / games / heroes / cars / space / nature)
 *   - the "generative" category is reserved for procedural generators; videos move out
 *   - stray categories ("superhero", "fantasy") folded into the sidebar's categories
 *   - remote MotionBGS items get source "motionbgs" (was a mix of "ai" / "custom")
 *   - duplicate titles get a distinguishing suffix
 *   - bundled-but-uncatalogued videos in resources/wallpapers are added
 *   - built-in procedural generators (src/shared/generators.ts ids) are added
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify } from './lib/classify.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = path.join(root, 'resources', 'catalog.json')
const WRITE = process.argv.includes('--write')
const LINKS = process.argv.includes('--links')

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))

const report = { recategorized: {}, sourceFixed: 0, renamed: [], added: [], strays: 0 }
const moves = []

for (const item of catalog) {
  if (item.type === 'generative') continue
  const before = item.category
  let next = classify(item)
  if (!next) {
    if (before === 'generative') next = 'ai-art'
    else if (before === 'superhero') next = 'heroes'
    else if (before === 'fantasy') next = 'ai-art'
  }
  if (before === 'superhero' || before === 'fantasy') report.strays++
  if (next && next !== before) {
    // Local bundled items keep their curated category, and confident franchise
    // buckets (anime / games / heroes) only move between each other.
    const franchise = ['anime', 'games', 'heroes']
    if (item.source === 'local' || (franchise.includes(before) && !franchise.includes(next))) next = null
  }
  if (next && next !== before) {
    moves.push(`${before.padEnd(10)} → ${next.padEnd(7)} ${item.title}`)
    const key = `${before}→${next}`
    report.recategorized[key] = (report.recategorized[key] || 0) + 1
    item.category = next
  }
  if (/^https?:\/\/(www\.)?motionbgs\.com\//i.test(item.sourceUrl) && item.source !== 'motionbgs') {
    item.source = 'motionbgs'
    report.sourceFixed++
  }
}

// Duplicate titles
const seenTitles = new Map()
for (const item of catalog) {
  const k = item.title.trim().toLowerCase()
  if (seenTitles.has(k)) {
    const n = seenTitles.get(k) + 1
    seenTitles.set(k, n)
    const old = item.title
    item.title = `${item.title} ${['II', 'III', 'IV', 'V'][n - 2] || n}`
    report.renamed.push(`${old} → ${item.title}`)
  } else seenTitles.set(k, 1)
}

// Bundled videos that are not referenced by the catalog
const wallpaperDir = path.join(root, 'resources', 'wallpapers')
const referenced = new Set(catalog.map((i) => i.sourceUrl.toLowerCase().replace(/^extracted\//, '')))
for (const file of fs.existsSync(wallpaperDir) ? fs.readdirSync(wallpaperDir) : []) {
  if (!/\.(mp4|mov|webm)$/i.test(file) || referenced.has(file.toLowerCase())) continue
  const base = file.replace(/\.[^.]+$/, '')
  const id = `bundled-${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  if (catalog.some((i) => i.id === id)) continue
  const thumb = `resources/thumbnails/${id}.jpg`
  catalog.push({
    id,
    title: base.replace(/\b\w/g, (c) => c.toUpperCase()),
    category: classify({ title: base, id }) || 'anime',
    type: 'video',
    previewUrl: thumb,
    sourceUrl: `extracted/${file}`,
    resolution: { width: 2560, height: 1440 },
    source: 'local',
    license: 'Bundled with Vantage',
    attribution: 'Bundled wallpaper'
  })
  report.added.push(`${id} (${file})${fs.existsSync(path.join(root, thumb)) ? '' : ' — thumbnail missing, run scripts/create-thumbnail.mjs'}`)
}

// Procedural generators shipped in src/renderer/wallpaper/shaders
const GENERATORS = [
  ['gen-iris-bloom', 'Iris Bloom', 'iris-bloom'],
  ['gen-liquid-chrome', 'Liquid Chrome', 'liquid-chrome'],
  ['gen-silk-waves', 'Silk Waves', 'silk-waves'],
  ['gen-neon-horizon', 'Neon Horizon', 'neon-horizon'],
  ['gen-ink-nebula', 'Ink Nebula', 'ink-nebula'],
  ['gen-warp-drive', 'Warp Drive', 'warp-drive'],
  ['gen-aurora-veil', 'Aurora Veil', 'aurora-veil'],
  ['gen-lava-lamp', 'Lava Lamp', 'lava-lamp'],
  ['gen-quantum-field', 'Quantum Field', 'quantum'],
  ['gen-aurora-flow', 'Aurora Flow', 'aurora'],
  ['gen-nebula-drift', 'Nebula Drift', 'nebula']
]
for (const [id, title, generatorId] of GENERATORS) {
  if (catalog.some((i) => i.id === id)) continue
  catalog.push({
    id,
    title,
    category: 'generative',
    type: 'generative',
    previewUrl: '',
    sourceUrl: '',
    resolution: { width: 3840, height: 2160 },
    source: 'vantage',
    license: 'Vantage Original (MIT)',
    attribution: 'Procedural shader by Vantage',
    generatorId
  })
  report.added.push(`${id} (procedural)`)
}

// Integrity checks
const issues = []
const ids = new Set()
for (const item of catalog) {
  if (ids.has(item.id)) issues.push(`duplicate id ${item.id}`)
  ids.add(item.id)
  if (item.previewUrl && !/^https?:/.test(item.previewUrl) && !fs.existsSync(path.join(root, item.previewUrl))) issues.push(`missing thumbnail ${item.previewUrl}`)
  if (item.sourceUrl.startsWith('extracted/') && !fs.existsSync(path.join(wallpaperDir, item.sourceUrl.slice(10))) && !fs.readdirSync(wallpaperDir).some((f) => f.toLowerCase() === item.sourceUrl.slice(10).toLowerCase())) issues.push(`missing bundled video ${item.sourceUrl}`)
}

if (LINKS) {
  const remote = catalog.filter((i) => /^https?:/.test(i.sourceUrl))
  let cursor = 0
  const bad = []
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < remote.length) {
      const item = remote[cursor++]
      try {
        const res = await fetch(item.sourceUrl, { method: 'HEAD', signal: AbortSignal.timeout(20000) })
        if (!res.ok) bad.push(`${res.status} ${item.id}`)
      } catch (e) {
        bad.push(`ERR ${item.id} ${e.message}`)
      }
    }
  }))
  console.log(`Link check: ${remote.length - bad.length}/${remote.length} reachable`)
  bad.forEach((b) => console.log('  ' + b))
}

const counts = catalog.reduce((acc, i) => ((acc[i.category] = (acc[i.category] || 0) + 1), acc), {})
console.log('Recategorized:', report.recategorized)
console.log('Sources normalized:', report.sourceFixed, '· stray categories:', report.strays)
console.log('Renamed duplicates:', report.renamed)
console.log('Added:', report.added)
console.log('Category totals:', counts, '· total', catalog.length)
console.log('Integrity issues:', issues.length ? issues : 'none')
if (process.argv.includes('--verbose')) moves.forEach((m) => console.log('  ' + m))

if (WRITE) {
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 1) + '\n')
  console.log(`\nWrote ${catalogPath}`)
}
