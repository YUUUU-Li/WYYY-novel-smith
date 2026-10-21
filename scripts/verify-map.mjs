/* ============================================================
   地图视图的浏览器核对

   为什么需要它：
   「上传了底图，画布上还压着『这张地图还是空的』」这类问题，
   读代码只能猜到一半 —— 上传这条路要经过 FileReader、
   Image.onload、setMaps、重渲染，中间任何一步断了，
   症状看起来都一样。只有在真浏览器里走一遍完整路径才分得清。

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/verify-map.mjs
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9345
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'

/* ---------------- 造一张测试底图（800x400，2:1）---------------- */

function crcTable() {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
}
const CRC = crcTable()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
/** 左右两半颜色分明、四周一圈红框 —— 这样一眼能看出有没有被拉伸或裁切 */
function makePng(w, h, noisy = false) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  /* 用一个固定种子的伪随机数，保证噪声不可压缩、且每次跑出来一样大 */
  let seed = 0x2f6e2b1
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) % 256) | 0
  }
  for (let y = 0; y < h; y++) {
    const off = y * stride
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3
      if (noisy) {
        raw[p] = rnd()
        raw[p + 1] = rnd()
        raw[p + 2] = rnd()
        continue
      }
      const edge = x < 6 || y < 6 || x >= w - 6 || y >= h - 6
      const left = x < w / 2
      raw[p] = edge ? 200 : left ? 45 : 205
      raw[p + 1] = edge ? 55 : left ? 70 : 195
      raw[p + 2] = edge ? 45 : left ? 80 : 175
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, noisy ? { level: 0 } : undefined)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* 真实的手绘扫描/AI 底图不可能压到几 KB。用 BIG_MAP=1 跑一遍，
   看一张几 MB 的底图会不会把保存搞崩 —— 这直接决定底图能不能放在 novel.json 里。 */
const BIG = process.env.BIG_MAP === '1'
const MAP_W = BIG ? 1600 : 800
const MAP_H = BIG ? 1200 : 400
const fixtureDir = mkdtempSync(join(tmpdir(), 'ns-map-'))
const fixture = join(fixtureDir, 'basemap.png')
writeFileSync(fixture, makePng(MAP_W, MAP_H, BIG))
console.log(
  BIG
    ? `底图：${MAP_W}x${MAP_H} 不可压缩噪声，文件 ${(readFileSync(fixture).length / 1048576).toFixed(1)} MB`
    : `底图：${MAP_W}x${MAP_H} 色块，文件 ${(readFileSync(fixture).length / 1024).toFixed(0)} KB`,
)

const profile = mkdtempSync(join(tmpdir(), 'ns-map-profile-'))

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    URL,
  ],
  { stdio: 'ignore', detached: false },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let checks = 0
let failures = 0
function check(label, ok, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

async function waitForTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 端口还没开 */
    }
    await sleep(500)
  }
  throw new Error('等不到调试端口')
}

