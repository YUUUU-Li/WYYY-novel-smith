/* ============================================================
   手工摆的时间线：竖着排，行由时间算，列由你摆

   为什么行是「算出来」的、横坐标是「存下来」的：
   事件的先后是事实，改不了也不该手改 —— 存一份「第几行」只会和
   date 打架，改一次时间就要动两个地方。
   而「这件事该画在左边还是右边」是作者的判断，程序猜不到，
   所以只有它能被拖、被记住。

   一条不变量：**一行 = 一个具体时间**（纪元+年+月+日，写到哪一级算到哪一级）。
   同一天发生的事落在同一行，这样「同行 = 同时间」才成立。
   ============================================================ */

import { dateToSortable, formatDateShort, formatRowDate } from './dates'
import type {
  CalendarSystem,
  Entity,
  Novel,
  TimelineBoard,
  TimelineGuide,
  TimelineItem,
} from './types'

/**
 * 老文件兼容 + 修坏数据。已经正常时**原样返回同一个数组**，
 * 这样它可以在每次读盘时放心调用，不会平白把整棵树换掉。
 */
export function normalizeBoards(project: { boards?: TimelineBoard[] }): TimelineBoard[] {
  const raw = Array.isArray(project.boards) ? project.boards : []
  let changed = !Array.isArray(project.boards)
  const out: TimelineBoard[] = []
  const seenBoards = new Set<string>()

  for (const b of raw) {
    if (!b || typeof b.id !== 'string' || seenBoards.has(b.id)) {
      changed = true
      continue
    }
    seenBoards.add(b.id)

    // 一格一个条目：同一个条目在板上出现两次没有意义
    const items: TimelineItem[] = []
    const seenItems = new Set<string>()
    if (!Array.isArray(b.items)) changed = true
    for (const it of Array.isArray(b.items) ? b.items : []) {
      if (!it || typeof it.entity !== 'string' || seenItems.has(it.entity)) {
        changed = true
        continue
      }
      seenItems.add(it.entity)
      const x = typeof it.x === 'number' && Number.isFinite(it.x) ? clamp01(it.x) : 0.5
      if (x !== it.x) changed = true
      items.push({ entity: it.entity, x })
    }

    const guides: TimelineGuide[] = []
    const seenGuides = new Set<string>()
    if (!Array.isArray(b.guides)) changed = true
    for (const g of Array.isArray(b.guides) ? b.guides : []) {
      if (!g || typeof g.id !== 'string' || seenGuides.has(g.id)) {
        changed = true
        continue
      }
      seenGuides.add(g.id)
      const name = typeof g.name === 'string' ? g.name : '列'
      if (name !== g.name) changed = true
      const x = typeof g.x === 'number' && Number.isFinite(g.x) ? clamp01(g.x) : 0.5
      if (x !== g.x) changed = true
      guides.push({ id: g.id, name, x })
    }

    const name = typeof b.name === 'string' && b.name.trim() ? b.name : '未命名时间线'
    if (name !== b.name) changed = true
    // width 是可选的：老文件没有这个字段就是「一屏宽」，不硬塞一个值进去
    const width = b.width === undefined ? undefined : clampBoardWidth(b.width)
    if (width !== b.width) changed = true
    out.push({ id: b.id, name, ...(width === undefined ? {} : { width }), guides, items })
  }

  return changed ? out : (project.boards as TimelineBoard[])
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** 板宽：1 = 正好一屏（不横向滚动），最多 6 屏 */
export const BOARD_MIN_WIDTH = 1
export const BOARD_MAX_WIDTH = 6
export const BOARD_WIDTH_STEP = 0.5

export function clampBoardWidth(n: number | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1
  return Math.max(BOARD_MIN_WIDTH, Math.min(BOARD_MAX_WIDTH, v))
}

/**
 * 把板子放宽/收窄。x 存的是归一化坐标，所以放宽等于放大画布 ——
 * 原来的相对位置全都不动，只是右边空出更多地方。
 */
export function setBoardWidth(board: TimelineBoard, width: number): TimelineBoard {
  return { ...board, width: clampBoardWidth(width) }
}

export function newBoard(name: string): TimelineBoard {
  return {
    id: `tb_${Math.random().toString(36).slice(2, 10)}`,
    name,
    width: 1,
    guides: [],
    items: [],
  }
}

/* ---------------- 行：按时间分组 ---------------- */

export interface BoardRow {
  /** 分组键：同一天得到同一个 key */
  key: string
  /** 完整短标签，如「天·421·麦·2」 */
  label: string
  /** 左边刻度分两行写：上行到年，下行到月/日 */
  head: string
  tail: string
  /** 用于排序的数值 */
  sort: number
  items: Array<{ entity: Entity; x: number }>
}

export interface BoardLayout {
  rows: BoardRow[]
  /** 还没填时间、所以落不到行上的那些（不丢，单独收着） */
  undated: Array<{ entity: Entity; x: number }>
  /** 板上有、但条目已经不存在的引用 */
  missing: number
}

/**
 * 把一个事件的时间折成「一行」的键。
 * 月份和日是可选的，所以「只知道年」和「知道到日」是两个不同的行 ——
 * 只能精确到年的那件事，本来就不该和某一天的事挤在同一行。
 */
export function dateRowKey(d: {
  era?: string
  year: number
  monthIndex?: number
  month?: string
  day?: number
}): string {
  const parts = [d.era ?? '', String(d.year)]
  if (d.monthIndex !== undefined) parts.push(`m${d.monthIndex}`)
  else if (d.month) parts.push(`M${d.month}`)
  if (d.day !== undefined) parts.push(`d${d.day}`)
  return parts.join('|')
}

export function boardLayout(
  novel: Novel,
  board: TimelineBoard,
  cal: CalendarSystem,
): BoardLayout {
  const byId = new Map(novel.entities.map((e) => [e.id, e]))
  const rows = new Map<string, BoardRow>()
  const undated: Array<{ entity: Entity; x: number }> = []
  let missing = 0

  for (const it of board.items) {
    const entity = byId.get(it.entity)
    if (!entity) {
      missing++
      continue
    }
    const d = entity.date
    if (!d) {
      undated.push({ entity, x: it.x })
      continue
    }
    const key = dateRowKey(d)
    const sort = dateToSortable(d, cal)
    /* 左边那格刻度分两行：上面到年，下面到月/日。
       走 formatRowDate 而不是 formatDateShort —— 后者在公元纪年下只给年份，
       那样同一年里的几行会显示成同一个「前293」，分不清。 */
    const { head, tail } = formatRowDate(d, cal)
    const label = [head, tail].filter(Boolean).join(' ')
    const row = rows.get(key)
    if (row) row.items.push({ entity, x: it.x })
    else {
      rows.set(key, {
        key,
        label,
        head,
        tail,
        sort,
        items: [{ entity, x: it.x }],
      })
    }
  }

  const sorted = Array.from(rows.values()).sort((a, b) => a.sort - b.sort)
  // 同一行里按横向位置排，渲染稳定
  for (const r of sorted) r.items.sort((a, b) => a.x - b.x)

  return { rows: sorted, undated, missing }
}

/** 这张板的整体时间：最早 → 最晚。dated=0 表示还没有一件排得上时间的事 */
export function boardSpan(
  novel: Novel,
  board: TimelineBoard,
  cal: CalendarSystem,
): { from: string | null; to: string | null; count: number; dated: number } {
  const byId = new Map(novel.entities.map((e) => [e.id, e]))
  let min: { sort: number; label: string } | null = null
  let max: { sort: number; label: string } | null = null
  let count = 0
  let dated = 0

  for (const it of board.items) {
    const e = byId.get(it.entity)
    if (!e) continue
    count++
    if (!e.date) continue
    dated++
    const sort = dateToSortable(e.date, cal)
    const label = formatDateShort(e.date, cal)
    if (!min || sort < min.sort) min = { sort, label }
    if (!max || sort > max.sort) max = { sort, label }
  }

  return { from: min?.label ?? null, to: max?.label ?? null, count, dated }
}

/* ---------------- 增删改（纯函数，返回新的板） ---------------- */

/** 往板上放一格。已经在板上就不动它（返回原数组，引用不变） */
export function addToBoard(board: TimelineBoard, entityId: string, x: number): TimelineBoard {
  if (board.items.some((i) => i.entity === entityId)) return board
  return { ...board, items: [...board.items, { entity: entityId, x: clamp01(x) }] }
}

export function removeFromBoard(board: TimelineBoard, entityId: string): TimelineBoard {
  if (!board.items.some((i) => i.entity === entityId)) return board
  return { ...board, items: board.items.filter((i) => i.entity !== entityId) }
}

export function moveOnBoard(board: TimelineBoard, entityId: string, x: number): TimelineBoard {
  const next = clamp01(x)
  return {
    ...board,
    items: board.items.map((i) => (i.entity === entityId ? { ...i, x: next } : i)),
  }
}

/**
 * 新放上去的一格摆在哪儿：往右错开，别叠在同行已有的格子上。
 * 一行里已经排满了就回到最左边 —— 叠着也比跑到板外面强。
 */
export function freeXOnRow(row: Array<{ x: number }>, step = 0.16): number {
  const used = row.map((i) => i.x).sort((a, b) => a - b)
  let x = 0.02
  for (const u of used) {
    if (Math.abs(u - x) < 0.06) x = u + step
  }
  return clamp01(x)
}

/* ---------------- 竖线（列） ---------------- */

export function addGuide(board: TimelineBoard, name: string, x: number): TimelineBoard {
  const guide = { id: `g_${Math.random().toString(36).slice(2, 8)}`, name, x: clamp01(x) }
  return { ...board, guides: [...board.guides, guide] }
}

export function updateGuide(
  board: TimelineBoard,
  id: string,
  patch: Partial<{ name: string; x: number }>,
): TimelineBoard {
  return {
    ...board,
    guides: board.guides.map((g) =>
      g.id === id
        ? { ...g, ...patch, x: patch.x === undefined ? g.x : clamp01(patch.x) }
        : g,
    ),
  }
}

export function removeGuide(board: TimelineBoard, id: string): TimelineBoard {
  return { ...board, guides: board.guides.filter((g) => g.id !== id) }
}
