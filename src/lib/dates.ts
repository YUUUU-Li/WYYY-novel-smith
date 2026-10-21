/* ============================================================
   世界内时间：记法、格式化与排序

   这是所有日期显示的**唯一真相来源**。任何地方要显示世界内时间
   都必须走这里的函数，否则同一个日期会出现两种说法。

   为什么不用 Date：
   「公元前 287 年 正月十三」和「天和 421 年 霜月」这两种东西，
   Date 都表达不了。现实世界的闰年、时区、纪元切换对故事全是噪音。
   我们只需要两件事：按世界内顺序排序，按世界内习惯显示。

   ---------- 两种「纪时方法」怎么统一 ----------

   同一份数据形状（纪元 + 年 + 月 + 日）支持完全不同的说法，
   靠两个开关切换：

     eraDisplay  纪元怎么出现
       fictional  虚构年号      →「天和 421 年」
       prefix     前缀式        →「公元前 287 年」
       suffix     后缀式        →「20 年 秦」（王号纪年）
       none       不出现纪元    →「公元前 287 年」（符号由年份负责）

     yearDisplay 年份怎么出现
       plain      直接写数字
       ce         正数写「公元 N 年」，负数写「公元前 N 年」

   ---------- 符号约定（很重要）----------

   year 存的是**带符号的数值年**：公元前 287 年存 -287，公元 287 年存 287。
   这样排序天然正确，不必在显示层做符号转换。
   「前」这个字由 yearDisplay 负责，作者不用逐年手打。

   ---------- 纪元与排序 ----------

   虚构历法里可能有多个年号（如「昭元」「天和」），它们有先后顺序。
   eraSpans 给每个纪元一个年数上限，用来把不同年号对齐到统一时间轴。
   ============================================================ */

import type { CalendarSystem, NovelDate } from './types'

/* ---------------- 显示开关的读取（兼容老数据）---------------- */

export function eraDisplayOf(cal: CalendarSystem): NonNullable<CalendarSystem['eraDisplay']> {
  return cal.eraDisplay ?? 'fictional'
}

export function yearDisplayOf(cal: CalendarSystem): NonNullable<CalendarSystem['yearDisplay']> {
  return cal.yearDisplay ?? 'plain'
}

/** 界面上是否需要出现「纪元」这个选择器。none 模式整个控件都该隐藏 */
export function hasEraPicker(cal: CalendarSystem): boolean {
  return eraDisplayOf(cal) !== 'none'
}

/** 这个历法是否用公元纪年（用于决定要不要提示「公元前填负数」） */
export function isCommonEra(cal: CalendarSystem): boolean {
  return yearDisplayOf(cal) === 'ce'
}

/* ---------------- 格式化 ---------------- */

/** 年份，如「公元前 287 年」「公元 287 年」「421 年」 */
export function formatYear(year: number, cal: CalendarSystem): string {
  if (yearDisplayOf(cal) === 'ce') {
    return year < 0 ? `公元前 ${Math.abs(year)} 年` : `公元 ${year} 年`
  }
  return `${year} 年`
}

/** 紧凑年份。「前287」比「-287」清楚，也省宽度 */
export function formatYearShort(year: number, cal: CalendarSystem): string {
  if (yearDisplayOf(cal) === 'ce' && year < 0) return `前${Math.abs(year)}`
  return String(year)
}

/** 纪元部分。none 模式返回空，因为符号已经由年份表达 */
function formatEra(d: NovelDate, cal: CalendarSystem): string {
  const mode = eraDisplayOf(cal)
  if (mode === 'none') return ''
  const eraName = d.era ?? cal.eras[0]?.name ?? ''
  if (!eraName) return ''
  if (mode === 'fictional') return eraName
  if (mode === 'prefix') return cal.eraLabel ?? eraName
  return '' // suffix 由调用方拼在年份后面
}

/** 中文日名：1 → 初一，13 → 十三，21 → 廿一，30 → 三十 */
export function dayLabel(day: number): string {
  const ones = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  if (day <= 0) return `${day}`
  if (day <= 10) return day === 10 ? '初十' : `初${ones[day]}`
  if (day < 20) return `十${ones[day - 10]}`
  if (day === 20) return '二十'
  if (day < 30) return `廿${ones[day - 20]}`
  if (day === 30) return '三十'
  return `${day}`
}

