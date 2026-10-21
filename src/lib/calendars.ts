/* ============================================================
   历法预设

   这里只有**数据**：几种纪时方法的现成模板。
   所有显示与排序逻辑都在 dates.ts，避免同一件事有两份实现。

   为什么要做成「预设 + 可改」而不是写死：
   同一个战国背景可以有两种合理的纪时方法 ——
   「公元前 287 年」现代读者最好懂，
   「秦昭襄王二十年」更贴当时人的说法。
   作者该能选，而不是被程序替他决定。
   ============================================================ */

import type { CalendarMonth, CalendarSystem } from './types'

/* ---------------- 农历十二个月 ---------------- */

/** 农历月名。闰月可以通过直接改 month 字段写「闰四月」表达 */
export const LUNAR_MONTHS: CalendarMonth[] = [
  { name: '正月', days: 29 },
  { name: '二月', days: 30 },
  { name: '三月', days: 29 },
  { name: '四月', days: 30 },
  { name: '五月', days: 29 },
  { name: '六月', days: 30 },
  { name: '七月', days: 29 },
  { name: '八月', days: 30 },
  { name: '九月', days: 29 },
  { name: '十月', days: 30 },
  { name: '冬月', days: 29 },
  { name: '腊月', days: 30 },
]

/** 通用月名，用于不强调农历的历法 */
export const NUMERIC_MONTHS: CalendarMonth[] = Array.from({ length: 12 }, (_, i) => ({
  name: `${i + 1} 月`,
  days: 30,
}))

/* ---------------- 预设 ---------------- */

export interface CalendarPreset {
  id: string
  label: string
  hint: string
  build: () => CalendarSystem
}

export const CALENDAR_PRESETS: CalendarPreset[] = [
  {
    id: 'lunar-bce',
    label: '农历 · 公元纪年',
    hint: '公元前 287 年 正月十三。有真实历史背景时最好懂',
    build: () => ({
      name: '农历',
      eraDisplay: 'none',
      yearDisplay: 'ce',
      eras: [{ name: '公元', abbr: '' }],
      eraOrder: ['公元'],
      eraSpans: [3000],
      months: LUNAR_MONTHS.map((m) => ({ ...m })),
    }),
  },
  {
    id: 'lunar-reign',
    label: '农历 · 王号纪年',
    hint: '秦昭襄王 20 年 正月十三。用诸侯国的王号纪年',
    build: () => ({
      name: '农历（王号纪年）',
      eraDisplay: 'suffix',
      eraLabel: '王',
      yearDisplay: 'plain',
      eras: [
        { name: '秦', abbr: '秦' },
        { name: '楚', abbr: '楚' },
        { name: '齐', abbr: '齐' },
        { name: '燕', abbr: '燕' },
        { name: '赵', abbr: '赵' },
        { name: '魏', abbr: '魏' },
        { name: '韩', abbr: '韩' },
        { name: '周', abbr: '周' },
      ],
      eraOrder: ['周', '秦', '楚', '齐', '燕', '赵', '魏', '韩'],
      eraSpans: [900, 600, 800, 700, 800, 700, 600, 500],
      months: LUNAR_MONTHS.map((m) => ({ ...m })),
    }),
  },
  {
    id: 'plain-bce',
    label: '公历 · 只记年',
    hint: '公元前 287 年。不需要月份，只要一个时间点',
    build: () => ({
      name: '公历',
      eraDisplay: 'none',
      yearDisplay: 'ce',
      eras: [{ name: '公元', abbr: '' }],
      eraOrder: ['公元'],
      eraSpans: [3000],
      months: NUMERIC_MONTHS.map((m) => ({ ...m })),
    }),
  },
  {
    id: 'fictional',
    label: '虚构纪元',
    hint: '天和 421 年 霜月。完全自定义的纪元与月名',
    build: () => ({
      name: '自定义历',
      eraDisplay: 'fictional',
      yearDisplay: 'plain',
      eras: [{ name: '第一纪元', abbr: 'E1' }],
      eraOrder: ['第一纪元'],
      eraSpans: [1000],
      months: NUMERIC_MONTHS.map((m) => ({ ...m })),
    }),
  },
]

/** 按 id 取预设 */
export function presetById(id: string): CalendarPreset | undefined {
  return CALENDAR_PRESETS.find((p) => p.id === id)
}
