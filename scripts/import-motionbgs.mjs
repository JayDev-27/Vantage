#!/usr/bin/env node
/**
 * Import / refresh the MotionBGS part of the catalog.
 *
 *   node scripts/import-motionbgs.mjs            # crawl + report (writes scripts/.cache/motionbgs.json)
 *   node scripts/import-motionbgs.mjs --write    # also merge into resources/catalog.json
 *   node scripts/import-motionbgs.mjs --cached   # reuse the last crawl instead of fetching again
 *
 * What it does
 *   - Crawls MotionBGS listing pages (robots.txt allows "/") politely, one request at a time:
 *       /            → desktop wallpapers (16:9, HD/4K)
 *       /mobile/     → portrait wallpapers (9:16, 720×1280) for vertical monitors
 *   - Crawls MotionBGS tag pages (anime, manga, donghua, series, games, heroes, cars…) and
 *     uses those tags as ground truth for categories, so anime no longer leaks into other sections.
 *   - Adds new wallpapers with remote thumbnails (nothing new is bundled into the installer),
 *     recategorizes existing MotionBGS items from tags, and HEAD-checks new video URLs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify } from './lib/classify.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = path.join(root, 'resources', 'catalog.json')
const cacheDir = path.join(root, 'scripts', '.cache')
const cachePath = path.join(cacheDir, 'motionbgs.json')
const WRITE = process.argv.includes('--write')
const CACHED = process.argv.includes('--cached')
const BASE = 'https://motionbgs.com'
const UA = 'VantageCatalogBot/1.1 (+https://github.com/JayDev-27/Vantage)'
const DELAY_MS = 250

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
      if (res.ok) return await res.text()
      if (res.status === 404) return ''
    } catch {
      /* retry */
    }
    await sleep(1500 * (i + 1))
  }
  return ''
}

/** Listing tiles: <a ... href=/slug> <figure>… src=/i/c/WxH/media/ID/name.RES.jpg …<span class=ttl>Title</span> */
const TILE = /href=(\/(?:mobile\/)?[a-z0-9-]+)>\s*<figure>.*?src=\/i\/c\/[0-9x]+\/media\/(\d+)\/([^ >]+?)\.jpg.*?<span class=ttl>([^<]+)<\/span>/gs
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()

function parseTiles(html) {
  const out = []
  for (const m of html.matchAll(TILE)) {
    const [, href, mediaId, file, title] = m
    const resMatch = file.match(/\.(\d{3,4})x(\d{3,4})$/)
    out.push({
      href,
      mediaId: Number(mediaId),
      file, // e.g. "gojo-blue-eyes-jjk.720x1280" or "hoshimi-miyabi-zenless-zone-zero"
      title: decode(title),
      portrait: href.startsWith('/mobile/'),
      width: resMatch ? Number(resMatch[1]) : null,
      height: resMatch ? Number(resMatch[2]) : null
    })
  }
  return out
}