async function main() {
  const target = await waitForTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  const pageErrors = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(
        msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text,
      )
    }
    if (msg.method === 'Log.entryAdded' && m_entryIsError(msg)) pageErrors.push(msg.params.entry.text)
  }

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
      )
    }
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('DOM.enable')
  await send('Page.reload', { ignoreCache: true })

  for (let i = 0; i < 60; i++) {
    const st = await evaluate(`
      (() => ({
        sk: document.querySelectorAll('.skeleton').length,
        len: document.getElementById('root')?.innerHTML.length ?? -1,
      }))()
    `)
    if (st.sk === 0 && st.len > 0) break
    await sleep(500)
  }

  /* 建一本小说 */
  const typed = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="小说的名字"]')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '地图核对')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  if (typed) {
    await sleep(300)
    await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '创建')
        if (b) b.click()
        return true
      })()
    `)
    await sleep(1500)
  }

  /* 先建一个条目 —— 图钉必须挂在条目上，没有条目就打不了点 */
  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(700)
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /新建角色|新建词条$/.test(x.textContent.trim()))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(1000)

  /* 切到地图 */
  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('地图'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(800)

  console.log('\n[1] 第一屏是地图列表：没有地图时引导新建')

  const emptyState = await evaluate(`document.body.innerText.includes('还没有地图')`)
  check('显示「还没有地图」', emptyState, await evaluate(`document.body.innerText.slice(0,120)`))

  /* 列表这一层是后加的：一进去先看有哪些地图，点进去才是那张图 */
  const entrance = await evaluate(`
    (() => ({
      有新建入口: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('新建地图')),
      是列表不是画布: !document.querySelector('[data-stage="map"]'),
    }))()
  `)
  check('空的时候也先进列表，不是直接进画布', entrance.是列表不是画布 && entrance.有新建入口,
    JSON.stringify(entrance))

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('新建地图'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(800)

  console.log('\n[2] 空地图：还没传底图、也没打点，该给一句起步提示')

  const before = await evaluate(`
    (() => {
      const t = document.body.innerText
      return {
        起步提示: t.includes('还没有底图') || t.includes('还是空的'),
        有img: !!document.querySelector('img[alt]'),
      }
    })()
  `)
  check('空地图给出起步提示', before.起步提示)
  check('空地图没有底图', !before.有img)

  console.log('\n[3] 上传底图（800x400）')

  const doc = await send('DOM.getDocument', { depth: -1 })
  const q = await send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  })
  if (!q.nodeId) throw new Error('找不到底图上传用的 file input')
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [fixture] })
  await sleep(1500)

  const after = await evaluate(`
    (() => {
      const t = document.body.innerText
      const img = document.querySelector('img[alt]')
      const stage = document.querySelector('[data-stage="map"]')
      const plane = document.querySelector('[data-plane="1"]')
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } }
      return {
        空白提示还在: t.includes('还没有底图') || t.includes('还是空的'),
        有底图: !!img,
        底图自然尺寸: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
        平面尺寸: r(plane),
        画布尺寸: r(stage),
      }
    })()
  `)

  console.log('    实测：', JSON.stringify(after))
  check('底图真的渲染出来了', after.有底图 && after.底图自然尺寸 === `${MAP_W}x${MAP_H}`,
    String(after.底图自然尺寸))
  check('上传底图后不再显示「空白」提示', !after.空白提示还在,
    '底图已经在画布上了，却仍然压着一句空白提示')
  check('地图平面按底图自己的宽高比铺开（2:1）',
    after.平面尺寸 && Math.abs(after.平面尺寸.w / after.平面尺寸.h - MAP_W / MAP_H) < 0.01,
    JSON.stringify(after.平面尺寸))

  console.log('\n[4] 图钉坐标必须落在图片自己的坐标系里')

  /* 底图是 2:1，画布不是。object-contain 会把图片缩到画布内并留白，
     而图钉的 0~1 坐标如果是相对「画布」算的，那它相对「图片」的位置
     就会随着窗口比例变化而漂移。测法是：打一个点，记下它相对图片的
     比例，然后改变窗口尺寸，再看这个比例有没有变。
     比例稳定 = 图钉钉在图上；比例变了 = 图钉钉在了画布上。 */

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '打点')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(300)

  /* 在图片左上角区域点一下 —— 不能用画布中心：object-contain 是居中留白的，
     中心点在缩放前后都落在图片中心，量不出漂移。越靠近图片边缘越明显。 */
  const PAINTED_X = 0.25
  const PAINTED_Y = 0.12
  const clickAt = await evaluate(`
    (() => {
      const img = document.querySelector('img[alt]')
      if (!img) return null
      const r = img.getBoundingClientRect()
      const nw = img.naturalWidth, nh = img.naturalHeight
      const s = Math.min(r.width / nw, r.height / nh)
      const left = r.left + (r.width - nw * s) / 2
      const top = r.top + (r.height - nh * s) / 2
      return {
        x: Math.round(left + ${PAINTED_X} * nw * s),
        y: Math.round(top + ${PAINTED_Y} * nh * s),
      }
    })()
  `)
  check('量到图片在画布里的实际绘制位置', clickAt !== null)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickAt.x, y: clickAt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickAt.x, y: clickAt.y, button: 'left', clickCount: 1 })
  await sleep(700)

  const measure = `
    (() => {
      const img = document.querySelector('img[alt]')
      const pin = document.querySelector('[data-pin="0"] > span:first-child')
      const stage = document.querySelector('[data-stage="map"]')
      if (!img || !pin) return null
      const r = img.getBoundingClientRect()
      const nw = img.naturalWidth, nh = img.naturalHeight
      const s = Math.min(r.width / nw, r.height / nh)   // object-contain 的实际缩放
      const painted = {
        left: r.left + (r.width - nw * s) / 2,
        top: r.top + (r.height - nh * s) / 2,
        w: nw * s,
        h: nh * s,
      }
      const pr = pin.getBoundingClientRect()
      const cx = pr.left + pr.width / 2
      const cy = pr.top + pr.height / 2
      const sr = stage.getBoundingClientRect()
      return {
        x: +((cx - painted.left) / painted.w).toFixed(4),
        y: +((cy - painted.top) / painted.h).toFixed(4),
        底图框: { w: Math.round(painted.w), h: Math.round(painted.h) },
        画布框: { w: Math.round(sr.width), h: Math.round(sr.height) },
      }
    })()
  `

  const beforeResize = await evaluate(measure)
  check('打点成功（画布上出现了一个图钉）', beforeResize !== null, '点完之后找不到图钉')
  if (beforeResize) {
    check('点在哪里就钉在哪里',
      Math.abs(beforeResize.x - PAINTED_X) < 0.01 && Math.abs(beforeResize.y - PAINTED_Y) < 0.01,
      `点在图片的 (${PAINTED_X}, ${PAINTED_Y})，图钉落在 (${beforeResize.x}, ${beforeResize.y})`)
  }

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(900)
  const afterResize = await evaluate(measure)

  if (beforeResize && afterResize) {
    const dx = Math.abs(afterResize.x - beforeResize.x)
    const dy = Math.abs(afterResize.y - beforeResize.y)
    check('改变窗口尺寸后，图钉相对底图的位置不变', dx < 0.005 && dy < 0.005,
      `相对图片的坐标从 (${beforeResize.x}, ${beforeResize.y}) 漂到了 (${afterResize.x}, ${afterResize.y})`)
    console.log(
      `    底图框 ${beforeResize.底图框.w}x${beforeResize.底图框.h} / 画布框 ${beforeResize.画布框.w}x${beforeResize.画布框.h}` +
        ` → 底图框 ${afterResize.底图框.w}x${afterResize.底图框.h} / 画布框 ${afterResize.画布框.w}x${afterResize.画布框.h}`,
    )
    const letterboxed =
      Math.abs(beforeResize.底图框.w - beforeResize.画布框.w) > 2 &&
      Math.abs(beforeResize.底图框.h - beforeResize.画布框.h) > 2
    if (letterboxed) {
      console.log('    （底图和画布比例不一致：画布留了白，图钉就有漂移的空间）')
    }
  } else {
    check('改变窗口尺寸后仍能量到图钉', false, JSON.stringify({ beforeResize, afterResize }))
  }

  /* 区域也算内容：有区域时不该再说「还是空的」 */
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)

  /** 平面归一化坐标 → 屏幕坐标 */
  const planePoint = (nx, ny) =>
    evaluate(`
      (() => {
        const p = document.querySelector('[data-plane="1"]').getBoundingClientRect()
        return { x: Math.round(p.left + ${nx} * p.width), y: Math.round(p.top + ${ny} * p.height) }
      })()
    `)

  const clickPlane = async (nx, ny) => {
    const p = await planePoint(nx, ny)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(180)
    return p
  }

  const clickButton = async (text) => {
    const ok = await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().includes(${JSON.stringify(text)}))
        if (!b) return false
        b.click()
        return true
      })()
    `)
    await sleep(350)
    return ok
  }

  const typeInto = async (selector, value) => {
    const ok = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(350)
    return ok
  }

  /** 卡片的展开状态：收起时只露名字，点标题那一行才展开 */
  const cardState = (selector) =>
    evaluate(`
      (() => {
        const card = document.querySelector(${JSON.stringify(selector)})
        if (!card) return null
        return {
          open: card.dataset.open,
          有名称输入: !!card.querySelector('input'),
          有简介输入: !!card.querySelector('textarea'),
          色板数: card.querySelectorAll('.swatch').length,
          文字: card.innerText.replace(/\\s+/g, ' ').trim(),
        }
      })()
    `)

  const setCard = async (selector, open) => {
    const cur = await evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.dataset.open`,
    )
    if ((cur === 'true') !== open) {
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).querySelector('button').click()`,
      )
      await sleep(400)
    }
  }

  console.log('\n[5] 工具按键：选中态是朱砂下划线，不是方框')

  const tabs = await evaluate(`
    (() => {
      const els = Array.from(document.querySelectorAll('.tool-tab'))
      return els.map((el) => {
        const cs = getComputedStyle(el)
        const after = getComputedStyle(el, '::after')
        return {
          文字: el.textContent.trim(),
          选中: el.getAttribute('aria-pressed') === 'true',
          边框宽: cs.borderTopWidth,
          背景: cs.backgroundColor,
          文字色: cs.color,
          下划线色: after.backgroundColor,
          下划线高: after.height,
        }
      })
    })()
  `)
  check('三个工具按键都在', tabs.length === 3, JSON.stringify(tabs.map((t) => t.文字)))
  check('工具按键没有方框边框', tabs.every((t) => t.边框宽 === '0px'),
    JSON.stringify(tabs.map((t) => `${t.文字}:${t.边框宽}`)))
  check('工具按键没有填充背景',
    tabs.every((t) => t.背景 === 'rgba(0, 0, 0, 0)' || t.背景 === 'transparent'),
    JSON.stringify(tabs.map((t) => `${t.文字}:${t.背景}`)))
  check('选中的那个是朱砂字 + 朱砂下划线',
    tabs.filter((t) => t.选中).length === 1 &&
      tabs.filter((t) => t.选中).every((t) => t.下划线色 === 'rgb(156, 63, 48)' && t.下划线高 === '2px'),
    JSON.stringify(tabs))

  console.log('\n[6] 卡片平时收起，点一下才展开')

  const pinClosed = await cardState('[data-pin-card="0"]')
  check('图钉卡片默认是收起的', pinClosed?.open === 'false', JSON.stringify(pinClosed))
  check('收起时不渲染名称输入框', pinClosed?.有名称输入 === false)
  check('收起时不渲染色板', pinClosed?.色板数 === 0, String(pinClosed?.色板数))
  check('收起时只显示名字（不含任何控件文字）',
    !!pinClosed && pinClosed.文字.length > 0 && pinClosed.文字.length < 24, pinClosed?.文字)
  console.log('    收起时显示：', pinClosed?.文字)

  await setCard('[data-pin-card="0"]', true)
  const pinOpened = await cardState('[data-pin-card="0"]')
  check('点一下就展开了', pinOpened?.open === 'true', JSON.stringify(pinOpened))
  check('展开后有色板', (pinOpened?.色板数 ?? 0) >= 10, String(pinOpened?.色板数))

  await setCard('[data-pin-card="0"]', false)
  check('再点一下就收回去了', (await cardState('[data-pin-card="0"]'))?.open === 'false')

  console.log('\n[7] 图钉可以自己命名、自己挑颜色')

  await setCard('[data-pin-card="0"]', true)
  const pinRenamed = await typeInto('[data-pin-card="0"] input', '前线指挥部')
  check('图钉名称输入框可写', pinRenamed)

  const pinColorPicked = await evaluate(`
    (() => {
      const card = document.querySelector('[data-pin-card="0"]')
      const sw = Array.from(card.querySelectorAll('.swatch')).find(s => s.title === '紫檀')
      if (!sw) return null
      sw.click()
      return true
    })()
  `)
  await sleep(500)
  check('图钉色板里能挑到「紫檀」', pinColorPicked)

  const pinLook = await evaluate(`
    (() => {
      const dot = document.querySelector('[data-pin="0"] > span:first-child')
      const card = document.querySelector('[data-pin-card="0"]')
      const picked = Array.from(card.querySelectorAll('.swatch')).find(s => s.getAttribute('aria-pressed') === 'true')
      return {
        圆点背景: dot ? getComputedStyle(dot).backgroundColor : null,
        选中的色: picked ? picked.title : null,
        卡片文字: card.innerText.replace(/\\s+/g, ' '),
      }
    })()
  `)
  check('图钉圆点用上了挑的颜色（紫檀 #6b4f7a）',
    pinLook.圆点背景 === 'rgb(107, 79, 122)', String(pinLook.圆点背景))
  check('图钉卡片上没有势力和顶点这类字眼',
    !pinLook.卡片文字.includes('势力') && !pinLook.卡片文字.includes('顶点'), pinLook.卡片文字)

  /* 收起后名字要换成自己起的那个 */
  await setCard('[data-pin-card="0"]', false)
  const pinClosedName = (await cardState('[data-pin-card="0"]'))?.文字
  check('收起后显示的是自己起的名字', pinClosedName === '前线指挥部', String(pinClosedName))
  await setCard('[data-pin-card="0"]', true)

  console.log('\n[8] 区域可以命名、挑颜色、写简介')

  check('切到「圈区域」', await clickButton('圈区域'))
  await clickPlane(0.08, 0.55)
  await clickPlane(0.42, 0.55)
  await clickPlane(0.42, 0.88)
  await clickPlane(0.08, 0.88)
  check('封口成区域', await clickButton('封口成区域'))

  const regionClosed = await cardState('[data-region]')
  check('区域卡片默认也是收起的', regionClosed?.open === 'false', JSON.stringify(regionClosed))
  check('收起时不渲染色板与简介框',
    regionClosed?.色板数 === 0 && regionClosed?.有简介输入 === false, JSON.stringify(regionClosed))

  await setCard('[data-region]', true)
  const regionCard = await cardState('[data-region]')
  check('区域卡片出现了', regionCard !== null)
  check('有名称输入框', regionCard?.有名称输入 === true)
  check('有简介输入框（取消了下拉选择）', regionCard?.有简介输入 === true)
  check('颜色更多了（至少 10 个）', (regionCard?.色板数 ?? 0) >= 10, String(regionCard?.色板数))
  check('「未指定势力」没了', !regionCard?.文字.includes('势力'), regionCard?.文字)
  check('「N 个顶点」没了', !regionCard?.文字.includes('顶点'), regionCard?.文字)

  check('区域名可写', await typeInto('[data-region] input', '北境行省'))
  const regionColorPicked = await evaluate(`
    (() => {
      const card = document.querySelector('[data-region]')
      const sw = Array.from(card.querySelectorAll('.swatch')).find(s => s.title === '苍绿')
      if (!sw) return false
      sw.click()
      return true
    })()
  `)
  await sleep(500)
  check('区域色板里能挑到「苍绿」', regionColorPicked)
  check('区域简介可写',
    await typeInto('[data-region] textarea', '冬天封路，只有一条冰道能进。'))

  const regionLook = await evaluate(`
    (() => {
      const poly = document.querySelector('[data-plane="1"] svg polygon')
      const cs = poly ? getComputedStyle(poly) : null
      return poly ? {
        填充: cs.fill,
        填充透明度: +cs.fillOpacity,
        描边: cs.stroke,
        描边透明度: +cs.strokeOpacity,
      } : null
    })()
  `)
  check('地图上的区域用上了挑的颜色（苍绿 #4a6b52）',
    regionLook?.填充 === 'rgb(74, 107, 82)', JSON.stringify(regionLook))
  check('区域颜色在地图上是「深」的（填充 ≥ 0.15、描边 ≥ 0.8）',
    (regionLook?.填充透明度 ?? 0) >= 0.15 && (regionLook?.描边透明度 ?? 0) >= 0.8,
    JSON.stringify(regionLook))

  await setCard('[data-region]', false)
  const regionClosedName = (await cardState('[data-region]'))?.文字
  check('收起后只显示区域名', regionClosedName === '北境行省', String(regionClosedName))
  await setCard('[data-region]', true)

  console.log('\n[9] 方格要染上它在地图上显现的那个颜色')

  const tints = await evaluate(`
    (() => {
      const toRgb = (css) => {
        const d = document.createElement('div')
        d.style.color = css
        document.body.appendChild(d)
        const c = getComputedStyle(d).color
        d.remove()
        return c
      }
      const look = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const s = getComputedStyle(el)
        return { 色: el.dataset.tint, 底: s.backgroundColor, 边: s.borderTopColor }
      }
      const poly = document.querySelector('[data-plane="1"] svg polygon')
      const pinDot = document.querySelector('[data-pin="0"] > span:first-child')
      return {
        图钉方格: look('[data-pin-card="0"]'),
        区域方格: look('[data-region]'),
        地图上的区域色: poly ? getComputedStyle(poly).fill : null,
        地图上的图钉色: pinDot ? getComputedStyle(pinDot).backgroundColor : null,
        区域色的RGB: toRgb('#4a6b52'),
        图钉色的RGB: toRgb('#6b4f7a'),
        纸色: getComputedStyle(document.body).backgroundColor,
      }
    })()
  `)
  console.log('    方格染色：', JSON.stringify(tints))

  check('区域方格染的是地图上那个色（同一个苍绿）',
    tints.区域方格?.色 === '#4a6b52' && tints.区域色的RGB === tints.地图上的区域色,
    `方格 ${tints.区域方格?.色} → ${tints.区域色的RGB}，地图上是 ${tints.地图上的区域色}`)
  check('图钉方格染的是地图上那个色（同一个紫檀）',
    tints.图钉方格?.色 === '#6b4f7a' && tints.图钉色的RGB === tints.地图上的图钉色,
    `方格 ${tints.图钉方格?.色} → ${tints.图钉色的RGB}，地图上是 ${tints.地图上的图钉色}`)
  check('方格底色确实被染了（不是纸色）',
    tints.区域方格?.底 !== tints.纸色 && tints.图钉方格?.底 !== tints.纸色,
    `纸色 ${tints.纸色}，区域底 ${tints.区域方格?.底}，图钉底 ${tints.图钉方格?.底}`)
  check('两个不同颜色的方格长得不一样',
    tints.区域方格?.底 !== tints.图钉方格?.底 &&
      tints.区域方格?.边 !== tints.图钉方格?.边,
    JSON.stringify([tints.区域方格, tints.图钉方格]))

  /* 没挑颜色的区域：方格应该是中性的，不能凭空染成某个色 */
  check('再圈一块地', await clickButton('圈区域') && true)
  await clickPlane(0.55, 0.2)
  await clickPlane(0.9, 0.2)
  await clickPlane(0.9, 0.5)
  await clickPlane(0.55, 0.5)
  check('封口成第二块区域', await clickButton('封口成区域'))

  const defaultTint = await evaluate(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-region]'))
      if (cards.length < 2) return null
      const plain = cards.find(c => c.dataset.tint && c.dataset.tint.startsWith('var('))
      const colored = cards.find(c => c.dataset.tint === '#4a6b52')
      return {
        区域数: cards.length,
        没挑色的那个: plain ? { 色: plain.dataset.tint, 底: getComputedStyle(plain).backgroundColor } : null,
        挑了色的那个: colored ? { 色: colored.dataset.tint, 底: getComputedStyle(colored).backgroundColor } : null,
      }
    })()
  `)
  console.log('    第二块区域（没挑色）：', JSON.stringify(defaultTint))
  check('第二块区域出现了', defaultTint?.区域数 === 2, String(defaultTint?.区域数))
  check('没挑颜色的方格是中性墨色，没有乱染',
    !!defaultTint?.没挑色的那个 && defaultTint.没挑色的那个.色.includes('ink'),
    JSON.stringify(defaultTint?.没挑色的那个))
  check('挑了色的方格和没挑色的方格颜色不同',
    defaultTint?.挑了色的那个?.底 !== defaultTint?.没挑色的那个?.底,
    JSON.stringify([defaultTint?.挑了色的那个, defaultTint?.没挑色的那个]))

  console.log('\n[10] 「上色」开关：默认开，关掉就全部回到墨色')
  const toggleState = await evaluate(`
    (() => {
      const sw = document.querySelector('[role="switch"]')
      return sw ? { 默认开: sw.getAttribute('aria-checked') === 'true', 文字: sw.textContent.trim() } : null
    })()
  `)
  check('开关默认是开的', toggleState?.默认开 === true, JSON.stringify(toggleState))

  const toggled = await evaluate(`
    (() => {
      const sw = document.querySelector('[role="switch"]')
      if (!sw) return false
      sw.click()
      return true
    })()
  `)
  await sleep(500)
  const offLook = await evaluate(`
    (() => {
      const poly = document.querySelector('[data-plane="1"] svg polygon')
      const sw = document.querySelector('[role="switch"]')
      return {
        填充: poly ? getComputedStyle(poly).fill : null,
        开关: sw ? sw.getAttribute('aria-checked') : null,
      }
    })()
  `)
  check('关掉开关后区域改用墨色', toggled && offLook.填充 !== 'rgb(74, 107, 82)',
    `${JSON.stringify(offLook)}（原来苍绿是 rgb(74, 107, 82)）`)
  check('开关状态确实翻到了关', offLook.开关 === 'false', String(offLook.开关))

  /* 再打开，后面检查持久化时保留「开」 */
  await evaluate(`document.querySelector('[role="switch"]').click()`)
  await sleep(400)

  console.log('\n[11] 平移模式下按住图钉 = 挪这枚图钉，不是挪画布')

  check('切回「平移」', await clickButton('平移'))

  const beforeDrag = await evaluate(`
    (() => {
      const dot = document.querySelector('[data-pin="0"] > span:first-child')
      const plane = document.querySelector('[data-plane="1"]')
      const d = dot.getBoundingClientRect()
      const p = plane.getBoundingClientRect()
      return {
        图钉相对平面: {
          x: +(((d.left + d.width / 2) - p.left) / p.width).toFixed(4),
          y: +(((d.top + d.height / 2) - p.top) / p.height).toFixed(4),
        },
        平面左上: { x: Math.round(p.left), y: Math.round(p.top) },
        点: { x: Math.round(d.left + d.width / 2), y: Math.round(d.top + d.height / 2) },
      }
    })()
  `)

  /* 按住图钉，拖到右下方 120px 处 */
  const dx = 120
  const dy = 60
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beforeDrag.点.x, y: beforeDrag.点.y, button: 'left', clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeDrag.点.x + dx / 2, y: beforeDrag.点.y + dy / 2, button: 'left' })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeDrag.点.x + dx, y: beforeDrag.点.y + dy, button: 'left' })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeDrag.点.x + dx, y: beforeDrag.点.y + dy, button: 'left', clickCount: 1 })
  await sleep(700)

  const afterDrag = await evaluate(`
    (() => {
      const dot = document.querySelector('[data-pin="0"] > span:first-child')
      const plane = document.querySelector('[data-plane="1"]')
      const d = dot.getBoundingClientRect()
      const p = plane.getBoundingClientRect()
      return {
        图钉相对平面: {
          x: +(((d.left + d.width / 2) - p.left) / p.width).toFixed(4),
          y: +(((d.top + d.height / 2) - p.top) / p.height).toFixed(4),
        },
        平面左上: { x: Math.round(p.left), y: Math.round(p.top) },
      }
    })()
  `)

  const movedX = afterDrag.图钉相对平面.x - beforeDrag.图钉相对平面.x
  const movedY = afterDrag.图钉相对平面.y - beforeDrag.图钉相对平面.y
  check('按住图钉能把它拖走', Math.abs(movedX) > 0.05 && Math.abs(movedY) > 0.05,
    `拖了 ${dx}x${dy} 像素，图钉只动了 (${movedX.toFixed(4)}, ${movedY.toFixed(4)})`)
  check('拖图钉时画布没有跟着平移',
    afterDrag.平面左上.x === beforeDrag.平面左上.x && afterDrag.平面左上.y === beforeDrag.平面左上.y,
    `平面左上角从 ${JSON.stringify(beforeDrag.平面左上)} 变成 ${JSON.stringify(afterDrag.平面左上)}`)

  console.log('\n[12] 上面这些东西必须能存下来（刷新一次还在）')

  const savedBefore = await evaluate(`
    (() => {
      try {
        const keys = Object.keys(localStorage)
        const total = keys.reduce((n, k) => n + (localStorage.getItem(k)?.length ?? 0), 0)
        return { 键数: keys.length, 总字节: total }
      } catch (e) { return { 错误: String(e) } }
    })()
  `)
  console.log('    刷新前 localStorage：', JSON.stringify(savedBefore))

  await send('Page.reload', { ignoreCache: true })
  await sleep(2500)
  /* 回到地图视图。现在第一屏是列表，得再点进去 —— 顺便验证这条路走得通 */
  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('地图'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(1200)
  const listAfterReload = await evaluate(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-map]'))
      return {
        张数: cards.length,
        卡片: cards.map((c) => c.innerText.replace(/\\s+/g, ' ').trim()),
        还没进画布: !document.querySelector('[data-stage="map"]'),
      }
    })()
  `)
  console.log('    刷新后的地图列表：', JSON.stringify(listAfterReload))
  check('刷新后先看到地图列表', listAfterReload.还没进画布 === true, JSON.stringify(listAfterReload))
  check('列表里那张地图还在', listAfterReload.张数 === 1, String(listAfterReload.张数))
  check('列表上写着图钉数和区域数',
    /1 个图钉/.test(listAfterReload.卡片[0] ?? '') && /[1-9]\d* 个区域/.test(listAfterReload.卡片[0] ?? ''),
    String(listAfterReload.卡片[0]))
  await evaluate(`
    (() => {
      const b = document.querySelector('[data-map] button')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(1200)

  /* 刷新后卡片是收起的，先读收起态能看到什么，再展开读细节 */
  const afterReloadClosed = await evaluate(`
    (() => {
      const img = document.querySelector('img[alt]')
      const pin = document.querySelector('[data-pin="0"] > span:first-child')
      const pinCard = document.querySelector('[data-pin-card="0"]')
      const regionCard = document.querySelector('[data-region]')
      const t = document.body.innerText
      const name = (card) => card ? card.innerText.replace(/\\s+/g, ' ').trim() : null
      return {
        底图还在: !!img && img.naturalWidth > 0,
        图钉还在: !!pin,
        图钉圆点背景: pin ? getComputedStyle(pin).backgroundColor : null,
        图钉卡片收起: pinCard?.dataset.open === 'false',
        图钉卡片显示的名字: name(pinCard),
        区域还在: !!regionCard,
        区域卡片收起: regionCard?.dataset.open === 'false',
        区域卡片显示的名字: name(regionCard),
        上色开关: document.querySelector('[role="switch"]')?.getAttribute('aria-checked') ?? null,
        提示文字: t.includes('还没有地图') ? '回到作品库' : (t.includes('还没有底图') ? '说没有底图' : '正常'),
      }
    })()
  `)
  console.log('    刷新后（收起态）：', JSON.stringify(afterReloadClosed))
  check('刷新后底图还在', afterReloadClosed.底图还在, '底图没存下来')
  check('刷新后图钉还在', afterReloadClosed.图钉还在, '图钉没存下来')
  check('刷新后区域还在', afterReloadClosed.区域还在, '区域没存下来')
  check('刷新后卡片依然是收起的（只露名字）',
    afterReloadClosed.图钉卡片收起 && afterReloadClosed.区域卡片收起,
    JSON.stringify([afterReloadClosed.图钉卡片收起, afterReloadClosed.区域卡片收起]))
  check('刷新后收起态直接能看到图钉的名字',
    afterReloadClosed.图钉卡片显示的名字 === '前线指挥部', String(afterReloadClosed.图钉卡片显示的名字))
  check('刷新后收起态直接能看到区域的名字',
    afterReloadClosed.区域卡片显示的名字 === '北境行省', String(afterReloadClosed.区域卡片显示的名字))
  check('刷新后图钉的颜色还在（紫檀）',
    afterReloadClosed.图钉圆点背景 === 'rgb(107, 79, 122)', String(afterReloadClosed.图钉圆点背景))
  check('刷新后「上色」开关还是开的', afterReloadClosed.上色开关 === 'true', String(afterReloadClosed.上色开关))

  await setCard('[data-pin-card="0"]', true)
  await setCard('[data-region]', true)
  const afterReloadOpen = await evaluate(`
    (() => {
      const pinCard = document.querySelector('[data-pin-card="0"]')
      const regionCard = document.querySelector('[data-region]')
      const pickedColor = (card) => {
        if (!card) return null
        const s = Array.from(card.querySelectorAll('.swatch')).find(x => x.getAttribute('aria-pressed') === 'true')
        return s ? s.title : null
      }
      return {
        图钉名字: pinCard.querySelector('input').value,
        图钉颜色: pickedColor(pinCard),
        区域名: regionCard.querySelector('input').value,
        区域简介: regionCard.querySelector('textarea').value,
        区域颜色: pickedColor(regionCard),
      }
    })()
  `)
  console.log('    刷新后（展开态）：', JSON.stringify(afterReloadOpen))
  check('展开后图钉的名字还在', afterReloadOpen.图钉名字 === '前线指挥部', String(afterReloadOpen.图钉名字))
  check('展开后图钉的颜色还在', afterReloadOpen.图钉颜色 === '紫檀', String(afterReloadOpen.图钉颜色))
  check('展开后区域的名字还在', afterReloadOpen.区域名 === '北境行省', String(afterReloadOpen.区域名))
  check('展开后区域的简介还在', afterReloadOpen.区域简介 === '冬天封路，只有一条冰道能进。', String(afterReloadOpen.区域简介))
  check('展开后区域的颜色还在', afterReloadOpen.区域颜色 === '苍绿', String(afterReloadOpen.区域颜色))

  console.log('\n[13] 发生地点：能选地图上的区域，也能自己写')

  /* 这一栏原来是原生 select，候选只来自「地点条目」。
     作者画完区域发现下拉里只有「未指定」一项 —— 看着就像点不动。 */

  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(800)

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /新建角色|新建词条$/.test(x.textContent.trim()))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(900)

  /* 事件才有「发生地点」 */
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '事件')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(700)

  const placeButtonText = () =>
    evaluate(`
      (() => {
        const b = document.querySelector('[title="选一个已有的地点，或者自己写一个"]')
        return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null
      })()
    `)

  const idle = await placeButtonText()
  check('未填时写着「未指定」，并且提示可以点', idle?.includes('未指定') === true, String(idle))

  const opened = await evaluate(`
    (() => {
      const b = document.querySelector('[title="选一个已有的地点，或者自己写一个"]')
      if (!b) return false
      b.click()
      return true
    })()
  `)
  await sleep(500)
  check('点一下能展开（不再是一点没反应）', opened)

  const panel = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="搜地名；没有就自己写一个"]')
      if (!inp) return null
      const list = inp.parentElement?.nextElementSibling
      if (!list) return null
      return {
        分组: Array.from(list.querySelectorAll('.t-micro')).map((e) => e.textContent.trim()),
        候选: Array.from(list.querySelectorAll('button')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
      }
    })()
  `)
  console.log('    发生地点的候选：', JSON.stringify(panel))
  check('展开后列出「地图区域」这一组', panel?.分组.includes('地图区域') === true,
    JSON.stringify(panel?.分组))
  check('地图上画的区域出现在候选里',
    panel?.候选.some((t) => t.includes('北境行省')) === true, JSON.stringify(panel?.候选))

  const picked = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.replace(/\\s+/g, ' ').trim().startsWith('北境行省'))
      if (!b) return false
      b.click()
      return true
    })()
  `)
  await sleep(600)
  check('能选中那个区域', picked)
  const afterPick = await placeButtonText()
  check('选完显示区域名，并标明它是地图区域',
    afterPick?.includes('北境行省') === true && afterPick?.includes('地图区域') === true,
    String(afterPick))

  /* 再进一次，自己写一个地名 */
  await evaluate(`
    (() => {
      const b = document.querySelector('[title="选一个已有的地点，或者自己写一个"]')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(400)
  const typedCustom = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="搜地名；没有就自己写一个"]')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '城南渡口')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(500)
  check('能往输入框里打字', typedCustom)

  const customRow = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('当作地名'))
      return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null
    })()
  `)
  check('打了没见过的名字时，给出「当作地名」这一行',
    customRow?.includes('城南渡口') === true, String(customRow))

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('当作地名'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(600)
  const afterCustom = await placeButtonText()
  check('自定义地名被接受，并标成「自定义」',
    afterCustom?.includes('城南渡口') === true && afterCustom?.includes('自定义') === true,
    String(afterCustom))

  /* 自定义地名要能真的存下来 —— 它是以一行文字写进 .md 的 */
  await sleep(900)
  await send('Page.reload', { ignoreCache: true })
  await sleep(2500)
  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(1200)
  /* 刷新后要把那个条目再点开 —— 卡片必须用真的鼠标事件才打得开
     （合成 click 会绕开指针事件的真实路径，这个坑踩过一次） */
  const cardPts = await evaluate(`
    Array.from(document.querySelectorAll('[data-slot][data-kind="entity"]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
  `)
  let persisted = null
  for (const p of cardPts) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(700)
    persisted = await placeButtonText()
    if (persisted) break
    await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '返回索引')
        if (b) b.click()
        return true
      })()
    `)
    await sleep(500)
  }
  check('刷新之后自定义地点还在（存进文件了）',
    persisted?.includes('城南渡口') === true, `${cardPts.length} 个条目 / 「${persisted}」`)

  const savedInFile = await evaluate(`
    (() => {
      for (const k of Object.keys(localStorage)) {
        if ((localStorage.getItem(k) ?? '').includes('城南渡口')) return k
      }
      return null
    })()
  `)
  check('自定义地名是以一行文字写进条目文件的', savedInFile !== null, String(savedInFile))

  console.log('\n[14] 多张地图：从列表建第二张、改名、各钉各的')

  /* 这条是这一轮的核心：以前「新建地图」只出现在一张都没有的时候，
     建了第一张就再也没地方加第二张了。 */
  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('地图'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(1000)
  const backOnList = await evaluate(`(() => {
    const b = document.querySelector('button[title="回到地图列表"]')
    if (b) b.click()
    return !document.querySelector('[data-stage="map"]')
  })()`)
  if (!backOnList) {
    // 已经不在画布里就直接用当前的列表
  }
  await sleep(700)

  const clickNewMap = async () => {
    const ok = await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('新建地图'))
        if (b) b.click()
        return !!b
      })()
    `)
    await sleep(1000)
    return ok
  }
  check('有地图之后还能再建一张', await clickNewMap())
  const enteredSecond = await evaluate(`!!document.querySelector('[data-stage="map"]')`)
  check('新建之后直接进这张新图', enteredSecond)

  const secondName = await evaluate(`
    (() => {
      const el = document.querySelector('input[placeholder="给这张地图起个名字"]')
      return el ? el.value : null
    })()
  `)
  check('新图有个默认名字', typeof secondName === 'string' && secondName.length > 0, String(secondName))

  const renamed = await evaluate(`
    (() => {
      const el = document.querySelector('input[placeholder="给这张地图起个名字"]')
      if (!el) return false
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      s.call(el, '云京城内')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(500)
  check('地图名字就地能改', renamed)

  const secondEmpty = await evaluate(`
    (() => ({
      图钉: document.querySelectorAll('[data-pin]').length,
      还没底图: !document.querySelector('img[alt]'),
    }))()
  `)
  check('新图是干净的，不带上一张的图钉', secondEmpty.图钉 === 0, JSON.stringify(secondEmpty))

  /* 退回列表：两张都在，名字和图钉数各是各的 */
  await evaluate(`
    (() => {
      const b = document.querySelector('button[title="回到地图列表"]')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(900)
  const twoMaps = await evaluate(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-map]'))
      return {
        张数: cards.length,
        卡片: cards.map((c) => c.innerText.replace(/\\s+/g, ' ').trim()),
      }
    })()
  `)
  console.log('    两张地图：', JSON.stringify(twoMaps))
  check('列表里现在有两张地图', twoMaps.张数 === 2, String(twoMaps.张数))
  check('改过的名字出现在列表里',
    twoMaps.卡片.some((t) => t.includes('云京城内')), JSON.stringify(twoMaps.卡片))
  check('两张图的图钉数分别记着（第一张 1 个，第二张 0 个）',
    twoMaps.卡片.some((t) => /1 个图钉/.test(t)) && twoMaps.卡片.some((t) => /0 个图钉/.test(t)),
    JSON.stringify(twoMaps.卡片))

  console.log('\n[15] 页面无报错')
  check('控制台无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400))

  console.log('')
  console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
  ws.close()
  edge.kill()
  process.exit(failures === 0 ? 0 : 1)
}

function m_entryIsError(msg) {
  return msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error'
}

main().catch((e) => {
  console.error('失败：', e.message)
  try {
    edge.kill()
  } catch {
    /* 已经退出 */
  }
  process.exit(1)
})
