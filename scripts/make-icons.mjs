/* ============================================================
   生成应用图标（纯 Node，零依赖）

   为什么不用 @tauri-apps/cli 的 icon 命令：
   它要求先装那个包，而且是另一条可能失败的链路。
   为什么不用 Rust 辅助程序：
   cargo 会为整个包跑 build script，而 tauri-build 又需要图标 ——
   死循环。所以图标必须在 cargo 之外生成。

   图形构思：夜蓝圆角方块 + 暖琥珀的「书脊 + 三行刻痕」。
   和界面视觉语言一致：深色为底、单一琥珀强调色、无渐变无发光。
   三行刻痕对应这个工具的三件事：设定、关系、时间。

   输出（都写进 src-tauri/icons/）：
     icon.png            1024×1024 源图
     32x32.png  128x128.png  128x128@2x.png  icon-512.png
     icon.ico            含 16/24/32/48/64/128/256 七种尺寸
     icon.icns           macOS 用，本机不需要，跳过

   跑法：npm run icons
   ============================================================ */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src-tauri', 'icons')

/* ---------------- 设计参数 ---------------- */

const BG_TOP = [17, 20, 29] // --color-surface
const BG_BOTTOM = [10, 12, 18] // --color-base
const AMBER = [217, 163, 85] // --color-accent
const INK = [233, 235, 242] // --color-ink
const CORNER = 0.22 // 圆角半径占边长比例
const SS = 4 // 每个像素的超采样数（抗锯齿）

/* ---------------- 画图 ---------------- */
/*
   最终采用的图形，试错结果：
   第一版是「竖线 + 三行」，竖线多余且把视觉重心推到左边，
   整体读起来像进度条而不是书。去掉竖线后三条横线自己就成立 ——
   简洁、小尺寸下也清楚。
   三行长度递减，最后一行用琥珀收尾，给层级和方向感。
*/

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

/** 圆角方块的覆盖率 */
function rectCoverage(px, py, size, radius) {
  let hits = 0
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS
      const y = py + (sy + 0.5) / SS
      if (x < 0 || x > size || y < 0 || y > size) continue
      const nearX = x < radius || x > size - radius
      const nearY = y < radius || y > size - radius
      if (nearX && nearY) {
        const cx = x < radius ? radius : size - radius
        const cy = y < radius ? radius : size - radius
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy > radius * radius) continue
      }
      hits++
    }
  }
  return hits / (SS * SS)
}

/** 圆角横条的范围检测 */
function inBar(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false
  const rr = Math.min(r, w / 2, h / 2)
  if (rr <= 0) return true
  const nearX = px < x + rr || px > x + w - rr
  const nearY = py < y + rr || py > y + h - rr
  if (nearX && nearY) {
    const cx = px < x + rr ? x + rr : x + w - rr
    const cy = py < y + rr ? y + rr : y + h - rr
    const dx = px - cx
    const dy = py - cy
    return dx * dx + dy * dy <= rr * rr
  }
  return true
}

function paintBar(px, py, x, y, w, h, r) {
  let hits = 0
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const fx = px + (sx + 0.5) / SS
      const fy = py + (sy + 0.5) / SS
      if (inBar(fx, fy, x, y, w, h, r)) hits++
    }
  }
  return hits / (SS * SS)
}

