/* ============================================================
   纪时方法：显示、排序与切换

   防的是三件事：
   1. 「公元前 287 年」显示成「公元 -287 年」—— 符号没翻译
   2. 跨公元前后排序错误 —— 年份符号没参与排序
   3. 换历法时把已有时间改坏 —— 这是最难发现的一类问题

   跑法：由 npm test 统一触发
   ============================================================ */

import {
  buildTicks,
  dateToSortable,
  dayLabel,
  eraDisplayOf,
  formatDate,
  formatDateShort,
  formatYear,
  hasEraPicker,
  isCommonEra,
  stripForNewCalendar,
  stripOutlineDates,
  yearDisplayOf,
} from '../src/lib/dates.ts'
import { CALENDAR_PRESETS, LUNAR_MONTHS, presetById } from '../src/lib/calendars.ts'
import type { CalendarSystem, NovelDate } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

const lunar = presetById('lunar-bce')!.build()
const reign = presetById('lunar-reign')!.build()
const fictional = presetById('fictional')!.build()

/* ============================================================
   1. 公元纪年：公元前 287 年
   ============================================================ */

console.log('\n[1] 公元纪年（用户要的那种）')

{
  // 用户明确要的写法
  const d: NovelDate = { year: -287, monthIndex: 0, day: 13 }
  check('显示成「公元前 287 年 正月 十三」',
    formatDate(d, lunar) === '公元前 287 年 正月 十三',
    formatDate(d, lunar))

  // 公元后的年份
  const ad: NovelDate = { year: 287, monthIndex: 0, day: 13 }
  check('正数显示成「公元」', formatDate(ad, lunar) === '公元 287 年 正月 十三', formatDate(ad, lunar))

  // 关键：不能出现「公元 -287 年」
  check('负数不会被显示成「公元 -287 年」',
    !formatDate(d, lunar).includes('-'),
    formatDate(d, lunar))
  check('负数带「公元前」字样', formatDate(d, lunar).includes('公元前'))

  check('年份单独格式化也对', formatYear(-287, lunar) === '公元前 287 年', formatYear(-287, lunar))
  check('紧凑写法用「前287」', formatDateShort(d, lunar) === '前287', formatDateShort(d, lunar))
  check('紧凑写法不带负号', !formatDateShort(d, lunar).includes('-'))
}

{
  // 这个历法不需要纪元选择器
  check('公元纪年不需要纪元选择器', hasEraPicker(lunar) === false)
  check('识别为公元纪年', isCommonEra(lunar) === true)
  check('显示开关读取正确', eraDisplayOf(lunar) === 'none' && yearDisplayOf(lunar) === 'ce')
}

/* ============================================================
   2. 排序：跨公元前后必须正确
   ============================================================ */

console.log('\n[2] 跨公元前后的排序')

{
  const bce300: NovelDate = { year: -300 }
  const bce287: NovelDate = { year: -287 }
  const ad100: NovelDate = { year: 100 }
  const ad287: NovelDate = { year: 287 }

  const xs = [ad287, bce300, ad100, bce287].map((d) => ({
    d,
    v: dateToSortable(d, lunar),
  }))
  xs.sort((a, b) => a.v - b.v)
  const order = xs.map((x) => x.d.year)
  check('排序为 前300 → 前287 → 100 → 287',
    JSON.stringify(order) === JSON.stringify([-300, -287, 100, 287]),
    JSON.stringify(order))

  check('公元前 300 排在公元前 287 之前',
    dateToSortable(bce300, lunar) < dateToSortable(bce287, lunar))
  check('公元前 287 排在公元 100 之前',
    dateToSortable(bce287, lunar) < dateToSortable(ad100, lunar))
}

/* ============================================================
   3. 王号纪年：20 年 秦
   ============================================================ */

console.log('\n[3] 王号纪年')