/**
 * 时间线刻度专用：分成「上面写年、下面写月日」两截，年份写成日期该有的样子。
 *
 * 为什么不直接用 formatDateShort：它在公元纪年下**只给年份**
 * （列表和坐标轴上那样写是对的，省地方）。可时间线上的一行就是一整行时间，
 * 同一年里三月的两件事和七月的一件事要是都写成「前293」，你分不清哪行是哪行。
 * 所以这里一定把月日带上，并且给年份补一个「年」字 —— 光秃秃的数字
 * 在左边那栏看起来像编号，不像时间。
 */
export function formatRowDate(
  d: NovelDate,
  cal: CalendarSystem,
): { head: string; tail: string } {
  const mode = eraDisplayOf(cal)
  const short = formatYearShort(d.year, cal)

  let head: string
  if (mode === 'fictional') {
    const era = d.era ? cal.eras.find((e) => e.name === d.era) : undefined
    const abbr = era ? era.abbr : (d.era ?? '')
    head = abbr ? `${abbr}·${short}` : short
  } else if (mode === 'suffix') {
    head = [short, d.era].filter(Boolean).join(' ')
  } else if (mode === 'prefix') {
    head = `${cal.eraLabel ?? d.era ?? ''}${short}`
  } else {
    // 无纪元：靠年份自己说话（公元 / 公元前）
    head = isCommonEra(cal) ? `${short} 年` : short
  }

  const monthName =
    d.month ?? (d.monthIndex !== undefined ? cal.months[d.monthIndex]?.name : '')
  const tail = [monthName, d.day !== undefined ? dayLabel(d.day) : ''].filter(Boolean).join(' ')

  return { head, tail }
}

/** 完整显示：公元前 287 年 正月 十三 ／ 天和 421 年 霜月 12 日 */
export function formatDate(d: NovelDate | undefined, cal: CalendarSystem): string {
  if (!d) return '未定'
  const mode = eraDisplayOf(cal)
  const year = formatYear(d.year, cal)
  const month =
    d.month ?? (d.monthIndex !== undefined ? cal.months[d.monthIndex]?.name : '') ?? ''
  const day = d.day !== undefined ? dayLabel(d.day) : ''

  // suffix 模式：纪元名跟在最后，如「20 年 正月 十三 秦」
  if (mode === 'suffix') {
    const era = d.era ?? cal.eras[0]?.name ?? ''
    return [year, month, day, era].filter(Boolean).join(' ')
  }

  const era = formatEra(d, cal)
  return [era, year, month, day].filter(Boolean).join(' ')
}

/** 紧凑显示，用于列表与时间线刻度 */
export function formatDateShort(d: NovelDate | undefined, cal: CalendarSystem): string {
  if (!d) return '未定'
  const mode = eraDisplayOf(cal)
  const yearPart = formatYearShort(d.year, cal)

  // 无纪元 + 公元纪年：只给年份就够，加了月度反而吵
  if (mode === 'none' && yearDisplayOf(cal) === 'ce') return yearPart

  const parts: string[] = []
  if (mode === 'fictional' && d.era) {
    const era = cal.eras.find((e) => e.name === d.era)
    parts.push(era ? era.abbr : d.era)
  } else if (mode === 'suffix' && d.era) {
    parts.push(d.era)
  }
  parts.push(yearPart)

  const monthName =
    d.month ??
    (d.monthIndex !== undefined ? cal.months[d.monthIndex]?.name : undefined)
  if (monthName) parts.push(monthName.slice(0, 1))
  if (d.day !== undefined && monthName) parts.push(String(d.day))
  return parts.join('·')
}

/* ---------------- 排序 ---------------- */

/**
 * 把世界内日期压成一个可比较的数值。
 *
 * 因为 year 本身带符号，排序天然正确 —— 这正是「存储里带符号」的好处。
 * 纪元也参与排序：同一个世界里可能同时存在多个年号序列。
 */
