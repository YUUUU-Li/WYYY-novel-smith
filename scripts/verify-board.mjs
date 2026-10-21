/* ============================================================
   手工摆的时间线，在真浏览器里走一遍

   为什么必须跑真浏览器：
   · 「拖进来按时间自动落行」是 dragstart/drop + 位移坐标一起算出来的，
     纯函数测不到坐标这一段
   · 「左右拖格子」走的是 pointer 事件 + setPointerCapture，
     合成 el.click() 根本触发不到
   · 「换窗口大小之后对齐还在不在」只有真的改视口才看得见

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/verify-board.mjs
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9352
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'

const profile = mkdtempSync(join(tmpdir(), 'ns-board-'))
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
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
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

  const clickText = async (t) => {
    const ok = await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(t)})
        if (b) { b.click(); return true }
        return false
      })()
    `)
    await sleep(450)
    return ok
  }
  const setInput = async (sel, value) => {
    const ok = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(sel)})
        if (!el) return false
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        s.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(350)
    return ok
  }
  const goView = async (name) => {
    await evaluate(`
      (() => {
        const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes(${JSON.stringify(name)}))
        if (t) t.click()
        return true
      })()
    `)
    await sleep(900)
  }

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
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

  /* ---------------- 建小说 + 四个事件 ---------------- */
  await setInput('input[placeholder="小说的名字"]', '时间线核对')
  await sleep(300)
  await clickText('创建')
  await sleep(1500)
  await goView('设定')

  /* 事件名 → 年（月/日用「设定时间」的默认值，同一天就落在同一行） */
  const events = [
    ['齐国伐宋', 421],
    ['宋国求援', 421],
    ['云京会盟', 422],
    ['北境雪灾', 420],
  ]
  for (const [name, year] of events) {
    await clickText('新建词条')
    await sleep(650)
    await clickText('事件')
    await sleep(400)
    await setInput('input[placeholder="名称"]', name)
    await sleep(300)
    await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设定时间'))
        if (b) b.click()
        return true
      })()
    `)
    await sleep(500)
    await evaluate(`
      (() => {
        const inp = Array.from(document.querySelectorAll('input[type="number"]'))
          .find((i) => i.title === '年' || i.placeholder === '年')
        if (!inp) return false
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        s.call(inp, ${JSON.stringify(String(year))})
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(350)
    await clickText('返回索引')
    await sleep(400)
  }

  console.log('\n[1] 进时间线先看到列表')

  await goView('时间线')
  const home = await evaluate(`
    (() => ({
      有新建按钮: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('新建时间线')),
      空提示: document.body.innerText.includes('还没有时间线'),
      有自动生成入口: document.body.innerText.includes('全部事件'),
    }))()
  `)
  check('第一屏是列表，不是那张图', home.有新建按钮, JSON.stringify(home))
  check('列表空的时候说清楚下一步', home.空提示)
  check('自动生成的那几种还能进去', home.有自动生成入口)

  check('能新建一张时间线', await clickText('新建时间线'))
  await sleep(900)
  const onBoard = await evaluate(`
    (() => ({
      有板: !!document.querySelector('[data-board-area]'),
      左侧有事件: document.querySelectorAll('[data-drag-event]').length,
      空提示: document.body.innerText.includes('把左边的事件拖进来'),
    }))()
  `)
  check('点进去看到的是板子', onBoard.有板, JSON.stringify(onBoard))
  check('左边列出所有事件', onBoard.左侧有事件 === 4, String(onBoard.左侧有事件))
  check('空板上有起步提示', onBoard.空提示)

  console.log('\n[2] 拖进来，按时间自己落行')

  const area = await evaluate(`
    (() => {
      const el = document.querySelector('[data-board-area]')
      const r = el.getBoundingClientRect()
      return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    })()
  `)

  const dropEvent = async (name, fx, fy) => {
    const evId = await evaluate(`
      (() => {
        const el = Array.from(document.querySelectorAll('[data-drag-event]'))
          .find((e) => e.textContent.includes(${JSON.stringify(name)}))
        return el ? el.dataset.dragEvent : null
      })()
    `)
    if (!evId) return false
    const x = Math.round(area.l + area.w * fx)
    const y = Math.round(area.t + area.h * fy)
    const data = { items: [{ mimeType: 'text/plain', data: evId }], dragOperationsMask: 1 }
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
    await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
    await sleep(120)
    await send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
    await sleep(500)
    return true
  }

  /* 故意把 422 的拖到最上面、420 的拖到最下面 —— 行不该听落点，
     只听事件自己的时间 */
  check('拖进来第一件（422 拖到最上方）', await dropEvent('云京会盟', 0.35, 0.05))
  check('拖进来第二件（420 拖到最下方）', await dropEvent('北境雪灾', 0.6, 0.85))
  check('拖进来第三件（421）', await dropEvent('宋国求援', 0.25, 0.5))
  check('拖进来第四件（421，同一天）', await dropEvent('齐国伐宋', 0.55, 0.6))

  const afterDrop = await evaluate(`
    (() => {
      const rows = Array.from(document.querySelectorAll('[data-row]'))
      const cells = Array.from(document.querySelectorAll('[data-cell]'))
      const rowOf = (id) => {
        const el = document.querySelector('[data-cell="' + id + '"]')
        if (!el) return null
        const top = Math.round(parseFloat(el.style.top || '0'))
        // 一格属于哪一行：按它到各行上沿的距离算
        let best = null
        for (const r of rows) {
          const rTop = Math.round(parseFloat(r.style.top || '0'))
          if (rTop <= top + 2) best = r
        }
        return best?.dataset.row ?? null
      }
      return {
        行数: rows.length,
        格数: cells.length,
        // 刻度在左边的粘性列里，不在行的盒子里
        行标签: Array.from(document.querySelectorAll('[data-row-label]')).map((el) => el.innerText.trim()),
        各行格数: rows.map((r) => cells.filter((c) => rowOf(c.dataset.cell) === r.dataset.row).length),
      }
    })()
  `)
  console.log('    落位结果：', JSON.stringify(afterDrop))
  check('四件都放上去了', afterDrop.格数 === 4, String(afterDrop.格数))
  check('落成三行（两件同一天并到一行）', afterDrop.行数 === 3, String(afterDrop.行数))
  check('最早的那件在第一行（跟拖到哪儿无关）',
    afterDrop.行标签[0]?.includes('420'), JSON.stringify(afterDrop.行标签))
  check('最晚的那件在最后一行', afterDrop.行标签[2]?.includes('422'), JSON.stringify(afterDrop.行标签))
  check('同一天的两件在同一行', afterDrop.各行格数[1] === 2, JSON.stringify(afterDrop.各行格数))

  console.log('\n[3] 左右拖一格：同行同时间，不同列不同空间')

  const cellBox = async (name) =>
    evaluate(`
      (() => {
        const cell = Array.from(document.querySelectorAll('[data-cell]'))
          .find((c) => c.innerText.includes(${JSON.stringify(name)}))
        if (!cell) return null
        const r = cell.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), left: Math.round(r.left) }
      })()
    `)

  const before = await cellBox('齐国伐宋')
  check('量到了那一格', before !== null, JSON.stringify(before))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 })
  await sleep(90)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + 300, y: before.y, button: 'left' })
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 300, y: before.y, button: 'left', clickCount: 1 })
  await sleep(700)

  const after = await cellBox('齐国伐宋')
  console.log(`    拖动前 left=${before.left} → 拖动后 left=${after?.left}`)
  check('拖了三百像素，格子真的往右走了', (after?.left ?? 0) > before.left + 200,
    `${before.left} → ${after?.left}`)
  check('它还在原来那一行（左右拖不改时间）', Math.abs((after?.y ?? 0) - before.y) < 2,
    `${before.y} → ${after?.y}`)

  const sameRow = await evaluate(`
    (() => {
      const a = Array.from(document.querySelectorAll('[data-cell]')).find((c) => c.innerText.includes('宋国求援'))
      const b = Array.from(document.querySelectorAll('[data-cell]')).find((c) => c.innerText.includes('齐国伐宋'))
      if (!a || !b) return null
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      return { 同一行: Math.abs(ra.top - rb.top) < 3, 左右分开了: rb.left - ra.left > 100 }
    })()
  `)
  check('同一天两件仍然并排在同一行', sameRow?.同一行 === true, JSON.stringify(sameRow))
  check('它们被摆成了左右两列', sameRow?.左右分开了 === true, JSON.stringify(sameRow))

  console.log('\n[4] 列：可以自己定义这一列是什么')

  await clickText('加一列')
  await sleep(600)
  const guideAdded = await evaluate(`
    (() => {
      const guide = document.querySelector('[data-guide]')
      const inp = document.querySelector('input[placeholder="这一列是什么"]')
      const areaTop = document.querySelector('[data-board-area]')?.getBoundingClientRect().top ?? 0
      return {
        有表头: !!guide,
        输入框在上方: inp ? Math.round(inp.getBoundingClientRect().top - areaTop) < 80 : null,
        有解释: document.body.innerText.includes('它不会锁住格子'),
      }
    })()
  `)
  console.log('    加一列之后：', JSON.stringify(guideAdded))
  check('加出一条列（表头出现在板子顶上）', guideAdded.有表头, JSON.stringify(guideAdded))
  check('列名在顶上，不在底下', guideAdded.输入框在上方 === true, String(guideAdded.输入框在上方))
  check('第一次用会解释一句它是什么', guideAdded.有解释, JSON.stringify(guideAdded))

  check('能给列起名字', await setInput('input[placeholder="这一列是什么"]', '齐国'))
  const guideName = await evaluate(`
    document.querySelector('input[placeholder="这一列是什么"]')?.value ?? null
  `)
  check('名字存住了', guideName === '齐国', String(guideName))

  /* 拖列名旁边那个把手，竖线要跟着走 */
  const xOfGuide = async () =>
    evaluate(`
      (() => {
        const lane = document.querySelector('[data-lane]').getBoundingClientRect()
        const guide = [...document.querySelectorAll('[data-guide]')][0]
        if (!guide) return null
        const r = guide.getBoundingClientRect()
        return Math.round(((r.left + r.width / 2 - lane.left) / lane.width) * 1000) / 1000
      })()
    `)
  const gx0 = await xOfGuide()
  const grip = await evaluate(`
    (() => {
      const guide = document.querySelector('[data-guide]')
      const handle = guide?.querySelector('span')
      if (!handle) return null
      const r = handle.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()
  `)
  if (grip) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y })
    await sleep(60)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1 })
    await sleep(80)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + 120, y: grip.y, button: 'left' })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x + 120, y: grip.y, button: 'left', clickCount: 1 })
    await sleep(500)
  }
  const gx1 = await xOfGuide()
  console.log(`    列的位置：${gx0} → ${gx1}`)
  check('按住把手能把竖线左右挪', (gx1 ?? 0) > (gx0 ?? 0) + 0.05, `${gx0} → ${gx1}`)

  console.log('\n[4b] 时间线的名字可以改')

  const renamed = await setInput('input[placeholder="给这张时间线起个名字"]', '北境战事线')
  check('名字输入框可写', renamed)
  const nameValue = await evaluate(`
    document.querySelector('input[placeholder="给这张时间线起个名字"]')?.value ?? null
  `)
  check('改完就生效', nameValue === '北境战事线', String(nameValue))

  console.log('\n[4c] 鼠标停在格子上：时间 / 地点 / 相关角色')

  const cellPt = async (name) =>
    evaluate(`
      (() => {
        const cell = Array.from(document.querySelectorAll('[data-cell]'))
          .find((c) => c.innerText.includes(${JSON.stringify(name)}))
        if (!cell) return null
        const r = cell.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()
    `)
  const pt = await cellPt('云京会盟')
  if (pt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    await sleep(400)
  }
  const tipShown = await evaluate(`
    (() => {
      const tip = document.querySelector('[data-board-tip]')
      if (!tip) return null
      const r = tip.getBoundingClientRect()
      return {
        文本: tip.innerText.replace(/\\s+/g, ' ').trim(),
        在视口内: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      }
    })()
  `)
  console.log('    浮层：', JSON.stringify(tipShown))
  check('悬停格子上会浮出信息', tipShown !== null, String(pt))
  check('浮层里有时间', /422/.test(tipShown?.文本 ?? ''), String(tipShown?.文本))
  check('浮层里有地点（没填就明说未定）', /未定地点|渡口|城|京/.test(tipShown?.文本 ?? ''), String(tipShown?.文本))
  check('浮层里列着相关角色（没人就明说）', /还没有参与角色|甲|乙/.test(tipShown?.文本 ?? ''), String(tipShown?.文本))
  check('浮层不出窗口', tipShown?.在视口内 === true, JSON.stringify(tipShown))

  // 挪开就该收起来，别一直挂在屏幕上
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 })
  await sleep(350)
  const tipGone = await evaluate(`!document.querySelector('[data-board-tip]')`)
  check('鼠标挪开浮层就收起来', tipGone === true)

  console.log('\n[4d] 板宽：同一时间的事多了，放宽之后能左右滑')

  const areaNow = async () =>
    evaluate(`
      (() => {
        const el = document.querySelector('[data-board-area]')
        const lane = document.querySelector('[data-lane]')
        return {
          clientW: Math.round(el.clientWidth),
          scrollW: Math.round(el.scrollWidth),
          laneW: Math.round(lane.getBoundingClientRect().width),
        }
      })()
    `)
  const normX = async (name) =>
    evaluate(`
      (() => {
        const lane = document.querySelector('[data-lane]').getBoundingClientRect()
        const cell = Array.from(document.querySelectorAll('[data-cell]'))
          .find((c) => c.innerText.includes(${JSON.stringify(name)}))
        if (!cell) return null
        const r = cell.getBoundingClientRect()
        return Math.round(((r.left + r.width / 2 - lane.left) / lane.width) * 1000) / 1000
      })()
    `)

  const one = await areaNow()
  const xBeforeWide = await normX('云京会盟')
  console.log('    一屏宽：', JSON.stringify(one))
  check('一屏宽时没有横向滚动条', one.scrollW <= one.clientW + 1, JSON.stringify(one))

  await clickText('+')
  await sleep(700)
  const wide = await areaNow()
  const xWide = await normX('云京会盟')
  console.log('    放宽之后：', JSON.stringify(wide), '归一化 x =', xBeforeWide, '→', xWide)
  check('放宽之后画布比窗口宽（可以左右滑）', wide.scrollW > wide.clientW + 40, JSON.stringify(wide))
  check('画布宽度按倍数算：大致是可视宽度减刻度乘 1.5',
    Math.abs(wide.laneW - Math.round((wide.clientW - 118) * 1.5)) < 4,
    `${wide.laneW} vs ${Math.round((wide.clientW - 118) * 1.5)}`)
  check('放宽只是放大画布，格子的相对位置没变',
    Math.abs((xWide ?? 0) - (xBeforeWide ?? 0)) < 0.002, `${xBeforeWide} → ${xWide}`)

  /* 往右滚：刻度列得钉在左边，不然滚两屏就不知道自己在看哪一年 */
  await evaluate(`
    (() => {
      const el = document.querySelector('[data-board-area]')
      el.scrollLeft = 260
      return el.scrollLeft
    })()
  `)
  await sleep(400)
  const sticky = await evaluate(`
    (() => {
      const area = document.querySelector('[data-board-area]')
      const gutter = document.querySelector('[data-gutter]')
      const label = document.querySelector('[data-row-label]')
      const a = area.getBoundingClientRect()
      const g = gutter.getBoundingClientRect()
      const l = label.getBoundingClientRect()
      return {
        滚了: Math.round(area.scrollLeft),
        刻度贴着左边: Math.abs(g.left - a.left) < 3,
        刻度有宽度: Math.round(g.width),
        标签还在视口里: l.right > a.left && l.left < a.right,
      }
    })()
  `)
  console.log('    滚到右边之后：', JSON.stringify(sticky))
  check('能横向滚起来', sticky.滚了 > 200, JSON.stringify(sticky))
  check('刻度和行标签钉在左边不跟着滚', sticky.刻度贴着左边 && sticky.标签还在视口里, JSON.stringify(sticky))

  /* 滚着的时候拖一格，照样落得准 */
  const dragPt = await cellPt('宋国求援')
  if (dragPt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPt.x, y: dragPt.y })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPt.x, y: dragPt.y, button: 'left', clickCount: 1 })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPt.x + 90, y: dragPt.y, button: 'left' })
    await sleep(180)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragPt.x + 90, y: dragPt.y, button: 'left', clickCount: 1 })
    await sleep(600)
  }
  const xAfterScrollDrag = await normX('宋国求援')
  console.log('    滚动状态下拖完之后归一化 x =', xAfterScrollDrag)

  await evaluate(`
    (() => {
      const el = document.querySelector('[data-board-area]')
      el.scrollLeft = 0
      return 0
    })()
  `)
  await sleep(250)
  await clickText('−')
  await sleep(700)
  const back = await areaNow()
  console.log('    收回一屏：', JSON.stringify(back))
  check('点「−」能收回来，横向滚动条又没了', back.scrollW <= back.clientW + 1, JSON.stringify(back))

  console.log('\n[5] 换窗口大小，对齐不该散架')
  const xBefore = await evaluate(`
    (() => {
      const area = document.querySelector('[data-lane]').getBoundingClientRect()
      const cell = Array.from(document.querySelectorAll('[data-cell]')).find((c) => c.innerText.includes('齐国伐宋'))
      const r = cell.getBoundingClientRect()
      return Math.round(((r.left + r.width / 2 - area.left) / area.width) * 1000) / 1000
    })()
  `)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1080, height: 860, deviceScaleFactor: 1, mobile: false,
  })
  await sleep(900)
  const xAfter = await evaluate(`
    (() => {
      const area = document.querySelector('[data-lane]').getBoundingClientRect()
      const cell = Array.from(document.querySelectorAll('[data-cell]')).find((c) => c.innerText.includes('齐国伐宋'))
      const r = cell.getBoundingClientRect()
      return Math.round(((r.left + r.width / 2 - area.left) / area.width) * 1000) / 1000
    })()
  `)
  console.log(`    相对位置：${xBefore} → ${xAfter}`)
  check('窗口变窄后相对位置几乎不变（用的是归一化坐标）',
    Math.abs((xAfter ?? 0) - (xBefore ?? 0)) < 0.02, `${xBefore} → ${xAfter}`)
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(700)

  console.log('\n[6] 拿掉一格、删掉一张，事件本身都得留着')

  const removed = await evaluate(`
    (() => {
      const cell = Array.from(document.querySelectorAll('[data-cell]')).find((c) => c.innerText.includes('北境雪灾'))
      if (!cell) return false
      const btn = cell.querySelector('button')
      if (!btn) return false
      btn.click()
      return true
    })()
  `)
  await sleep(600)
  const afterRemove = await evaluate(`
    (() => ({
      格数: document.querySelectorAll('[data-cell]').length,
      左侧回来了: Array.from(document.querySelectorAll('[data-drag-event]')).some((e) => e.textContent.includes('北境雪灾')),
    }))()
  `)
  check('能把它从时间线上拿掉', removed && afterRemove.格数 === 3, JSON.stringify(afterRemove))
  check('拿掉之后它回到左边、条目还在', afterRemove.左侧回来了, JSON.stringify(afterRemove))

  console.log('\n[7] 刷新之后板子还在')

  await sleep(900)
  await send('Page.reload', { ignoreCache: true })
  await sleep(2500)
  await goView('时间线')
  const listAfterReload = await evaluate(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[data-board]'))
      return cards.map((c) => c.innerText.replace(/\\s+/g, ' ').trim())
    })()
  `)
  console.log('    刷新后的列表：', JSON.stringify(listAfterReload))
  check('列表里那张板还在', listAfterReload.length === 1, JSON.stringify(listAfterReload))
  check('列表上写着改过的名字', /北境战事线/.test(listAfterReload[0] ?? ''), String(listAfterReload[0]))
  check('列表上写着整体时间（420 那一件已在第 6 步拿掉，所以是 421→422）', /421/.test(listAfterReload[0] ?? '') && /422/.test(listAfterReload[0] ?? ''),
    String(listAfterReload[0]))

  await evaluate(`
    (() => {
      const card = document.querySelector('[data-board] button')
      if (card) card.click()
      return true
    })()
  `)
  await sleep(1200)
  const boardAfterReload = await evaluate(`
    (() => ({
      格数: document.querySelectorAll('[data-cell]').length,
      列名: document.querySelector('input[placeholder="这一列是什么"]')?.value ?? null,
      有齐国伐宋: document.body.innerText.includes('齐国伐宋'),
    }))()
  `)
  console.log('    刷新后的板子：', JSON.stringify(boardAfterReload))
  check('刷新后格子还在', boardAfterReload.格数 === 3, String(boardAfterReload.格数))
  check('刷新后列名还在', boardAfterReload.列名 === '齐国', String(boardAfterReload.列名))

  console.log('\n[9] 全部事件：拖刻度条收窄视野（事件多了就靠这个）')

  /* 从时间线的列表进「全部事件」。这条轴是所有事件算出来的，和板子是两回事。
     所以得先退回列表 —— 这条入口只在列表上。 */
  await evaluate(`
    (() => {
      const b = document.querySelector('button[title="回到时间线列表"]')
      if (b) b.click()
      return !!b
    })()
  `)
  await sleep(800)
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('自动排好'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(1200)

  const rulerNow = async () =>
    evaluate(`
      (() => {
        const el = document.querySelector('[data-ruler]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { l: Math.round(r.left), w: Math.round(r.width), y: Math.round(r.top + r.height / 2) }
      })()
    `)
  const readWindow = async () =>
    evaluate(`
      (() => {
        const chip = document.querySelector('[data-window]')
        return {
          标签: chip ? chip.innerText.replace(/\\s+/g, ' ').trim() : null,
          轴上事件: document.querySelectorAll('[data-event]').length,
        }
      })()
    `)

  const beforeWin = await readWindow()
  console.log('    收窄之前：', JSON.stringify(beforeWin))
  check('全部事件里有可拖的刻度条', (await rulerNow()) !== null)
  check('这时候还没有「只看这一段」的标签', beforeWin.标签 === null, String(beforeWin.标签))

  const dragRuler = async (f0, f1) => {
    const n0 = await rulerNow()
    const x0 = Math.round(n0.l + n0.w * f0)
    const x1 = Math.round(n0.l + n0.w * f1)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: n0.y })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: n0.y, button: 'left', clickCount: 1 })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((x0 + x1) / 2), y: n0.y, button: 'left' })
    await sleep(90)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: n0.y, button: 'left' })
    await sleep(150)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: n0.y, button: 'left', clickCount: 1 })
    await sleep(700)
  }

  /* 从 420 到 422 只有三年，拖右边六成：420 那件应该被挡在外面 */
  await dragRuler(0.45, 0.98)
  const win = await readWindow()
  console.log('    拖右边一截之后：', JSON.stringify(win))
  check('拖一段之后出现「只看这一段」的标签', typeof win.标签 === 'string', JSON.stringify(win))
  check('标签里写着「N / 总数 件」', win.标签?.includes('/') === true, String(win.标签))
  check('框住之后轴上的事件真的少了（不是框了没用）',
    win.轴上事件 > 0 && win.轴上事件 < beforeWin.轴上事件,
    `${beforeWin.轴上事件} → ${win.轴上事件}`)

  const rp = await rulerNow()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rp.l + Math.round(rp.w * 0.5), y: rp.y })
  await sleep(90)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rp.l + Math.round(rp.w * 0.5), y: rp.y, button: 'left', clickCount: 1 })
  await sleep(90)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.l + Math.round(rp.w * 0.5), y: rp.y, button: 'left', clickCount: 1 })
  await sleep(700)
  const backAll = await readWindow()
  console.log('    点一下刻度条：', JSON.stringify(backAll))
  check('点一下刻度条回到全部', backAll.标签 === null, String(backAll.标签))
  check('事件全都回来了', backAll.轴上事件 === beforeWin.轴上事件,
    `${beforeWin.轴上事件} → ${backAll.轴上事件}`)

  console.log('\n[10] 页面无报错')
  check('控制台无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400))

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
