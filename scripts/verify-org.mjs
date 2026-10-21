/* ============================================================
   设定页的词条夹与拖动 —— 浏览器实测

   为什么必须在真浏览器里跑：
   「按住卡片拖到别处」这件事跨了 pointerdown → 阈值判定 → 位置快照
   → 预览重排 → 落点计算 → store 写入 → 落盘 七步。任何一步断了，
   症状都是「拖了没反应」，读代码根本分不出来是哪一步。
   所以这里全部用真实鼠标事件驱动，再回读 DOM 顺序和 localStorage。

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/verify-org.mjs
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9346
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'

const profile = mkdtempSync(join(tmpdir(), 'ns-org-'))

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
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      pageErrors.push(msg.params.entry.text)
    }
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

  /* ---------------- 小工具 ---------------- */

  const clickText = async (text, exact = true) => {
    const ok = await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => {
          const t = x.textContent.trim()
          return ${exact ? `t === ${JSON.stringify(text)}` : `t.includes(${JSON.stringify(text)})`}
        })
        if (!b) return false
        b.click()
        return true
      })()
    `)
    await sleep(500)
    return ok
  }

  /** 卡片在 DOM 里的顺序（就是显示顺序） */
  const order = () =>
    evaluate(`Array.from(document.querySelectorAll('[data-slot]')).map(e => e.dataset.id)`)

  const centerOf = (selector) =>
    evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()
    `)

  const nthSlotCenter = (n) =>
    evaluate(`
      (() => {
        const el = document.querySelectorAll('[data-slot]')[${n}]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()
    `)

  /**
   * 卡片内的一个点。
   * fx/fy 是卡片宽高的比例 —— 不要用「正中」，那正好是前后判定的分界线，
   * 四舍五入差半像素就会落到另一边。
   */
  const nthSlotPoint = (n, fx, fy) =>
    evaluate(`
      (() => {
        const el = document.querySelectorAll('[data-slot]')[${n}]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.left + r.width * ${fx}),
          y: Math.round(r.top + r.height * ${fy}),
        }
      })()
    `)

  /** 一次真实的拖动：按下 → 越过阈值 → 移到目标 → 松手 */
  const dragTo = async (from, to, mid) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    await sleep(60)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1,
    })
    await sleep(80)
    // 先越过 5px 阈值，拖动才算真的开始
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x + 10, y: from.y + 10, button: 'left',
    })
    await sleep(120)
    if (mid) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y, button: 'left' })
      await sleep(120)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left' })
    await sleep(150)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1,
    })
    await sleep(600)
  }

  /** 现在有没有选中文字 —— 拖动变成拖蓝是这套交互最容易犯的错 */
  const selection = () =>
    evaluate(`
      (() => {
        const s = window.getSelection()
        return { 文字: s ? s.toString() : null, 段数: s ? s.rangeCount : 0 }
      })()
    `)

  /** 拖动中的落点状态：红线有没有、有没有指到夹子 */
  const dropState = () =>
    evaluate(`
      (() => {
        const b = document.querySelector('[data-dragging]')
        const line = document.querySelector('[data-drop-line]')
        const into = b?.dataset.dropFolder ?? ''
        const intoEl = into ? document.querySelector('[data-kind="folder"][data-id="' + into + '"]') : null
        return {
          拖动中: b?.dataset.dragging === 'true',
          红线: line ? (line.dataset.dropLine === 'h' ? '横' : '竖') : null,
          序号: b?.dataset.dropIndex ?? '',
          落点夹子: into || null,
          夹子框变色: intoEl ? getComputedStyle(intoEl).backgroundColor : null,
          板子上的小徽标字样: (() => {
            const b = document.querySelector('[data-dragging]')
            return b ? (b.innerText.match(/放进|移入/g) ?? []).length : -1
          })(),
        }
      })()
    `)

  /* ---------------- 建一本小说 + 三个条目 ---------------- */

  const typed = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="小说的名字"]')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '组织核对')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  if (typed) {
    await sleep(300)
    await clickText('创建')
    await sleep(1500)
  }

  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(800)

  for (let i = 0; i < 3; i++) {
    await clickText('新建词条')
    await sleep(700)
    await clickText('返回索引', false)
    await sleep(600)
  }

  console.log('\n[1] 三个条目，默认顺序')

  const before = await order()
  check('列出了三个条目', before.length === 3, JSON.stringify(before))
  check('有「新建词条夹」按钮', await evaluate(`
    Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('新建词条夹'))
  `))

  /* 用**真实鼠标**点一下卡片，确认能打开。
     这条必须用真鼠标：早先的实现里 pointerdown 就抢了指针捕获，
     浏览器把 click 派发给了板子，卡片的 onClick 永远收不到 ——
     而测试里用的是 el.click()（程序化点击不经过捕获），所以一直没发现。 */
  const clickCard = async (n) => {
    const c = await nthSlotCenter(n)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
    await sleep(60)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1,
    })
    await sleep(50)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1,
    })
    await sleep(700)
  }

  await clickCard(0)
  const opened = await evaluate(`
    (() => ({
      进了编辑器: !!document.querySelector('input[placeholder="名称"]'),
      有返回索引: Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('返回索引')),
    }))()
  `)
  check('真鼠标点一下条目卡片能打开它', opened.进了编辑器, JSON.stringify(opened))
  check('打开后能返回索引', await clickText('返回索引', false))

  console.log('\n[2] 卡片网格里拖动换位')

  /* 把第 3 张拖到第 1 张的左半边 = 插到它前面 */
  const first = await nthSlotPoint(0, 0.25, 0.5)
  const third = await nthSlotCenter(2)

  /* 拖动全程不许选中文字（否则就成了「拖蓝」而不是拖卡片）。
     按下之后、移动中途、松手之后各看一次。 */
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: third.x, y: third.y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: third.x, y: third.y, button: 'left', clickCount: 1,
  })
  await sleep(80)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: third.x + 10, y: third.y + 10, button: 'left',
  })
  await sleep(150)
  const midDrag = await selection()
  check('拖动过程中没有选中文字', (midDrag.文字 ?? '').length === 0, JSON.stringify(midDrag))

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y, button: 'left' })
  await sleep(150)
  const toDrag = await selection()
  check('拖到目标点也没选中文字', (toDrag.文字 ?? '').length === 0, JSON.stringify(toDrag))

  const lineState = await dropState()
  console.log('    拖动中的落点：', JSON.stringify(lineState))
  check('换位时画的是一条红线', lineState.红线 === '竖', JSON.stringify(lineState))
  check('换位时没有指到任何夹子', lineState.落点夹子 === null, String(lineState.落点夹子))

  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: first.x, y: first.y, button: 'left', clickCount: 1,
  })
  await sleep(600)
  const afterDragSel = await selection()
  check('松手后页面上没有残留选中', (afterDragSel.文字 ?? '').length === 0, JSON.stringify(afterDragSel))

  const afterGrid = await order()
  console.log(`    拖动前 ${before.join(',')}`)
  console.log(`    拖动后 ${afterGrid.join(',')}`)
  check('顺序变了', afterGrid.join(',') !== before.join(','), afterGrid.join(','))
  check('被拖的那张跑到了第一位', afterGrid[0] === before[2], afterGrid.join(','))
  check('另外两张的相对顺序没乱',
    afterGrid.slice(1).join(',') === [before[0], before[1]].join(','), afterGrid.join(','))

  console.log('\n[3] 紧凑表格里也要能拖')

  await evaluate(`
    (() => {
      const b = document.querySelector('button[title="切换为紧凑列表"]')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(600)
  const isTable = await evaluate(`!!document.querySelector('table [data-slot]')`)
  check('现在是表格排版', isTable)

  const beforeTable = await order()
  /* 表格是一列矮行：落在第 1 行的上半 = 插到它前面 */
  const r0 = await nthSlotPoint(0, 0.5, 0.15)
  const r2 = await nthSlotCenter(2)
  await dragTo(r2, r0)
  const afterTable = await order()
  console.log(`    拖动前 ${beforeTable.join(',')}`)
  console.log(`    拖动后 ${afterTable.join(',')}`)
  check('表格里也能换位', afterTable[0] === beforeTable[2], afterTable.join(','))

  /* 回到卡片排版 */
  await evaluate(`
    (() => {
      const b = document.querySelector('button[title="切换为卡片视图"]')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(500)

  console.log('\n[4] 新建词条夹，并编辑它的名字与简介')

  check('点「新建词条夹」', await clickText('新建词条夹'))
  await sleep(700)

  const folderHead = await evaluate(`
    (() => {
      const h = document.querySelector('[data-folder-head]')
      if (!h) return null
      return {
        有名字框: !!h.querySelector('input'),
        有简介框: !!h.querySelector('textarea'),
        名字: h.querySelector('input')?.value ?? null,
      }
    })()
  `)
  check('进到夹子页面，出现了名字/简介编辑块', folderHead !== null, JSON.stringify(folderHead))
  check('名字框和简介框都在', folderHead?.有名字框 === true && folderHead?.有简介框 === true)
  check('夹子里现在还没有条目', (await order()).length === 0, JSON.stringify(await order()))

  const setField = async (selector, value, tag = 'input') => {
    const ok = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const proto = ${tag === 'textarea'
          ? 'window.HTMLTextAreaElement'
          : 'window.HTMLInputElement'}
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(400)
    return ok
  }
  check('能改夹子名字', await setField('[data-folder-head] input', '北境人物'))
  check('能写夹子简介',
    await setField('[data-folder-head] textarea', '所有和北境有关的人。', 'textarea'))

  console.log('\n[5] 面包屑：回到全部')

  check('面包屑里有「全部」', await clickText('全部'))
  await sleep(600)

  const withFolder = await order()
  check('顶层现在有一个夹子 + 三个条目', withFolder.length === 4, JSON.stringify(withFolder))

  const folderId = await evaluate(`
    document.querySelector('[data-kind="folder"]')?.dataset.id ?? null
  `)
  check('找得到夹子卡片', folderId !== null, String(folderId))

  console.log('\n[6] 把条目拖进夹子：整个夹子框都是落点')

  const lastEntity = await evaluate(`
    (() => {
      const els = Array.from(document.querySelectorAll('[data-slot][data-kind="entity"]'))
      const el = els[els.length - 1]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { id: el.dataset.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()
  `)
  check('找得到最后一个条目', lastEntity !== null, JSON.stringify(lastEntity))

  /* 按下 → 越过阈值 → 移到夹子框正中 → 看它变不变色 → 松手 */
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastEntity.x, y: lastEntity.y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: lastEntity.x, y: lastEntity.y, button: 'left', clickCount: 1,
  })
  await sleep(80)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: lastEntity.x + 10, y: lastEntity.y + 10, button: 'left',
  })
  await sleep(300)

  const draggingState = await dropState()
  check('卡片里不该出现「放进 / 移入」这种小徽标',
    draggingState.板子上的小徽标字样 === 0,
    String(draggingState.板子上的小徽标字样))

  /* 夹子框的正中央 */
  const folderBox = await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="folder"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      }
    })()
  `)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: folderBox.x, y: folderBox.y, button: 'left' })
  await sleep(250)

  const overFolder = await dropState()
  console.log('    指针在夹子框里：', JSON.stringify(overFolder))
  check('指针进到夹子框里就判定为「放进」', overFolder.落点夹子 !== null, JSON.stringify(overFolder))
  check('判定为放进时不再画红线', overFolder.红线 === null, String(overFolder.红线))
  check('夹子整框变色了',
    overFolder.夹子框变色 !== null && overFolder.夹子框变色 !== 'rgba(0, 0, 0, 0)',
    String(overFolder.夹子框变色))

  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: folderBox.x, y: folderBox.y, button: 'left', clickCount: 1,
  })
  await sleep(700)

  const afterFold = await order()
  console.log(`    拖进之后顶层：${afterFold.join(',')}`)
  check('条目从顶层消失了', !afterFold.includes(lastEntity.id), afterFold.join(','))

  const folderCount = await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="folder"]')
      return el ? el.innerText.replace(/\\s+/g, ' ') : null
    })()
  `)
  console.log('    夹子卡片现在写着：', folderCount)
  check('夹子上显示的条目数变成了 1', /1/.test(String(folderCount)), String(folderCount))

  /* 筛选栏的数量也必须跟着这一层走。
     之前它数的是**整本书**的条目数 —— 进了夹子还显示全书的数，
     看起来就像「这个夹子里有 7 个词条」。 */
  const chipCount = async () =>
    evaluate(`
      Array.from(document.querySelectorAll('button'))
        .map((b) => b.textContent.replace(/\\s+/g, ''))
        .filter((t) => /^全部\\d+$/.test(t))[0] ?? null
    `)
  const topChip = await chipCount()
  console.log('    顶层筛选栏：', topChip)
  check('顶层「全部」只数顶层还剩的条目（3 个搬走了 1 个，剩 2）',
    topChip === '全部2', String(topChip))

  console.log('\n[7] 进夹子看，再拖出来')

  const entered = await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="folder"]')
      if (!el) return false
      el.click()
      return true
    })()
  `)
  await sleep(700)
  const inFolder = await order()
  check('点夹子能进去', entered && inFolder.length === 1, JSON.stringify(inFolder))
  check('进去的是刚才那个条目', inFolder[0] === lastEntity.id, JSON.stringify(inFolder))
  check('夹子页面顶部能看到名字', await evaluate(`
    document.querySelector('[data-folder-head] input')?.value === '北境人物'
  `))
  const insideChip = await chipCount()
  console.log('    夹子内筛选栏：', insideChip)
  check('进了夹子，筛选栏只数夹子里的条目（1 个）', insideChip === '全部1', String(insideChip))

  /* 用面包屑上的「全部」把它拖出去 */
  const inside = await nthSlotCenter(0)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inside.x, y: inside.y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: inside.x, y: inside.y, button: 'left', clickCount: 1,
  })
  await sleep(80)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: inside.x + 10, y: inside.y + 10, button: 'left',
  })
  await sleep(300)

  const crumb = await evaluate(`
    (() => {
      const c = document.querySelector('[data-drop-into="__root__"]')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()
  `)
  check('拖动时面包屑的「全部」变成了落点', crumb !== null, JSON.stringify(crumb))
  if (crumb) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: crumb.x, y: crumb.y, button: 'left' })
    await sleep(200)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: crumb.x, y: crumb.y, button: 'left', clickCount: 1,
    })
    await sleep(700)
  }

  check('夹子里空了', (await order()).length === 0, JSON.stringify(await order()))
  await clickText('全部')
  await sleep(600)
  const backAtRoot = await order()
  console.log(`    拖出来之后顶层：${backAtRoot.join(',')}`)
  check('条目回到了顶层', backAtRoot.includes(lastEntity.id), backAtRoot.join(','))

  console.log('\n[8] 夹子套夹子')

  await clickText('新建词条夹')
  await sleep(700)
  await setField('[data-folder-head] input', '内层夹')
  await clickText('全部')
  await sleep(600)

  const folders = await evaluate(`
    Array.from(document.querySelectorAll('[data-kind="folder"]')).map(e => e.dataset.id)
  `)
  check('现在有两个夹子', folders.length === 2, JSON.stringify(folders))

  /* 注意：按**名字**找夹子，不按序号 —— 新建的夹子会插在最前面，
     按序号找会在新建之后指向另一个夹子。 */
  const folderByName = (name) =>
    evaluate(`
      (() => {
        const el = Array.from(document.querySelectorAll('[data-kind="folder"]'))
          .find((e) => e.innerText.trim().startsWith(${JSON.stringify(name)}))
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          id: el.dataset.id,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        }
      })()
    `)

  const source = await folderByName('内层夹')
  const dest = await folderByName('北境人物')
  check('两个夹子都找得到', source !== null && dest !== null, JSON.stringify({ source, dest }))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: source.x, y: source.y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: source.x, y: source.y, button: 'left', clickCount: 1,
  })
  await sleep(80)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: source.x + 10, y: source.y + 10, button: 'left',
  })
  await sleep(300)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dest.x, y: dest.y, button: 'left' })
  await sleep(250)

  const nesting = await dropState()
  console.log('    拖到另一个夹子上：', JSON.stringify(nesting))
  check('拖到另一个夹子框里也判定为放进', nesting.落点夹子 !== null, JSON.stringify(nesting))

  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: dest.x, y: dest.y, button: 'left', clickCount: 1,
  })
  await sleep(700)

  const afterNest = await evaluate(`
    Array.from(document.querySelectorAll('[data-kind="folder"]')).length
  `)
  check('嵌套之后顶层只剩一个夹子', afterNest === 1, String(afterNest))

  console.log('\n[9] 刷新之后这些东西还在不在')

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

  const afterReload = await evaluate(`
    (() => {
      const folders = Array.from(document.querySelectorAll('[data-kind="folder"]'))
      return {
        顶层夹子数: folders.length,
        顶层条目数: document.querySelectorAll('[data-slot][data-kind="entity"]').length,
        夹子名: folders[0]?.innerText.replace(/\\s+/g, ' ') ?? null,
      }
    })()
  `)
  console.log('    刷新后：', JSON.stringify(afterReload))
  check('刷新后顶层还是 1 个夹子', afterReload.顶层夹子数 === 1, String(afterReload.顶层夹子数))
  check('刷新后顶层有 3 个条目', afterReload.顶层条目数 === 3, String(afterReload.顶层条目数))

  /* 夹子的名字与简介也要留住 */
  await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="folder"]')
      if (el) el.click()
      return true
    })()
  `)
  await sleep(800)
  const kept = await evaluate(`
    (() => {
      const h = document.querySelector('[data-folder-head]')
      return h ? { 名字: h.querySelector('input').value, 简介: h.querySelector('textarea').value } : null
    })()
  `)
  check('刷新后夹子名字还在', kept?.名字 === '北境人物', String(kept?.名字))
  check('刷新后夹子简介还在', kept?.简介 === '所有和北境有关的人。', String(kept?.简介))

  console.log('\n[10] 窄窗口塌成一列时：红线得是横的，顺序按上下判')

  /* 先回到顶层：上一步停在夹子里，那里只有一张卡，量不出「一列」 */
  await clickText('全部')
  await sleep(600)
  const atRoot = await order()
  check('顶层有足够多的卡片可比', atRoot.length >= 3, JSON.stringify(atRoot))

  /* 卡片网格在窄窗口下会从两三列塌成一列。那时候再按「左右半边」
     决定前后就是错的 —— 落在某张的下半会被判成「插到它前面」，
     顺序整个反过来。这里把窗口压窄，验证它已经按一列处理。 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 700,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(900)

  const cols = await evaluate(`
    (() => {
      const s = Array.from(document.querySelectorAll('[data-slot]'))
      if (s.length === 0) return -1
      const t0 = Math.min(...s.map((e) => e.getBoundingClientRect().top))
      return s.filter((e) => Math.abs(e.getBoundingClientRect().top - t0) < 6).length
    })()
  `)
  check('窄窗口下确实只剩一列', cols === 1, String(cols))

  const listBefore = await order()
  /* 把最后一项拖到第 2 项的上半部分 → 应该插到它上面。
     第 1 项是词条夹（悬上去会变成「放进」），所以目标取第 2 项。 */
  const listSrc = await nthSlotCenter(listBefore.length - 1)
  const listDst = await nthSlotPoint(1, 0.5, 0.2)
  check('量得到源卡片和目标位置', listSrc !== null && listDst !== null,
    JSON.stringify({ listSrc, listDst }))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: listSrc.x, y: listSrc.y })
  await sleep(60)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: listSrc.x, y: listSrc.y, button: 'left', clickCount: 1,
  })
  await sleep(80)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: listSrc.x + 10, y: listSrc.y + 10, button: 'left',
  })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: listDst.x, y: listDst.y, button: 'left' })
  await sleep(250)

  const listState = await dropState()
  const listBoxes = await evaluate(`
    (() => {
      const s = Array.from(document.querySelectorAll('[data-slot]'))
      return s.map((e, i) => {
        const r = e.getBoundingClientRect()
        return i + ':' + (e.dataset.kind === 'folder' ? '夹' : '条') + ' top=' + Math.round(r.top) + ' h=' + Math.round(r.height)
      })
    })()
  `)
  console.log('    单列拖动中：', JSON.stringify(listState))
  console.log('    目标点 y =', listDst.y, ' 各卡片：', listBoxes.join(' | '))
  check('一列排下来时红线是横的', listState.红线 === '横', String(listState.红线))

  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: listDst.x, y: listDst.y, button: 'left', clickCount: 1,
  })
  await sleep(700)

  const listAfter = await order()
  console.log(`    拖动前 ${listBefore.join(',')}`)
  console.log(`    拖动后 ${listAfter.join(',')}`)
  check('单列时插到了目标的上方',
    listAfter[1] === listBefore[listBefore.length - 1], listAfter.join(','))

  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(700)

  console.log('\n[11] 同一个条目摆进第二个夹子（不是复制数据）')

  /* 目标：让一个条目同时出现在两个夹子里，而且两边是同一条 ——
     改一边，另一边跟着变；不是什么同步机制，就是只有一份。 */
  await clickText('全部')
  await sleep(600)
  const pl_idsAtRoot = await evaluate(`
    Array.from(document.querySelectorAll('[data-slot][data-kind="entity"]')).map((e) => e.dataset.id)
  `)
  check('顶层有可用的条目', pl_idsAtRoot.length > 0, JSON.stringify(pl_idsAtRoot))

  const pl_entId = pl_idsAtRoot[0]
  const pl_openedForPlace = await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="entity"][data-id="${pl_entId}"]')
      if (!el) return false
      el.click()
      return true
    })()
  `)
  await sleep(800)
  check('打开了那个条目', pl_openedForPlace)

  const pl_placementIdle = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.title === '同一个条目可以摆在好几个夹子里；内容只有一份')
      return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null
    })()
  `)
  console.log('    摆放一栏（还没放）：', String(pl_placementIdle))
  check('条目页上有「摆放」这一栏', pl_placementIdle !== null, String(pl_placementIdle))

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.title === '同一个条目可以摆在好几个夹子里；内容只有一份')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(400)
  /* 用 data-placement / data-on 读，别靠文字：勾选标记是从不显示的字符里看出来的，
     光看 textContent 分不清哪个已经勾上 */
  const pl_options = await evaluate(`
    Array.from(document.querySelectorAll('[data-placement]')).map((b) => ({
      名: b.textContent.replace(/\\s+/g, ' ').trim(),
      on: b.dataset.on,
    }))
  `)
  console.log('    可选的夹子：', JSON.stringify(pl_options))
  check('列出「顶层」和那个夹子', pl_options.length >= 2, JSON.stringify(pl_options))
  check('还没放进去的夹子显示未勾选',
    pl_options.some((o) => o.名.includes('北境人物') && o.on === 'false'), JSON.stringify(pl_options))

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('[data-placement]')).find(x => x.textContent.includes('北境人物'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(700)
  const pl_checked = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('[data-placement]')).find(x => x.textContent.includes('北境人物'))
      return b ? b.dataset.on : null
    })()
  `)
  check('点一下之后那个夹子被勾上', pl_checked === 'true', String(pl_checked))
  const pl_placementAfter = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.title === '同一个条目可以摆在好几个夹子里；内容只有一份')
      return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null
    })()
  `)
  console.log('    摆放一栏（放了之后）：', String(pl_placementAfter))
  check('摆放一栏显示它现在在「北境人物」', pl_placementAfter?.includes('北境人物') === true,
    String(pl_placementAfter))

  /* 进那个夹子：同一条应该也在里面，而且 data-id 一模一样 */
  await clickText('返回索引')
  await sleep(500)
  const pl_entered = await evaluate(`
    (() => {
      const f = Array.from(document.querySelectorAll('[data-kind="folder"]')).find(e => e.innerText.includes('北境人物'))
      if (!f) return false
      f.click()
      return true
    })()
  `)
  await sleep(800)
  check('进得去那个夹子', pl_entered)
  const pl_inFolder = await evaluate(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-slot][data-kind="entity"]'))
      return {
        ids: cards.map((e) => e.dataset.id),
        head: document.querySelector('[data-folder-head]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
      }
    })()
  `)
  console.log('    夹子里：', JSON.stringify(pl_inFolder))
  check('夹子里出现了同一个条目', pl_inFolder.ids.includes(pl_entId), JSON.stringify(pl_inFolder.ids))
  check('夹子数是 1 条', (pl_inFolder.head ?? '').includes('1 条'), String(pl_inFolder.head))
  check('它还是同一条（id 一致）', pl_inFolder.ids.length === 1, JSON.stringify(pl_inFolder.ids))

  /* 改名字，看两边是不是同一条 */
  await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="entity"][data-id="${pl_entId}"]')
      if (el) el.click()
      return true
    })()
  `)
  await sleep(700)
  const pl_renamed = await evaluate(`
    (() => {
      const el = document.querySelector('input[placeholder="名称"]')
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, '齐国伐宋')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(600)
  check('能把名字改成「齐国伐宋」', pl_renamed)

  await clickText('返回索引')
  await sleep(500)
  const pl_folderName = await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="entity"][data-id="${pl_entId}"]')
      return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
    })()
  `)
  check('夹子里那张卡片跟着改名了（同一条）', pl_folderName?.includes('齐国伐宋') === true,
    String(pl_folderName))

  await clickText('全部')
  await sleep(600)
  const pl_rootName = await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="entity"][data-id="${pl_entId}"]')
      return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
    })()
  `)
  check('顶层那张也一起改了（不是两份数据）', pl_rootName?.includes('齐国伐宋') === true,
    String(pl_rootName))

  /* 撤掉夹子里那一份：条目本身要还在 */
  await evaluate(`
    (() => {
      const el = document.querySelector('[data-kind="entity"][data-id="${pl_entId}"]')
      if (el) el.click()
      return true
    })()
  `)
  await sleep(700)
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.title === '同一个条目可以摆在好几个夹子里；内容只有一份')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(400)
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('北境人物') && x.textContent.includes('移走'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(700)
  await clickText('返回索引')
  await sleep(500)
  const pl_afterRemove = await evaluate(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-slot][data-kind="entity"]'))
      return cards.map((e) => e.dataset.id)
    })()
  `)
  check('撤掉那一份之后，条目本身还在顶层', pl_afterRemove.includes(pl_entId), JSON.stringify(pl_afterRemove))

  console.log('\n[12] 页面无报错')
  check('控制台无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 500))

  console.log('')
  console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
  ws.close()
  edge.kill()
  process.exit(failures === 0 ? 0 : 1)
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