/** 渲染成 RGBA 像素数组 */
function render(size) {
  const s = size
  const radius = s * CORNER
  const px = new Uint8ClampedArray(s * s * 4)

  // 底：竖直极淡渐变 + 圆角
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const cov = rectCoverage(x, y, s, radius)
      const i = (y * s + x) * 4
      if (cov <= 0) continue
      const t = y / s
      px[i] = lerp(BG_TOP[0], BG_BOTTOM[0], t)
      px[i + 1] = lerp(BG_TOP[1], BG_BOTTOM[1], t)
      px[i + 2] = lerp(BG_TOP[2], BG_BOTTOM[2], t)
      px[i + 3] = Math.round(255 * cov)
    }
  }

  const blend = (x, y, color, alpha) => {
    if (x < 0 || y < 0 || x >= s || y >= s || alpha <= 0) return
    const i = (y * s + x) * 4
    const da = px[i + 3] / 255
    const na = alpha + da * (1 - alpha)
    if (na <= 0) return
    for (let c = 0; c < 3; c++) {
      px[i + c] = Math.round((color[c] * alpha + px[i + c] * da * (1 - alpha)) / na)
    }
    px[i + 3] = Math.round(na * 255)
  }

  const bar = (x, y, w, h, r, color, alpha) => {
    const x0 = Math.max(0, Math.floor(x - 1))
    const y0 = Math.max(0, Math.floor(y - 1))
    const x1 = Math.min(s, Math.ceil(x + w + 1))
    const y1 = Math.min(s, Math.ceil(y + h + 1))
    for (let py = y0; py < y1; py++) {
      for (let pxi = x0; pxi < x1; pxi++) {
        const cov = paintBar(pxi, py, x, y, w, h, r)
        if (cov > 0) blend(pxi, py, color, cov * alpha)
      }
    }
  }

  // 三行刻痕：首行最长，逐行递减，末行用琥珀收尾。
  // 居中对齐而不是左对齐 —— 左对齐会让右下角空出一大块，
  // 重心偏左上；居中后形成对称的收缩结构，像一个刻意的记号。
  // 整体在竖直方向也居中，这样图标放进窗口或任务栏时不会显得偏。
  const rows = [
    { len: 0.52, color: INK, alpha: 0.92 },
    { len: 0.38, color: INK, alpha: 0.92 },
    { len: 0.26, color: AMBER, alpha: 1 },
  ]
  const barH = 0.062
  const gap = 0.135
  const totalH = barH + gap * (rows.length - 1)
  const firstY = (1 - totalH) / 2
  rows.forEach((r, i) => {
    const y = s * (firstY + gap * i)
    const w = s * r.len
    bar((s - w) / 2, y, w, s * barH, (s * barH) / 2, r.color, r.alpha)
  })

  return px
}

/* ---------------- PNG 编码 ---------------- */

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function encodePNG(px, size) {
  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(raw, rowStart + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 把 RGBA 缩放（面积平均，质量够用且实现短） */
function resize(px, from, to) {
  const out = new Uint8ClampedArray(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      const y0 = Math.floor(y * ratio)
      const y1 = Math.min(from, Math.ceil((y + 1) * ratio))
      const x0 = Math.floor(x * ratio)
      const x1 = Math.min(from, Math.ceil((x + 1) * ratio))
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * from + sx) * 4
          r += px[i]
          g += px[i + 1]
          b += px[i + 2]
          a += px[i + 3]
          n++
        }
      }
      const o = (y * to + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return out
}

/* ---------------- ICO 打包 ---------------- */

function encodeICO(sizes) {
  const pngs = sizes.map(({ size, png }) => ({ size, png }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)

  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + 16 * pngs.length
  pngs.forEach(({ size, png }, i) => {
    const b = i * 16
    dir[b] = size >= 256 ? 0 : size // 256 记为 0
    dir[b + 1] = size >= 256 ? 0 : size
    dir[b + 2] = 0
    dir[b + 3] = 0
    dir.writeUInt16LE(1, b + 4) // color planes
    dir.writeUInt16LE(32, b + 6) // bits per pixel
    dir.writeUInt32LE(png.length, b + 8)
    dir.writeUInt32LE(offset, b + 12)
    offset += png.length
  })

  return Buffer.concat([header, dir, ...pngs.map((p) => p.png)])
}

/* ---------------- 主流程 ---------------- */

const SRC = 1024
console.log(`渲染 ${SRC}×${SRC} 源图…`)
const source = render(SRC)

mkdirSync(OUT, { recursive: true })

const sourcePng = encodePNG(source, SRC)
writeFileSync(join(OUT, 'icon.png'), sourcePng)
console.log(`  icon.png              ${(sourcePng.length / 1024).toFixed(1)} KB`)

const pngTargets = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon-512.png', 512],
]
for (const [name, size] of pngTargets) {
  const buf = encodePNG(resize(source, SRC, size), size)
  writeFileSync(join(OUT, name), buf)
  console.log(`  ${name.padEnd(20)} ${(buf.length / 1024).toFixed(1)} KB`)
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const ico = encodeICO(
  icoSizes.map((size) => ({ size, png: encodePNG(resize(source, SRC, size), size) })),
)
writeFileSync(join(OUT, 'icon.ico'), ico)
console.log(`  icon.ico              ${(ico.length / 1024).toFixed(1)} KB（含 ${icoSizes.length} 种尺寸）`)

console.log('\n完成。现在可以跑 cargo test 或 npm run desktop:build。')