{
  const d: NovelDate = { era: '秦', year: 20, monthIndex: 0, day: 13 }
  check('纪元名跟在最后', formatDate(d, reign).endsWith('秦'), formatDate(d, reign))
  check('能显示年与月日', formatDate(d, reign).includes('20 年') && formatDate(d, reign).includes('正月'),
    formatDate(d, reign))
  check('王号纪年需要纪元选择器', hasEraPicker(reign) === true)
  check('不算公元纪年', isCommonEra(reign) === false)
}

{
  // 不同诸侯国的同一年，排序应该按 eraOrder 分开
  const qin: NovelDate = { era: '秦', year: 20 }
  const chu: NovelDate = { era: '楚', year: 20 }
  check('周在秦之前（按 eraOrder）',
    dateToSortable({ era: '周', year: 1 }, reign) < dateToSortable(qin, reign))
  check('秦与楚同年但排序不同',
    dateToSortable(qin, reign) !== dateToSortable(chu, reign),
    `${dateToSortable(qin, reign)} vs ${dateToSortable(chu, reign)}`)
}

/* ============================================================
   4. 虚构纪元仍然照旧
   ============================================================ */

console.log('\n[4] 虚构纪元不受影响')

{
  const d: NovelDate = { era: '第一纪元', year: 421, monthIndex: 0, day: 12 }
  check('虚构历法仍是「纪元 + 年 + 月 + 日」',
    formatDate(d, fictional).startsWith('第一纪元'),
    formatDate(d, fictional))
  check('虚构历法不带「公元」字样', !formatDate(d, fictional).includes('公元'))
  check('虚构历法需要纪元选择器', hasEraPicker(fictional) === true)
}

{
  // 老数据没有 eraDisplay / yearDisplay 字段，要按虚构历法处理
  const legacy: CalendarSystem = {
    name: '老历法',
    eras: [{ name: '天和', abbr: '天' }],
    eraOrder: ['天和'],
    months: [{ name: '霜月', days: 30 }],
  }
  check('老数据缺 eraDisplay 时按虚构处理', eraDisplayOf(legacy) === 'fictional')
  check('老数据缺 yearDisplay 时按 plain 处理', yearDisplayOf(legacy) === 'plain')
  check('老数据仍能正常显示',
    formatDate({ era: '天和', year: 421, month: '霜月', day: 12 }, legacy).includes('天和'),
    formatDate({ era: '天和', year: 421, month: '霜月', day: 12 }, legacy))
  check('老数据仍能正常排序', Number.isFinite(dateToSortable({ era: '天和', year: 421 }, legacy)))
}

/* ============================================================
   5. 中文日名
   ============================================================ */

console.log('\n[5] 中文日名')

{
  const cases: Array<[number, string]> = [
    [1, '初一'],
    [5, '初五'],
    [10, '初十'],
    [11, '十一'],
    [13, '十三'],
    [19, '十九'],
    [20, '二十'],
    [21, '廿一'],
    [25, '廿五'],
    [29, '廿九'],
    [30, '三十'],
  ]
  for (const [n, want] of cases) {
    check(`${n} → ${want}`, dayLabel(n) === want, dayLabel(n))
  }
  check('非法值不崩溃', typeof dayLabel(0) === 'string' && typeof dayLabel(-5) === 'string')
}

/* ============================================================
   6. 切换历法时数据不能被改坏
   ============================================================ */

console.log('\n[6] 换历法时的时间清理')

{
  const full: NovelDate = { era: '天和', year: 421, month: '霜月', monthIndex: 10, day: 12, order: 0.5 }
  const stripped = stripForNewCalendar(full)
  check('只保留年份', stripped?.year === 421, JSON.stringify(stripped))
  check('纪元被清掉', stripped?.era === undefined)
  check('月份被清掉（月名与索引都清）',
    stripped?.month === undefined && stripped?.monthIndex === undefined,
    JSON.stringify(stripped))
  check('日被清掉', stripped?.day === undefined)
  check('order 被清掉', stripped?.order === undefined)

  check('没时间时返回 undefined', stripForNewCalendar(undefined) === undefined)

  // 关键：不能返回带一堆 undefined 字段的对象，
  // 否则序列化时会写出空字段，让文件变脏
  const keys = Object.keys(stripped ?? {})
  check('结果只含 year 一个字段', keys.length === 1 && keys[0] === 'year', keys.join(','))
}