/** Walk /section/, /section/2/, … until a page brings nothing new (MotionBGS repeats its last page forever). */
async function crawlListing(section, label, maxPages = 2000) {
  const seen = new Map()
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}${section}${page === 1 ? '' : `${page}/`}`
    const tiles = parseTiles(await get(url))
    let fresh = 0
    for (const t of tiles) if (!seen.has(t.mediaId)) (seen.set(t.mediaId, t), fresh++)
    if (page % 25 === 0) console.log(`  ${label}: page ${page}, ${seen.size} wallpapers`)
    if (tiles.length === 0 || fresh === 0) break
    await sleep(DELAY_MS)
  }
  console.log(`  ${label}: ${seen.size} wallpapers`)
  return [...seen.values()]
}

// ---- Tag groups → Vantage categories (checked in this order) ----
const TAGS = {
  heroes: ['marvel', 'batman', 'avengers', 'dc-comics', 'joker', 'iron-man', 'venom', 'miles-morales', 'deadpool', 'superhero', 'spiderman', 'superman', 'invincible', 'marvel-rivals'],
  gamesFranchise: ['fortnite', 'kratos', 'dva', 'mobile-legends', 'irelia', 'ayaka', 'assassins-creed', 'warhammer', 'honkai-star-rail', 'cyberpunk', 'jinx', 'akali', 'chisa', 'skyrim', 'roblox', 'honkai', 'punishing-gray-raven', 'codm', 'fnaf', 'yasuo', 'tower-of-fantasy', 'witcher', 'nier-automata', 'furina', '2b', 'csgo', 'resident-evil', 'pubg', 'elden-ring', 'apex-legends', 'the-last-of-us', 'titanfall', 'ruiner', 'pokemon', 'final-fantasy', 'arknights', 'need-for-speed', 'hollow-knight', 'warcraft', 'minecraft', 'cyberpunk-2077', 'kokomi', 'overwatch', 'helldivers-2', 'call-of-duty', 'sonic', 'valorant', 'hu-tao', 'gta', 'azur-lane', 'keqing', 'sekiro', 'yae-miko', 'god-of-war', 'zelda', 'warframe', 'ganyu', 'shenhe', 'sea-of-thieves', 'dota-2', 'brawl-stars', 'ghost-of-tsushima', 'fallout', 'diana', 'goddess-of-victory-nikke', 'league-of-legends', 'doom', 'genshin-impact', 'rdr', 'wukong', 'arcane', 'zenless-zone-zero', 'persona', 'wuthering-waves', 'blue-archive', 'girls-frontline', 'hunt-showdown', 'mortal-kombat', 'princess-connect', 'umamusume'],
  anime: ['anime', 'manga', 'donghua', 'anime-nature', 'eren-yeager', 'obito', 'zenitsu', 'gogeta', 'killua', 'akaza', 'makima', 'kokushibo', 'sword-art-online', 'zoro', 'minato-namikaze', 'ichigo', 'fate', 'giyu-tomioka', 'baki', 'asta', 'haikyuu', 'yoriichi', 'gundam', 'tokyo-revengers', 'mikasa-ackerman', 'pain', 'vegeta', 'toji-fushiguro', 'hxh', 'gohan', 'tanjiro-kamado', 'rengoku', 'touhou', 'nezuko', 'denji', 'my-hero-academia', 'levi-ackerman', 'saber', 'deku', 'op-man', 'berserk', 'blue-lock', 'madara-uchiha', 'spy-x-family', 'hatsune-miku', 'fairy-tail', 'yuji-itadori', 'ghibli', 'naruto-uzumaki', 'ken-kaneki', 'made-in-abyss', 'black-clover', 'tengen-uzui', 'power', 'solo-leveling', 'kakashi', 'bleach', 'satoru-gojo', 'jujutsu-kaisen', 'death-note', 'luffy', 'jojos-bizarre-adventure', 'goku', 'tokyo-ghoul', 'sharingan', 'chainsaw-man', 'attack-on-titan', 'zero-two', 'mushoku-tensei', 'wind-breaker', 'itachi-uchiha', 'ultra-instinct', 'mob-psycho', 'yuta', 'one-piece', 'demon-slayer', 'reze', 'sasuke', 'naruto-art', 'shinobu', 'choso', 'rezero', 'dandadan', 'obanai', 'dragon-ball', 'ryomen-sukuna', 'frieren', 'your-name', 'hololive'],
  gamesGeneric: ['games'],
  cars: ['volkswagen', 'honda', 'mitsubishi', 'jdm', 'dodge', 'mustang', 'porsche', 'mclaren', 'bmw', 'nissan', 'ford', 'mercedes', 'lamborghini', 'sports-cars', 'gtr', 'ferrari', 'mazda', 'subaru', 'toyota', 'audi', 'car', 'formula-1', 'bike'],
  space: ['astronaut', 'space', 'earth', 'black-hole'],
  nature: ['spring', 'waves', 'waterfall', 'water', 'fish-pond', 'snow', 'beach', 'autumn-leaves', 'sunset', 'nature', 'sunrise', 'winter', 'forest', 'mountain', 'ocean', 'rain', 'landscape'],
  animeGirl: ['girl']
}

async function crawlTags() {
  const tagOf = new Map() // mediaId -> Set(tag)
  const all = [...new Set(Object.values(TAGS).flat())]
  let i = 0
  for (const tag of all) {
    const tiles = await crawlListing(`/tag:${tag}/`, `tag:${tag}`, 200)
    for (const t of tiles) {
      if (!tagOf.has(t.mediaId)) tagOf.set(t.mediaId, new Set())
      tagOf.get(t.mediaId).add(tag)
    }
    if (++i % 20 === 0) console.log(`  tags: ${i}/${all.length}`)
  }
  return tagOf
}

function categoryFromTags(tags) {
  if (!tags || tags.size === 0) return null
  const has = (group) => TAGS[group].some((t) => tags.has(t))
  if (has('heroes')) return 'heroes'
  if (has('gamesFranchise')) return 'games'
  if (has('anime')) return 'anime'
  if (has('gamesGeneric')) return 'games'
  if (has('cars')) return 'cars'
  if (has('space')) return 'space'
  if (has('nature')) return 'nature'
  if (has('animeGirl')) return 'anime'
  return null
}

const slugToTitle = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// ---------------- main ----------------
fs.mkdirSync(cacheDir, { recursive: true })
let crawl
if (CACHED && fs.existsSync(cachePath)) {
  crawl = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  crawl.tagOf = new Map(Object.entries(crawl.tagOf).map(([k, v]) => [Number(k), new Set(v)]))
  console.log('Using cached crawl from', crawl.at)
} else {
  console.log('Crawling MotionBGS (politely, one request at a time)…')
  const desktop = await crawlListing('/', 'desktop')
  const portrait = await crawlListing('/mobile/', 'portrait')
  const tagOf = await crawlTags()
  crawl = { at: new Date().toISOString(), desktop, portrait, tagOf }
  fs.writeFileSync(cachePath, JSON.stringify({ ...crawl, tagOf: Object.fromEntries([...tagOf].map(([k, v]) => [k, [...v]])) }))
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
const mediaIdOf = (url) => Number((url.match(/motionbgs\.com\/media\/(\d+)\//) || [])[1] || 0)
const existingByMedia = new Map(catalog.filter((i) => mediaIdOf(i.sourceUrl)).map((i) => [mediaIdOf(i.sourceUrl), i]))
const ids = new Set(catalog.map((i) => i.id))

// 1) Recategorize existing MotionBGS items from tags.
const moved = {}
for (const [mediaId, item] of existingByMedia) {
  const cat = categoryFromTags(crawl.tagOf.get(mediaId))
  if (cat && cat !== item.category && item.type !== 'generative') {
    const key = `${item.category}→${cat}`
    moved[key] = (moved[key] || 0) + 1
    item.category = cat
  }
}

// 2) Add new desktop + portrait wallpapers.
const added = []
for (const t of [...crawl.desktop, ...crawl.portrait]) {
  if (existingByMedia.has(t.mediaId)) continue
  const base = t.file.replace(/\.\d{3,4}x\d{3,4}$/, '')
  const width = t.width ?? (t.portrait ? 720 : 1920)
  const height = t.height ?? (t.portrait ? 1280 : 1080)
  const resSuffix = `${width}x${height}`
  let id = `motionbgs-${t.portrait ? 'p-' : ''}${base}`
  if (ids.has(id)) id = `${id}-${t.mediaId}`
  ids.add(id)
  const thumbSize = t.portrait ? '304x540' : '546x308'
  added.push({
    id,
    title: t.title || slugToTitle(base),
    category: categoryFromTags(crawl.tagOf.get(t.mediaId)) || classify({ title: t.title || base, id: base }) || 'ai-art',
    type: 'video',
    previewUrl: `${BASE}/i/c/${thumbSize}/media/${t.mediaId}/${t.file}.jpg`,
    sourceUrl: `${BASE}/media/${t.mediaId}/${base}.${resSuffix}.mp4`,
    resolution: { width, height },
    source: 'motionbgs',
    license: 'MotionBGS Free License',
    attribution: t.portrait ? 'MotionBGS Mobile Collection' : 'MotionBGS Collection',
    _noSuffix: t.width == null
  })
}

// 3) Verify video URLs: every item whose resolution had to be guessed, plus a random sample.
async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })
    return res.status
  } catch {
    return 0
  }
}
async function resolveFromDl(item) {
  // /dl/hd/<id>/ answers with the real filename in Content-Disposition.
  const mediaId = mediaIdOf(item.sourceUrl)
  for (const kind of item.resolution.height > item.resolution.width ? ['mhd'] : ['4k', 'hd']) {
    try {
      const res = await fetch(`${BASE}/dl/${kind}/${mediaId}/`, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })
      const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1]
      if (res.ok && name) {
        const m = name.match(/\.(\d{3,4})x(\d{3,4})\.mp4$/)
        item.sourceUrl = `${BASE}/media/${mediaId}/${name}`
        if (m) item.resolution = { width: Number(m[1]), height: Number(m[2]) }
        return true
      }
    } catch {
      /* try next */
    }
  }
  return false
}
// Thumbnails without a resolution suffix hide the video size: MotionBGS serves those as
// 4K about two-thirds of the time and 1080p otherwise, so try 4K, then 1080p, then /dl/.
const toCheck = added.filter((i) => i._noSuffix)
const sample = added.filter((i) => !i._noSuffix).sort(() => Math.random() - 0.5).slice(0, 300)
let ok = 0
const dropped = []
async function verify(item) {
  if (item._noSuffix) {
    const mediaId = mediaIdOf(item.sourceUrl)
    const base = item.sourceUrl.split('/').pop().replace(/\.\d{3,4}x\d{3,4}\.mp4$/, '')
    for (const [w, h] of [[3840, 2160], [1920, 1080]]) {
      const url = `${BASE}/media/${mediaId}/${base}.${w}x${h}.mp4`
      if ((await head(url)) === 200) {
        item.sourceUrl = url
        item.resolution = { width: w, height: h }
        return true
      }
    }
    return resolveFromDl(item)
  }
  return (await head(item.sourceUrl)) === 200 || resolveFromDl(item)
}
const queue = [...toCheck, ...sample]
let cursor = 0
let done = 0
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < queue.length) {
    const item = queue[cursor++]
    if (await verify(item)) ok++
    else dropped.push(item.id)
    if (++done % 500 === 0) console.log(`  verified ${done}/${queue.length}`)
  }
}))

const finalAdded = added.filter((i) => !dropped.includes(i.id)).map(({ _noSuffix, ...rest }) => rest)

const counts = {}
for (const i of finalAdded) counts[`${i.resolution.height > i.resolution.width ? 'portrait' : 'desktop'}/${i.category}`] = (counts[`${i.resolution.height > i.resolution.width ? 'portrait' : 'desktop'}/${i.category}`] || 0) + 1
console.log('\nRecategorized existing:', moved)
console.log(`Verified ${ok}/${toCheck.length + sample.length} checked video URLs; dropped ${dropped.length}`)
console.log('New wallpapers:', finalAdded.length, counts)

if (WRITE) {
  const merged = [...catalog, ...finalAdded]
  fs.writeFileSync(catalogPath, JSON.stringify(merged, null, 1) + '\n')
  console.log(`Wrote ${merged.length} items to ${catalogPath}`)
}