export function dateToSortable(d: NovelDate, cal: CalendarSystem): number {
  const eraIdx = d.era ? Math.max(0, cal.eraOrder.indexOf(d.era)) : 0
  const eraSpan = cal.eraSpans?.[eraIdx] ?? 1000
  // 每个纪元给足够跨度，避免跨纪元时年份进位串档
  const ERA_SPAN = eraSpan * 2 + 100_000

  const monthIdx =
    d.monthIndex !== undefined
      ? d.monthIndex
      : d.month
        ? Math.max(0, cal.months.findIndex((m) => m.name === d.month))
        : 0

  return (
    eraIdx * ERA_SPAN +
    d.year * 1000 +
    (monthIdx || 0) * 32 +
    (d.day ?? 0) +
    (d.order ?? 0) * 0.001
  )
}

export function compareDates(
  a: NovelDate | undefined,
  b: NovelDate | undefined,
  cal: CalendarSystem,
): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return dateToSortable(a, cal) - dateToSortable(b, cal)
}

/* ---------------- 换历法时的时间清理 ---------------- */

/**
 * 换纪时方法时清理一个时间点：只留年份。
 *
 * 为什么必须清：旧纪元名在新历法里不存在，月名也对不上
 * （「霜月」在农历里没有对应）。留着会显示出怪东西，
 * 而作者不一定能立刻发现。
 *
 * 为什么保留年份：它是唯一可能仍然有意义的字段，
 * 而且作者已经为它付出过输入成本。
 *
 * 抽成独立函数是为了能单独测 —— 这段逻辑出错会静默改坏几十条数据。
 */
export function stripForNewCalendar(d: NovelDate | undefined): NovelDate | undefined {
  if (!d) return undefined
  return { year: d.year }
}

/** 大纲节点上的时间也要一起清理（递归） */
export function stripOutlineDates<
  T extends { date?: NovelDate; children: T[] },
>(nodes: T[]): T[] {
  return nodes.map((n) => ({
    ...n,
    date: stripForNewCalendar(n.date),
    children: stripOutlineDates(n.children),
  }))
}

/* ---------------- 刻度 ---------------- */

export interface Tick {
  value: number
  label: string
}

/**
 * 时间线坐标轴的刻度。
 * 跨纪元时按纪元切；年内按年切。
 * 公元纪年下刻度显示成「前300 / 200 / 100」这种紧凑写法。
 */
export function buildTicks(
  dates: NovelDate[],
  cal: CalendarSystem,
  maxTicks = 8,
): Tick[] {
  if (dates.length === 0) return []
  const values = dates.map((d) => dateToSortable(d, cal))
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) {
    return [{ value: min, label: formatDateShort(dates[0], cal) }]
  }

  const mode = eraDisplayOf(cal)
  const span = max - min

  // 多纪元的虚构历法：刻度落在纪元边界上
  if (mode === 'fictional' && cal.eras.length > 1) {
    const eraIdxSpan = (cal.eraSpans?.[0] ?? 1000) * 2 + 100_000
    if (span > eraIdxSpan * 0.8) {
      const startEra = Math.floor(min / eraIdxSpan)
      const endEra = Math.floor(max / eraIdxSpan)
      const ticks: Tick[] = []
      for (let i = startEra; i <= endEra; i++) {
        const era = cal.eras[i]
        ticks.push({
          value: i * eraIdxSpan,
          label: era ? era.name : `纪元 ${i + 1}`,
        })
      }
      return ticks
    }
  }

  // 其余情况按年切
  const minYear = Math.floor(min / 1000) - 1
  const maxYear = Math.ceil(max / 1000) + 1
  const yearCount = Math.max(1, maxYear - minYear)
  const step = Math.max(1, Math.ceil(yearCount / maxTicks))
  const ticks: Tick[] = []
  for (let y = minYear; y <= maxYear; y += step) {
    const sample = dates.find((d) => d.year === y)
    const prefix =
      mode === 'fictional' && sample?.era
        ? (cal.eras.find((e) => e.name === sample.era)?.abbr ?? '')
        : ''
    ticks.push({
      value: y * 1000,
      label: `${prefix}${formatYearShort(y, cal)}`,
    })
  }
  return ticks
}