{
  // 大纲节点递归清理
  const outline = [
    {
      id: 'o1',
      date: { era: '天和', year: 421, month: '霜月' } as NovelDate,
      children: [
        {
          id: 'o2',
          date: { era: '昭元', year: 27, month: '雁月' } as NovelDate,
          children: [],
        },
      ],
    },
  ]
  const cleaned = stripOutlineDates(outline)
  check('顶层节点的时间被清理', cleaned[0].date?.year === 421 && cleaned[0].date?.month === undefined)
  check('子节点的时间也被清理（递归生效）',
    cleaned[1 - 1].children[0].date?.year === 27 &&
      cleaned[0].children[0].date?.month === undefined,
    JSON.stringify(cleaned[0].children[0].date))
  check('没有时间的节点不受影响', stripOutlineDates([{ id: 'x', children: [] }])[0].date === undefined)
}

/* ============================================================
   7. 预设与月名
   ============================================================ */

console.log('\n[7] 历法预设')

{
  check('有四个预设', CALENDAR_PRESETS.length === 4, String(CALENDAR_PRESETS.length))
  check('预设 id 唯一', new Set(CALENDAR_PRESETS.map((p) => p.id)).size === 4)
  for (const p of CALENDAR_PRESETS) {
    const c = p.build()
    check(`预设「${p.label}」有月名`, c.months.length > 0)
    check(`预设「${p.label}」有纪元顺序`, c.eraOrder.length > 0)
    check(`预设「${p.label}」每个纪元都有跨度`,
      c.eraSpans !== undefined && c.eraSpans.length === c.eraOrder.length,
      `${c.eraSpans?.length} vs ${c.eraOrder.length}`)
  }

  // 两个 build() 必须独立，不能共享同一个数组（否则改一个会影响另一个）
  const a = presetById('lunar-bce')!.build()
  const b = presetById('lunar-bce')!.build()
  a.months[0].name = '改过了'
  check('两次 build 出来的历法互不影响',
    b.months[0].name === LUNAR_MONTHS[0].name,
    b.months[0].name)
  check('模板本身也没被改坏', LUNAR_MONTHS[0].name === '正月', LUNAR_MONTHS[0].name)
  check('正月在第一位', LUNAR_MONTHS[0].name === '正月')
  check('腊月在最后一位', LUNAR_MONTHS[11].name === '腊月')
}

/* ============================================================
   8. 时间线刻度
   ============================================================ */

console.log('\n[8] 时间线刻度')

{
  const dates: NovelDate[] = [
    { year: -300 },
    { year: -287 },
    { year: -250 },
    { year: -200 },
  ]
  const ticks = buildTicks(dates, lunar, 8)
  check('能生成刻度', ticks.length > 0, String(ticks.length))
  check('刻度标签用「前N」写法',
    ticks.some((t) => t.label.startsWith('前')),
    ticks.map((t) => t.label).join(' '))
  check('刻度标签不带负号',
    ticks.every((t) => !t.label.includes('-')),
    ticks.map((t) => t.label).join(' '))
  check('刻度值递增', ticks.every((t, i) => i === 0 || t.value > ticks[i - 1].value))
}

{
  // 单一年份不该崩，也不该产生一堆重复刻度
  const ticks = buildTicks([{ year: -287 }], lunar)
  check('只有一个日期时不崩溃', Array.isArray(ticks))
  check('只有一个日期时只给一个刻度', ticks.length === 1, String(ticks.length))
  check('没有日期时不产生刻度', buildTicks([], lunar).length === 0)
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：纪时方法可切换，显示与排序正确，切换不会改坏数据。')
  process.exit(0)
}
console.log('结论：纪时方法的行为不符合预期。')
process.exit(1)
