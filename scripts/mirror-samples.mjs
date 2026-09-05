/**
 * 镜像 smplr SplendidGrandPiano 采样到 public/samples/。
 *
 * 用法：node scripts/mirror-samples.mjs
 *
 * 数据来源：GitHub 仓库 smpldsnds/sfzinstruments-splendid-grand-piano（main 分支），
 * 经 jsDelivr CDN 下载（GitHub Pages 有每秒请求限流）。
 *
 * 落盘文件名把上游的 '#' 替换为 '♯'（U+266F）：Vite dev/preview 的静态服务无法
 * 正确解码 %23 路径（会回退到 index.html），而 Unicode 名可正常服务；引擎侧通过
 * preset.samples.map 完成 原始名 → ♯ 名 的映射（见 src/core/engine/smplr-engine.ts）。
 *
 * 许可：采样为 AKAI 公有领域（见 docs/development/reference/midi/format-and-libraries.md §7.2）。
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'smpldsnds/sfzinstruments-splendid-grand-piano'
const BRANCH = 'main'
const LIST_URL = `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${BRANCH}?structure=flat`
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`
const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../public/samples/sfzinstruments-splendid-grand-piano/samples',
)
const CONCURRENCY = 6

/** 磁盘安全文件名：'#' → '♯'（见文件头注释） */
const toDiskName = (name) => name.replaceAll('#', '♯')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function download(name, size, retries = 3) {
  const target = join(OUT_DIR, toDiskName(name))
  try {
    const st = await stat(target)
    if (st.size === size) return 'exists'
  } catch {
    // 不存在，继续
  }
  const url = `${CDN_BASE}/samples/${name.split('/').map(encodeURIComponent).join('/')}`
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length !== size) {
        throw new Error(`size mismatch: got ${buf.length}, expect ${size}`)
      }
      await writeFile(target, buf)
      return 'downloaded'
    } catch (err) {
      if (attempt === retries) throw err
      await sleep(500 * attempt)
    }
  }
  throw new Error('unreachable')
}

async function main() {
  console.log('fetching file list:', LIST_URL)
  const tree = await (await fetch(LIST_URL)).json()
  const samples = tree.files
    .filter((f) => /^\/samples\/.+\.(ogg|m4a)$/.test(f.name))
    .map((f) => ({ name: f.name.slice('/samples/'.length), size: f.size }))
  console.log(`files to mirror: ${samples.length}`)
  const totalBytes = samples.reduce((s, f) => s + f.size, 0)
  console.log(`total size: ${(totalBytes / 1048576).toFixed(1)} MB`)

  await mkdir(OUT_DIR, { recursive: true })

  let done = 0
  let downloaded = 0
  const failures = []
  const queue = [...samples]
  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift()
      try {
        const r = await download(f.name, f.size)
        if (r === 'downloaded') downloaded++
      } catch (err) {
        failures.push(`${f.name}: ${err.message}`)
      }
      done++
      if (done % 25 === 0 || done === samples.length) {
        const pct = ((done / samples.length) * 100).toFixed(1)
        const mb = (((downloaded / samples.length) * totalBytes) / 1048576).toFixed(1)
        console.log(
          `progress ${done}/${samples.length} (${pct}%) downloaded=${downloaded} (~${mb} MB new)`,
        )
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  if (failures.length > 0) {
    console.error(`\n${failures.length} failures:`)
    for (const f of failures.slice(0, 20)) console.error('  ' + f)
    process.exit(1)
  }
  console.log('\nOK: all samples mirrored to', OUT_DIR)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
