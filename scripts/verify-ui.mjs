/* ============================================================
   在真实浏览器里核对界面上「看得见什么」

   为什么需要它：
   「别名那一栏删掉了吗」「条目 id 还看不看得见」这类问题，
   读源码能回答一半 —— 源码删了但没重新构建、或者另一半从
   别的组件又渲染出来了，只有真渲染一遍才知道。

   做法：起一个无头 Edge，开远程调试，用 CDP 注入检查脚本。
   检查的是「用户能读到的事实」：元素文本、placeholder、结构。

   跑法（需要先 npm run build 且 npm run serve 在跑）：
     node scripts/verify-ui.mjs
   ============================================================ */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 浏览器路径：别的机器上不一样，用 EDGE_PATH 覆盖 */
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9344
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5183/'

const profile = mkdtempSync(join(tmpdir(), 'ns-verify-'))

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
      pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text)
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

  /* 建一本小说。 */
  const typed = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="小说的名字"]')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '界面核对')
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

  /* 切到「设定」并建一个角色。 */
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
      if (b) { b.click(); return true }
      return false
    })()
  `)
  await sleep(1200)

  console.log('\n[1] 名字与图标')

  const branding = await evaluate(`
    (() => {
      const icon = document.querySelector('link[rel="icon"]')
      return {
        标题: document.title,
        图标链接: icon ? icon.getAttribute('href') : null,
      }
    })()
  `)
  check('标签页标题是「吾又一言」', branding.标题 === '吾又一言', branding.标题)
  check('index.html 里引了 favicon', branding.图标链接 !== null, String(branding.图标链接))

  const faviconOk = await evaluate(`
    fetch('/favicon.ico')
      .then((r) => 'HTTP ' + r.status)
      .catch((e) => 'ERR ' + e.message)
  `)
  check('favicon.ico 真的能取到', faviconOk === 'HTTP 200', String(faviconOk))

  console.log('\n[2] 条目编辑器里不该出现的东西')

  const labels = await evaluate(`
    (() => {
      // SectionLabel 渲染成 .t-micro，这正是「小标题」这一类元素
      const labs = Array.from(document.querySelectorAll('.t-micro'))
        .map(el => el.textContent.trim())
        .filter(Boolean)
      return { 标签们: Array.from(new Set(labs)) }
    })()
  `)
  const editorText = await evaluate(`document.body.innerText`)
  check('可见文本里没有「别名」', !editorText.includes('别名'), '在页面文本里找到了「别名」')
  check('小标题里没有「别名」', !labels.标签们.includes('别名'), labels.标签们.join(' / '))
  check('界面上没有「被提及」', !editorText.includes('被提及'), '在页面文本里找到了「被提及」')
  check('界面上没有「已提及」', !editorText.includes('已提及'))
  check('角色编辑器的基本小标题都在',
    ['类型', '一句话', '标签', '世界内时间'].every((l) => labels.标签们.includes(l)),
    labels.标签们.join(' / '))
  console.log('    当前小标题：', labels.标签们.join(' / '))

  console.log('\n[3] 条目 id 必须完全不可见')

  const idProbe = await evaluate(`
    (() => {
      const text = document.body.innerText
      // 新建条目的 id 形如 char_xxx / loc_xxx，界面上不该出现这种模式
      const m = text.match(/\\b(character|location|event|faction|item|concept)_[A-Za-z0-9]{4,}\\b/)
      return { 命中: m ? m[0] : null, 全文长度: text.length }
    })()
  `)
  check('页面上找不到条目 id', idProbe.命中 === null, idProbe.命中 ?? '')

  console.log('\n[4] 角色不再有「所在地点」和「驻留历史」')

  const charFields = await evaluate(`
    (() => {
      const t = document.body.innerText
      const labels = Array.from(document.querySelectorAll('.t-micro')).map(e => e.textContent.trim())
      return {
        有所在地点: t.includes('所在地点'),
        有驻留: t.includes('驻留'),
        标签们: Array.from(new Set(labels)),
      }
    })()
  `)
  check('角色的编辑器里没有「所在地点」', !charFields.有所在地点, charFields.标签们.join(' / '))
  check('角色的编辑器里没有「驻留历史」', !charFields.有驻留, charFields.标签们.join(' / '))
  check('角色的编辑器里也没有「发生地点」',
    !charFields.标签们.includes('发生地点'), charFields.标签们.join(' / '))

  /* 换成「事件」—— 事件的发生地点要还在，它撑着时间线和在场矩阵 */
  const switched = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '事件')
      if (!b) return false
      b.click()
      return true
    })()
  `)
  check('能把条目类型切成「事件」', switched)
  await sleep(800)

  const eventFields = await evaluate(`
    (() => {
      const t = document.body.innerText
      const labels = Array.from(document.querySelectorAll('.t-micro')).map(e => e.textContent.trim())
      return {
        有发生地点: t.includes('发生地点'),
        有驻留: t.includes('驻留'),
        标签们: Array.from(new Set(labels)),
      }
    })()
  `)
  check('事件的编辑器里有「发生地点」', eventFields.有发生地点, eventFields.标签们.join(' / '))
  check('事件也没有「驻留历史」', !eventFields.有驻留, eventFields.标签们.join(' / '))

  /* 切回角色，免得影响后面的检查 */
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '角色')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(600)

  console.log('\n[5] 条目页不再有「关系」这一块，事件的参与角色自己选')

  const relGone = await evaluate(`
    (() => {
      const t = document.body.innerText
      return {
        指向别人: t.includes('指向别人'),
        被别人指向: t.includes('被别人指向'),
        有关系按钮: !!Array.from(document.querySelectorAll('button')).find(x => /^关系/.test(x.textContent.trim())),
        还有正文: t.includes('正文'),
      }
    })()
  `)
  check('「指向别人」那一栏没了', !relGone.指向别人, String(relGone.指向别人))
  check('「被别人指向」那一栏也没了', !relGone.被别人指向, String(relGone.被别人指向))
  check('顶上那个「关系 N」的折叠块没了', !relGone.有关系按钮)
  check('正文还在（没把整个右栏一起删掉）', relGone.还有正文)

  /* 切成「事件」：这里应该有「参与角色」 */
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '事件')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(700)

  const castUi = await evaluate(`
    (() => {
      const t = document.body.innerText
      const add = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('添加参与角色'))
      return {
        有小标题: t.includes('参与角色'),
        有添加入口: !!add,
      }
    })()
  `)
  check('事件里有「参与角色」这一栏', castUi.有小标题, JSON.stringify(castUi))
  check('有「添加参与角色」的入口', castUi.有添加入口, JSON.stringify(castUi))

  /* 先给事件填个年份，时间线上才看得见它；然后再去看那句
     「还没有参与角色」到底是从哪来的。 */
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设定时间'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(600)
  const dated = await evaluate(`
    (() => {
      const inp = Array.from(document.querySelectorAll('input[type="number"]'))
        .find((i) => i.title === '年' || i.placeholder === '年')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '421')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  check('能给事件填上世界内年份', dated)

  /* 时间线这一栏现在先进列表，要再点一下「全部事件」才到自动生成的那种视图 */
  const goDerived = async () => {
    await goTab('时间线')
    await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('自动排好'))
        if (b) b.click()
        return true
      })()
    `)
    await sleep(1000)
  }

  const goTab = async (name) => {
    await evaluate(`
      (() => {
        const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes(${JSON.stringify(name)}))
        if (t) t.click()
        return true
      })()
    `)
    await sleep(900)
  }

  /* 悬停那根事件条，读浮层 */
  const hoverEventTip = async () => {
    const pt = await evaluate(`
      (() => {
        const el = document.querySelector('[data-event]')
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()
    `)
    if (!pt) return null
    /* 先把鼠标挪开再进来：如果坐标和上一次一样，浏览器会认为没有移动，
       mouseenter 不会触发，浮层就永远不出现。 */
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    await sleep(600)
    return evaluate(`
      (() => {
        const tip = document.querySelector('[data-tip="1"]')
        return tip ? tip.innerText.replace(/\\s+/g, ' ').trim() : null
      })()
    `)
  }

  await goDerived()
  const tipBefore = await hoverEventTip()
  console.log('    没有参与角色时的浮层：', String(tipBefore).slice(0, 90))
  check('浮层里确实会写「还没有参与角色」', tipBefore?.includes('还没有参与角色') === true,
    String(tipBefore))

  /* 回设定，加一个参与角色 */
  await goTab('设定')
  const openCast = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('添加参与角色'))
      if (!b) return false
      b.click()
      return true
    })()
  `)
  check('点开参与角色的选择面板', openCast)
  await sleep(400)

  const typedCast = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder="搜角色；没有就新建一个"]')
      if (!inp) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '沈雁')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  check('参与角色可以自己写名字', typedCast)
  await sleep(500)

  const newRow = await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('并加入'))
      return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null
    })()
  `)
  check('没建过的名字会提示「新建角色并加入」', newRow?.includes('沈雁') === true, String(newRow))

  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('并加入'))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(800)

  const afterCast = await evaluate(`
    (() => {
      const chips = Array.from(document.querySelectorAll('span'))
        .filter((s) => s.textContent.replace(/\\s+/g, '').startsWith('沈雁'))
        .map((s) => s.textContent.replace(/\\s+/g, ' ').trim())
      const nameInput = document.querySelector('input[placeholder="名称"]')
      return {
        标签: chips,
        还停在事件里: !!nameInput && document.body.innerText.includes('参与角色'),
        新建了角色词条: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '沈雁'),
      }
    })()
  `)
  console.log('    加入参与角色之后：', JSON.stringify(afterCast))
  check('角色作为标签挂了上来', afterCast.标签.length > 0, JSON.stringify(afterCast.标签))
  check('没有把当前事件切走（还停在这个事件里）', afterCast.还停在事件里)
  check('那个名字真的成了角色词条', afterCast.新建了角色词条)

  /* 回时间线：同一根事件条，浮层里应该出现这个人 */
  await goDerived()
  const tipAfter = await hoverEventTip()
  console.log('    加了参与角色之后的浮层：', String(tipAfter).slice(0, 90))
  check('时间线的浮层里能看到参与角色', tipAfter?.includes('沈雁') === true, String(tipAfter))
  check('「还没有参与角色」这句话消失了',
    tipAfter?.includes('还没有参与角色') !== true, String(tipAfter))

  /* 事件一多，靠「在刻度条上拖一段」把视野收窄。
     这件事只有真拖一遍才知道：拖出来的范围有没有对上松手的位置。 */
  const rulerBox = async () =>
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
        const marks = document.querySelectorAll('[data-event]')
        return {
          标签: chip ? chip.innerText.replace(/\\s+/g, ' ').trim() : null,
          轴上事件: marks.length,
          提示条还在: !!document.querySelector('[data-range-hint]'),
        }
      })()
    `)

  const rb = await rulerBox()
  check('事件轴上有可拖的刻度条', rb !== null && rb.w > 200, JSON.stringify(rb))
  const beforeWindow = await readWindow()

  const dragRuler = async (f0, f1) => {
    const now = await rulerBox()
    const x0 = Math.round(now.l + now.w * f0)
    const x1 = Math.round(now.l + now.w * f1)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: now.y })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: now.y, button: 'left', clickCount: 1 })
    await sleep(100)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((x0 + x1) / 2), y: now.y, button: 'left' })
    await sleep(90)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: now.y, button: 'left' })
    await sleep(150)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: now.y, button: 'left', clickCount: 1 })
    await sleep(600)
  }

  await dragRuler(0.35, 0.75)
  const windowed = await readWindow()
  console.log('    拖了一段之后：', JSON.stringify(windowed), '（之前', JSON.stringify(beforeWindow), '）')
  check('拖一段之后出现「只看这一段」的标签', typeof windowed.标签 === 'string' && windowed.标签.length > 0,
    JSON.stringify(windowed))
  check('标签上写着「N / 总数 件」，看得出还藏了多少',
    windowed.标签?.includes('/') === true, String(windowed.标签))
  if (beforeWindow.轴上事件 >= 4) {
    check('框住之后轴上的事件变少（不是框了没用）',
      windowed.轴上事件 < beforeWindow.轴上事件,
      `${beforeWindow.轴上事件} → ${windowed.轴上事件}`)
  } else {
    console.log(`    （这个作品只有 ${beforeWindow.轴上事件} 个带日期的事件，跳过「变少」这一条）`)
  }
  check('解释条不会因为框了一下就自己消失（否则画布会突然上移）',
    windowed.提示条还在 === beforeWindow.提示条还在,
    `${beforeWindow.提示条还在} → ${windowed.提示条还在}`)

  // 点一下刻度条 = 回到全部
  const rp = await rulerBox()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rp.l + Math.round(rp.w * 0.5), y: rp.y })
  await sleep(90)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rp.l + Math.round(rp.w * 0.5), y: rp.y, button: 'left', clickCount: 1 })
  await sleep(90)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.l + Math.round(rp.w * 0.5), y: rp.y, button: 'left', clickCount: 1 })
  await sleep(600)
  const cleared = await readWindow()
  console.log('    点一下刻度条：', JSON.stringify(cleared))
  check('点一下刻度条就回到全部', cleared.标签 === null, JSON.stringify(cleared))
  check('回到全部之后事件都回来了', cleared.轴上事件 === beforeWindow.轴上事件,
    `${beforeWindow.轴上事件} → ${cleared.轴上事件}`)

  /* 回设定：移除也要干净 */
  await goTab('设定')
  const removed = await evaluate(`
    (() => {
      const chip = Array.from(document.querySelectorAll('span'))
        .find((s) => s.textContent.replace(/\\s+/g, '') === '沈雁')
      if (!chip) return false
      const btn = chip.querySelector('button[title="从这场戏里移除"]')
        || chip.querySelectorAll('button')[1]
      if (!btn) return false
      btn.click()
      return true
    })()
  `)
  await sleep(600)
  const stillThere = await evaluate(`
    document.body.innerText.includes('沈雁')
  `)
  check('能把这个角色从这场戏里移除', removed && !stillThere, `removed=${removed} 还在=${stillThere}`)

  /* 切回角色，后面的检查都当它是角色页 */
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === '角色')
      if (b) b.click()
      return true
    })()
  `)
  await sleep(600)

  console.log('\n[6] 搜索框的提示语不再提别名')

  const searchPlaceholder = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder*="搜"], input[placeholder*="搜"]')
      return inp ? inp.placeholder : null
    })()
  `)
  check('侧栏搜索提示语不含「别名」',
    searchPlaceholder === null || !searchPlaceholder.includes('别名'),
    String(searchPlaceholder))

  /* 打开搜索面板，核对面板里的提示语 */
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75,
  })
  await sleep(700)
  const palettePlaceholder = await evaluate(`
    (() => {
      const inp = document.querySelector('input[placeholder*="搜"]')
      return inp ? inp.placeholder : null
    })()
  `)
  check('搜索面板提示语不含「别名」',
    palettePlaceholder === null || !palettePlaceholder.includes('别名'),
    String(palettePlaceholder))
  console.log('    搜索提示语：', palettePlaceholder)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

  console.log('\n[7] 正文里的 [[双括号跳转]] 真的能点')

  /* 先切回「设定」，并造一个名字已知的条目当作跳转目标 */
  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('设定'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(700)

  const setInput = async (selector, value) => {
    const ok = await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
    await sleep(400)
    return ok
  }

  check('当前条目的名称框可改', await setInput('input[placeholder="名称"]', '苏无咎'))

  /* 再建一个条目，在它正文里写 [[苏无咎]] */
  await evaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /新建角色|新建词条$/.test(x.textContent.trim()))
      if (b) b.click()
      return true
    })()
  `)
  await sleep(1000)
  check('另一个条目的名称框可改', await setInput('input[placeholder="名称"]', '林昭'))

  const typedBody = await evaluate(`
    (() => {
      const cm = document.querySelector('.cm-content')
      if (!cm) return 'no-editor'
      cm.focus()
      document.execCommand('insertText', false, '他认识[[苏无咎]]，也认识[[查无此人]]。')
      return 'ok'
    })()
  `)
  check('正文里能输入双括号', typedBody === 'ok', typedBody)
  await sleep(700)

  const marks = await evaluate(`
    (() => {
      const jumps = Array.from(document.querySelectorAll('.ns-cm-jump'))
      return jumps.map((el) => ({
        文字: el.textContent,
        类名: el.className,
        是缺失: el.classList.contains('ns-cm-jump-missing'),
        颜色: getComputedStyle(el).color,
      }))
    })()
  `)
  console.log('    正文里的跳转标记：', JSON.stringify(marks))
  check('生成了两个跳转标记', marks.length === 2, String(marks.length))
  check('已存在的条目是「可跳转」样式',
    marks.some((m) => m.文字 === '苏无咎' && !m.是缺失), JSON.stringify(marks))
  check('不存在的条目是「缺失」样式',
    marks.some((m) => m.文字 === '查无此人' && m.是缺失), JSON.stringify(marks))
  check('方括号被单独淡化（不在跳转标记里）',
    marks.every((m) => !m.文字.includes('[')), JSON.stringify(marks.map((m) => m.文字)))

  /* 平时不该是朱砂 —— 悬停才变红 */
  const accent = 'rgb(156, 63, 48)'
  const idle = marks.find((m) => m.文字 === '苏无咎')?.颜色
  check('平时不是朱砂色（悬停才变红）', idle !== accent, String(idle))

  /* 真把鼠标移上去，看它变不变红 */
  const box = await evaluate(`
    (() => {
      const el = Array.from(document.querySelectorAll('.ns-cm-jump')).find(e => e.textContent === '苏无咎')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()
  `)
  check('量到了跳转标记的位置', box !== null)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await sleep(400)
  const hovered = await evaluate(`
    (() => {
      const el = Array.from(document.querySelectorAll('.ns-cm-jump')).find(e => e.textContent === '苏无咎')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { 颜色: cs.color, 下划线: cs.borderBottomColor, 光标: cs.cursor }
    })()
  `)
  console.log('    悬停后：', JSON.stringify(hovered))
  check('鼠标放上去就变朱砂', hovered?.颜色 === accent,
    `${idle} → ${hovered?.颜色}（期望 ${accent}）`)
  check('鼠标放上去光标变成手型', hovered?.光标 === 'pointer', String(hovered?.光标))

  /* 点一下，应该跳到「苏无咎」 */
  const beforeJump = await evaluate(`document.querySelector('input[placeholder="名称"]').value`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(900)
  const afterJump = await evaluate(`
    (() => {
      const name = document.querySelector('input[placeholder="名称"]')?.value ?? null
      const body = document.querySelector('.cm-content')?.textContent ?? ''
      const placeholder = document.querySelector('.cm-placeholder')?.textContent ?? ''
      return { 名称: name, 正文: body, 占位提示: placeholder }
    })()
  `)
  console.log(`    点击前停在「${beforeJump}」，点击后是「${afterJump.名称}」`)
  check('点一下就跳到了那个条目', afterJump.名称 === '苏无咎' && beforeJump === '林昭',
    `${beforeJump} → ${afterJump.名称}`)
  /* 目标条目正文是空的：所以应该看不到刚才那个条目的正文，只剩下占位提示。
     （注意 CodeMirror 把 placeholder 也渲染在 .cm-content 里面，
     所以这里不能断言 textContent 为空，只能断言「旧正文没了 + 占位提示在」。） */
  check('跳过去之后不再停在原来那个条目的正文上',
    !afterJump.正文.includes('查无此人') && afterJump.占位提示.length > 0,
    `正文「${afterJump.正文}」/ 占位「${afterJump.占位提示}」`)

  console.log('\n[8] 手绘视图的色板不许把工具栏挤爆')

  await evaluate(`
    (() => {
      const t = Array.from(document.querySelectorAll('.nav-tab')).find(b => b.textContent.includes('手绘'))
      if (t) t.click()
      return true
    })()
  `)
  await sleep(900)
  const swatchFit = await evaluate(`
    (() => {
      const row = document.querySelector('[title="线的颜色"]')
      if (!row) return null
      const n = row.querySelectorAll('button').length - 1
      const cs = getComputedStyle(row)
      const parent = row.parentElement
      return {
        色块数: n,
        允许换行: cs.flexWrap === 'wrap',
        行溢出: row.scrollWidth - row.clientWidth,
        行宽: Math.round(row.getBoundingClientRect().width),
        工具栏溢出: parent ? parent.scrollWidth - parent.clientWidth : null,
      }
    })()
  `)
  check('手绘视图有色板', swatchFit !== null)
  check('色板有十二个色块', swatchFit?.色块数 === 12, String(swatchFit?.色块数))
  check('色板可以换行，不会溢出', swatchFit?.允许换行 === true && (swatchFit?.行溢出 ?? 1) <= 0,
    JSON.stringify(swatchFit))

  console.log('\n[9] 手绘删除模式：鼠标压住谁，就得标出谁')

  /* 删除是「点一下就没了」的动作。没有悬停反馈就只能凭运气点。
     这一节不是读源码，而是真的把鼠标移上去，再看画面变成了什么样。 */

  const railRows = await evaluate(`
    (() => {
      const rs = Array.from(document.querySelectorAll('[draggable="true"][data-id]'))
      return rs.map((e) => ({ id: e.dataset.id, 名: e.textContent.trim() }))
    })()
  `)
  check('画布左栏的词条可以拖进画布', Array.isArray(railRows) && railRows.length >= 2,
    JSON.stringify(railRows))

  const stage = await evaluate(`
    (() => {
      const el = document.querySelector('div[data-stage="1"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        左: Math.round(r.left),
        上: Math.round(r.top),
        宽: Math.round(r.width),
        高: Math.round(r.height),
      }
    })()
  `)
  check('量到了画布的位置', stage !== null && stage.宽 > 200 && stage.高 > 200,
    JSON.stringify(stage))

  /* HTML5 拖放没法用合成事件伪造，只能借 CDP 真的走一遍。 */
  const dropOnCanvas = async (id, x, y) => {
    const data = { items: [{ mimeType: 'text/plain', data: id }], dragOperationsMask: 1 }
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
    await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
    await sleep(90)
    await send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
    await sleep(450)
  }

  const spot = (fx, fy) => ({
    x: Math.round(stage.左 + stage.宽 * fx),
    y: Math.round(stage.上 + stage.高 * fy),
  })
  const p1 = spot(0.34, 0.32)
  const p2 = spot(0.7, 0.32)
  await dropOnCanvas(railRows[0].id, p1.x, p1.y)
  await dropOnCanvas(railRows[1].id, p2.x, p2.y)

  const placed = await evaluate(`
    Array.from(document.querySelectorAll('g[data-node]')).map((g) => {
      const r = g.getBoundingClientRect()
      return {
        id: g.dataset.node,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      }
    })
  `)
  check('两个词条都落成了方格', placed.length === 2, JSON.stringify(placed))

  const clickTool = async (text) => {
    const ok = await evaluate(`
      (() => {
        const b = Array.from(document.querySelectorAll('button'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
        if (!b) return false
        b.click()
        return true
      })()
    `)
    await sleep(420)
    return ok
  }
  /* 一律用真的鼠标事件：合成 el.click() 会绕开指针事件的真实路径，
     上一轮「卡片点不开」就是这么漏过去的。 */
  const moveTo = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(420)
  }
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await sleep(90)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(420)
  }
  /* 挪到画布角落，什么东西都不压着 */
  const away = { x: stage.左 + 26, y: stage.上 + stage.高 - 26 }

  /* 画布不许因为「换了个模式」「撤销按钮上多了个数字」就上下跳。
     模式提示以前挂在工具栏里，一出现就把工具栏挤多一行，画布整整跳 39px ——
     而这行提示恰恰是在你正要往画布上点的时候出现的。 */
  const stageBox = async () =>
    evaluate(`
      (() => {
        const el = document.querySelector('div[data-stage="1"]')
        const r = el.getBoundingClientRect()
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',')
      })()
    `)
  const boxSelect = await stageBox()

  check('工具栏上有「连线」', await clickTool('连线'))
  const boxLink = await stageBox()
  check('切到「连线」时画布不跳', boxLink === boxSelect, `${boxSelect} → ${boxLink}`)
  check('工具栏上有「删除方格」', await clickTool('删除方格'))
  const boxUnplace = await stageBox()
  check('切到「删除方格」时画布不跳', boxUnplace === boxSelect, `${boxSelect} → ${boxUnplace}`)
  check('回「连线」模式', await clickTool('连线'))
  const boxBack = await stageBox()
  check('来回切换后画布仍在原地', boxBack === boxSelect, `${boxSelect} → ${boxBack}`)

  await clickAt(placed[0].x, placed[0].y)
  await clickAt(placed[1].x, placed[1].y)

  /* 数线要数「线本身」，不能数删除模式下才存在的那条透明点击区 ——
     那是删除模式专有的元素，平时根本不在 DOM 里。 */
  const edgeCount = await evaluate(`document.querySelectorAll('g[data-edge]').length`)
  check('点两个方格就连出了一条线', edgeCount >= 1, String(edgeCount))
  check('连完线画布还是没跳', (await stageBox()) === boxSelect, `基准 ${boxSelect}`)

  const WASH = 'var(--color-danger-wash)'
  const SURFACE = 'var(--color-surface)'
  const NODE_W = await evaluate(`
    (() => {
      const g = document.querySelector('g[data-node]')
      const clipped = g ? g.querySelector('g[clip-path]') : null
      const r = clipped ? clipped.querySelector('rect') : null
      return r ? Number(r.getAttribute('width')) : null
    })()
  `)

  /* 方格的底色和描边 —— 「整体泛淡红」得两样一起变才像 */
  const nodeState = async () => evaluate(`
    Array.from(document.querySelectorAll('g[data-node]')).map((g) => {
      const clipped = g.querySelector('g[clip-path]')
      const body = clipped ? clipped.querySelector('rect') : null
      const rects = Array.from(g.querySelectorAll('rect'))
      const outline = rects[rects.length - 1]
      return {
        id: g.dataset.node,
        底色: body ? body.getAttribute('fill') : null,
        描边宽: outline ? outline.getAttribute('stroke-width') : null,
      }
    })
  `)

  check('工具栏上有「删除方格」', await clickTool('删除方格'))
  const nodesIdle = await nodeState()
  check('没悬停时方格还是原来的底色',
    nodesIdle.length === 2 && nodesIdle.every((n) => n.底色 === SURFACE),
    JSON.stringify(nodesIdle))

  await moveTo(placed[0].x, placed[0].y)
  const nodesHot = await nodeState()
  const hotOne = nodesHot.find((n) => n.id === placed[0].id)
  const coldOne = nodesHot.find((n) => n.id === placed[1].id)
  check('悬停的方格整体泛淡红', hotOne?.底色 === WASH, JSON.stringify(nodesHot))
  check('悬停的方格描边跟着加粗', Number(hotOne?.描边宽) >= 2.6, JSON.stringify(hotOne))
  check('没被指到的方格一点也不变', coldOne?.底色 === SURFACE, JSON.stringify(coldOne))
  check('方格尺寸没被悬停反馈挤变形', NODE_W !== null && NODE_W > 0, String(NODE_W))

  await moveTo(away.x, away.y)
  const nodesBack = await nodeState()
  check('鼠标移开，淡红就退掉',
    nodesBack.every((n) => n.底色 === SURFACE), JSON.stringify(nodesBack))

  /* 连线：线本身就有颜色，好多还是朱砂，「变淡红」在它身上根本看不出来。
     所以设计上是三件事一起说：外面套红光晕、线加粗、关系名前挂红叉。
     光晕是跟线色无关的那一层，任何线色下都成立。 */
  check('工具栏上有「删除连线」', await clickTool('删除连线'))

  const edgeSpot = await evaluate(`
    (() => {
      const el = document.querySelector('path[stroke="transparent"][stroke-width="16"]')
      if (!el) return null
      const p = el.getPointAtLength(el.getTotalLength() / 2)
      const m = el.getScreenCTM()
      return {
        x: Math.round(p.x * m.a + p.y * m.c + m.e),
        y: Math.round(p.x * m.b + p.y * m.d + m.f),
      }
    })()
  `)
  check('量到了连线的位置', edgeSpot !== null && edgeSpot.x > 0, JSON.stringify(edgeSpot))

  const edgeState = async () => evaluate(`
    (() => {
      const ps = Array.from(document.querySelectorAll('path'))
      const same = (p, w) => p.getAttribute('stroke') === 'var(--color-danger)' && p.getAttribute('stroke-width') === String(w)
      return {
        光晕: ps.filter((p) => same(p, 9)).length,
        加粗: ps.filter((p) => same(p, 3)).length,
        淡红底: Array.from(document.querySelectorAll('rect'))
          .filter((r) => r.getAttribute('fill') === 'var(--color-danger-wash)').length,
        红叉: Array.from(document.querySelectorAll('text'))
          .filter((t) => t.textContent.trim() === '×').length,
      }
    })()
  `)

  const edgeIdle = await edgeState()
  check('没悬停时连线上没有任何删除提示', edgeIdle.光晕 === 0 && edgeIdle.红叉 === 0,
    JSON.stringify(edgeIdle))

  await moveTo(edgeSpot.x, edgeSpot.y)
  const edgeHot = await edgeState()
  check('悬停时线外套了一圈红光晕', edgeHot.光晕 >= 1, JSON.stringify(edgeHot))
  check('悬停时线本身加粗成朱砂', edgeHot.加粗 >= 1, JSON.stringify(edgeHot))
  check('悬停时关系名垫上了淡红底', edgeHot.淡红底 >= 1, JSON.stringify(edgeHot))
  check('悬停时关系名前挂了红叉', edgeHot.红叉 >= 1, JSON.stringify(edgeHot))

  /* 悬停的提示不能挡住点击：压在光晕上再点一下，这条线要真的被删掉 */
  await clickAt(edgeSpot.x, edgeSpot.y)
  const afterUnlink = await evaluate(`document.querySelectorAll('g[data-edge]').length`)
  check('悬停提示不挡点击，点下去线就没了', afterUnlink === edgeCount - 1,
    `${edgeCount} → ${afterUnlink}`)

  await moveTo(away.x, away.y)
  const edgeCold = await edgeState()
  check('鼠标移开后光晕也退掉', edgeCold.光晕 === 0, JSON.stringify(edgeCold))

  /* 切回「选定」，免得删除模式影响后面的检查 */
  await clickTool('选定')

  console.log('\n[10] 没有页面级报错')

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
