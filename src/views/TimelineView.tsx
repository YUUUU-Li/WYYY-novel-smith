/* ============================================================
   时间线：同一份数据的两种画法

   为什么有两种模式：
   「事件轴」回答「故事按顺序发生了什么」——一条线，先后关系一目了然。
   「轨道」回答「同一时期各地在发生什么」——事件轴上永远不会显示
   「粮道断绝的那天，云京正在做什么」，因为那天云京没有事件。
   轨道模式用空白本身说话：某一时期某一行空着，就是剧情缺口。
   作者真正需要的是后者，所以轨道是本视图的重点。

   为什么一切位置都来自 dateToSortable 而不是 Date：
   这个世界观用的是天和历（昭元 / 天和两纪元，霜月雪月雁月十二月）。
   Date 表达不了「昭元二十七年霜降月八日」，也排不了跨纪元的序。
   所以整条轴的长度单位是 dateToSortable 的返回值，只保证顺序与相对
   距离，不承诺与现实时间成比例——虚构历法本来也不需要成比例。

   为什么 hover 浮层用 ref 改 transform 而不是 state：
   浮层要跟着鼠标走，但 mousemove 每帧都 setState 会让上百个事件
   重新渲染。所以位置只在 DOM 上写，React 只负责「悬停的是谁」。
   ============================================================ */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ArrowsHorizontal,
  CalendarBlank,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  ListBullets,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MapPin,
  Plus,
  Rows,
  UsersThree,
  X,
} from '@phosphor-icons/react'
// 契约里这个 hook 叫 useNovel；store 目前导出的标识符是 useStore，别名过来即可。
import { useStore as useNovel } from '../store/useNovel'
import {
  ENTITY_META,
  type CalendarSystem,
  type Entity,
  type NovelDate,
} from '../lib/types'
import { buildTicks, dateToSortable, formatDate, formatDateShort, formatYearShort } from '../lib/dates'
import { castOf, entitiesByDate } from '../lib/index-builder'
import { resolvePlace } from '../lib/places'
import { Empty, SectionLabel, TypeChip, TypeDot } from '../components/ui'
import { PresenceMatrix } from '../components/PresenceMatrix'
import { clamp, cx, scale } from '../lib/util'

/* ============================================================
   几何常量：全部来自设计 token 的语义，不是随手填的数
   ============================================================ */

/** 轴左右留白，让第一个和最后一个事件不贴边 */
const PAD_X = 26
/** 事件轴上每一层错开的高度 */
const ROW_H = 46
/** 轨道每一行的基础高度（要装得下两个错位子行） */
const LANE_TOP = 40
/** 轨道内两个子行的纵向偏移，用于同地点同时期的错开 */
const SUB_ROW_TOP = [4, 21]
/** 轨道展开后每个角色标签占的高度 */
const LANE_CHAR_H = 22
/** 左侧地点名列宽，横向滚动时这列钉住 */
const LABEL_W = 188
/** 顶部刻度条高度 */
const HEAD_H = 30

type Mode = 'axis' | 'lanes' | 'presence'

interface Placed {
  entity: Entity
  x1: number
  x2: number
  row: number
}

/* ============================================================
   纯函数
   ============================================================ */

/** 估算文本像素宽：中文按全宽、拉丁按半宽。只用于「标签会不会撞上」的判断 */
function estimateTextWidth(text: string, size = 12.5): number {
  let w = 0
  for (const ch of text) {
    w += /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? size : size * 0.56
  }
  return w
}

/** 刻度标签里没有数字的就是纪元名——纪元边界值得用强调色标出来 */
function isEraLabel(label: string): boolean {
  return !/[0-9]/.test(label)
}

/**
 * 贪心分层：时间上挨得太近的事件上下错开，而不是叠成一团。
 * maxRows 给 2 是轨道模式（行高有限），给很大是事件轴（宁可加层也不重叠）。
 */
function assignRows<T extends { x1: number; x2: number }>(
  items: T[],
  gap: number,
  maxRows: number,
): Array<T & { row: number }> {
  const ends: number[] = []
  return items.map((it) => {
    let row = ends.findIndex((end) => end <= it.x1 - gap)
    if (row === -1) {
      if (ends.length < maxRows) {
        row = ends.length
        ends.push(0)
      } else {
        // 层数到顶：放进最早空出来的那一层，接受一点重叠也不让行高失控
        row = ends.indexOf(Math.min(...ends))
      }
    }
    ends[row] = Math.max(it.x2, it.x1 + 4)
    return { ...it, row }
  })
}

/* ============================================================
   视图
   ============================================================ */

export function TimelineView() {
  const novel = useNovel((s) => s.novel)
  const index = useNovel((s) => s.index)
  const selectedId = useNovel((s) => s.selectedId)
  const select = useNovel((s) => s.select)
  const addEntity = useNovel((s) => s.addEntity)

  // 默认进事件轴：它是时间线的常识形态，轨道是加值而不是门槛
  const [mode, setMode] = useState<Mode>('axis')
  const [showUndated, setShowUndated] = useState(false)
  const [zoom, setZoom] = useState(1)
  /**
   * 时间窗：只看某一段。事件一多，整条轴会把早年挤成一条缝 ——
   * 与其再把「密度」变成更高的楼，不如让人自己框住要看的那一段。
   * 存的是世界内可排序值（和 x 轴同一套坐标），不是像素。
   */
  const [win, setWin] = useState<{ a: number; b: number } | null>(null)
  /** 正在拖的那一段（松手才生效） */
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  /** 「刻度条可以拖」这件事光看图猜不出来，第一次进来解释一遍 */
  const [rangeHint, setRangeHint] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [viewW, setViewW] = useState(720)

  const roRef = useRef<ResizeObserver | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const tipSize = useRef({ w: 0, h: 0 })
  // 布局完成前就收到了 mousemove 时，用它补一次定位
  const lastPt = useRef<{ x: number; y: number } | null>(null)

  /** 缩放基准是「当前可视宽度」，所以要量容器而不是量窗口 */
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    setViewW(el.clientWidth)
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    roRef.current = ro
  }, [])

  const cal: CalendarSystem | null = novel?.project.calendar ?? null

  /* ---------------- 数据切分 ---------------- */

  const events = useMemo(
    () => (novel ? novel.entities.filter((e) => e.type === 'event') : []),
    [novel],
  )
  // entitiesByDate 已经做过世界内排序，这里只挑事件
  const dated = useMemo(
    () => (novel ? entitiesByDate(novel).filter((e) => e.type === 'event' && e.date) : []),
    [novel],
  )
  const undated = useMemo(() => events.filter((e) => !e.date), [events])

  const byId = useMemo(() => {
    if (index) return index.byId
    return new Map<string, Entity>(novel ? novel.entities.map((e) => [e.id, e] as const) : [])
  }, [index, novel])

  const undatedItems = useMemo(
    () =>
      undated.map((e) => ({
        entity: e,
        locName: novel ? (resolvePlace(novel, e.at)?.name ?? null) : null,
      })),
    [undated, novel],
  )

  /* ---------------- 值域与刻度 ---------------- */

  const domain = useMemo(() => {
    if (!cal || dated.length === 0) return null
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const e of dated) {
      const d = e.date
      if (!d) continue
      const v = dateToSortable(d, cal)
      const vEnd = e.dateEnd ? dateToSortable(e.dateEnd, cal) : v
      min = Math.min(min, v)
      max = Math.max(max, v, vEnd)
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    // 只有一个时间点时人为撑开一年（1000 = 一年），否则整条轴缩成一个点
    if (max === min) {
      min -= 1000
      max += 1000
    }
    return { min, max }
  }, [dated, cal])

  /**
   * 真正画出来的那一段。没框就是整条轴；框了就只剩那一段 ——
   * 注意 `domain` 仍然是全时段，回「全部」时要用它。
   */
  const viewDomain = useMemo(() => {
    if (!domain) return null
    if (!win) return domain
    const lo = Math.min(win.a, win.b)
    const hi = Math.max(win.a, win.b)
    const min = Math.max(domain.min, lo)
    const max = Math.min(domain.max, hi)
    // 框得太窄就撑到一年（1000 = 一年），否则整条轴会退化成一个点
    if (max - min < 1000) {
      const c = (min + max) / 2
      return {
        min: Math.max(domain.min, c - 500),
        max: Math.min(domain.max, c + 500),
      }
    }
    return { min, max }
  }, [domain, win])

  /** 落在时间窗里的事件。轴上的排布只认这些 —— 窗外的东西不该占行 */
  const shown = useMemo(() => {
    if (!cal || !viewDomain || !win) return dated
    const { min, max } = viewDomain
    return dated.filter((e) => {
      if (!e.date) return false
      const v = dateToSortable(e.date, cal)
      const vEnd = e.dateEnd ? dateToSortable(e.dateEnd, cal) : v
      return Math.max(v, vEnd) >= min && Math.min(v, vEnd) <= max
    })
  }, [dated, cal, viewDomain, win])

  const ticks = useMemo(() => {
    if (!viewDomain || !cal) return []
    const dates = shown.map((e) => e.date).filter((d): d is NovelDate => !!d)
    const margin = (viewDomain.max - viewDomain.min) * 0.06
    // buildTicks 会跨纪元给出纪元边界刻度，这里只丢掉确实在视野外的那些
    return buildTicks(dates, cal, 8).filter(
      (t) => t.value >= viewDomain.min - margin && t.value <= viewDomain.max + margin,
    )
  }, [viewDomain, shown, cal])


  /** 实际值域要把用到的刻度也包进来，否则纪元名会贴在轴外面 */
  const axis = useMemo(() => {
    if (!viewDomain) return null
    let { min, max } = viewDomain
    for (const t of ticks) {
      min = Math.min(min, t.value)
      max = Math.max(max, t.value)
    }
    return { min, max, span: Math.max(1, max - min) }
  }, [viewDomain, ticks])

  const gutter = mode === 'axis' ? 140 : 40
  const plotLeft = mode === 'lanes' ? LABEL_W : 0
  const plotW = useMemo(() => {
    if (!axis) return 0
    const usable = Math.max(200, viewW - plotLeft - PAD_X * 2 - gutter)
    return usable * zoom
  }, [axis, viewW, plotLeft, gutter, zoom])
  const innerW = plotLeft + PAD_X * 2 + plotW + gutter

  const xOf = useCallback(
    (v: number) => (axis ? scale(v, axis.min, axis.max, PAD_X, PAD_X + plotW) : PAD_X),
    [axis, plotW],
  )

  const rulerRef = useRef<HTMLDivElement | null>(null)
  /** 起手的位置。松手时按「起手 + 松手坐标」定窗口，不依赖状态更新时机 */
  const brushFrom = useRef<number | null>(null)

  /**
   * 刻度条上的坐标 → 世界内时间。
   *
   * 这里必须走和画事件**同一个** xOf，而不是另算一套：拖出来的是「你正看着
   * 的那一段」，一旦两套坐标系差一点，框住的就不是眼睛看到的东西。
   */
  const valueAtClientX = useCallback(
    (clientX: number): number | null => {
      const el = rulerRef.current
      if (!el || !axis) return null
      const r = el.getBoundingClientRect()
      const x = clientX - r.left - plotLeft - PAD_X
      if (plotW <= 0) return null
      return axis.min + clamp(x / plotW, 0, 1) * axis.span
    },
    [axis, plotLeft, plotW],
  )

  /* 在刻度条上拖一段 = 只看那段。只是点一下（没拖开）= 回到全部 */
  const startBrush = (e: React.PointerEvent) => {
    if (!axis) return
    const v = valueAtClientX(e.clientX)
    if (v === null) return
    e.preventDefault()
    brushFrom.current = v
    setBrush({ a: v, b: v })
  }

  useEffect(() => {
    if (brushFrom.current === null || !axis) return
    const span = axis.span
    const move = (e: PointerEvent) => {
      const v = valueAtClientX(e.clientX)
      if (v === null) return
      setBrush({ a: brushFrom.current as number, b: v })
    }
    const up = (e: PointerEvent) => {
      const a = brushFrom.current
      const b = valueAtClientX(e.clientX)
      brushFrom.current = null
      setBrush(null)
      if (a === null || b === null) return
      // 拖出的距离不到整段的 1.5% 就算「点了一下」：那是想回到全部
      if (Math.abs(b - a) < span * 0.015) setWin(null)
      // 提示条不在这里自动收：收起会让整块画布突然上移三十像素，
      // 而用户的手还按在原地。让它留到点「知道了」为止。
      else setWin({ a, b })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [brush, axis, valueAtClientX])

  /* ---------------- 事件轴分层 ---------------- */

  const axisMarkers = useMemo(() => {
    if (!cal || !axis || mode !== 'axis') return [] as Placed[]
    const items = shown.flatMap((e) => {
      if (!e.date) return []
      const v = dateToSortable(e.date, cal)
      const vEnd = e.dateEnd ? dateToSortable(e.dateEnd, cal) : v
      return [{ entity: e, x1: xOf(Math.min(v, vEnd)), x2: xOf(Math.max(v, vEnd)) }]
    })
    items.sort((a, b) => a.x1 - b.x1)
    // 占位宽度含标题和短日期，否则「看起来不撞」的标签会互相压住
    const raw = items.map((it) => ({
      ...it,
      occ: it.x2 + Math.max(12, estimateTextWidth(it.entity.name) + 62),
    }))
    const laid = assignRows(
      raw.map((r) => ({ x1: r.x1, x2: r.occ })),
      12,
      999,
    )
    return raw.map((r, i) => ({ entity: r.entity, x1: r.x1, x2: r.x2, row: laid[i].row }))
  }, [shown, axis, mode, cal, xOf])

  const axisRowCount = axisMarkers.reduce((n, m) => Math.max(n, m.row + 1), 0)

  /* ---------------- 轨道分组 ---------------- */

  const lanes = useMemo(() => {
    if (!cal || !novel) return [] as Array<{
      key: string
      /** 只在这个地点真的对应一个地点条目时才有：用来点开那个条目 */
      locId: string | null
      name: string
      events: Entity[]
      sort: number
      chars: Entity[]
    }>
    const NONE = '__none__'
    const buckets = new Map<string, Entity[]>()
    const placeOf = new Map<string, string>()
    for (const e of shown) {
      const place = resolvePlace(novel, e.at)
      const key = place ? place.key : NONE
      if (place) placeOf.set(key, place.name)
      const arr = buckets.get(key)
      if (arr) arr.push(e)
      else buckets.set(key, [e])
    }
    // 角色归属地点：写了「常驻 / 出生地」链接的那些。只有地点条目能这么做
    const charsOf = (entityId: string) =>
      novel.entities.filter(
        (e) =>
          e.type === 'character' &&
          e.links.some(
            (l) =>
              l.to === entityId && (l.type.includes('常驻') || l.type.includes('出生地')),
          ),
      )

    const rows = Array.from(buckets.entries()).map(([key, list]) => {
      const entityId = key.startsWith('e:') ? key.slice(2) : null
      const loc = entityId ? byId.get(entityId) : undefined
      const times = list.flatMap((e) => (e.date ? [dateToSortable(e.date, cal)] : []))
      return {
        key,
        locId: loc ? loc.id : null,
        name: loc ? loc.name : (placeOf.get(key) ?? '未定地点'),
        events: list,
        // 地点行按世界内第一个事件的先后排；没有时间的行沉底
        sort: times.length ? Math.min(...times) : Number.POSITIVE_INFINITY,
        chars: loc ? charsOf(loc.id) : [],
      }
    })
    rows.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return rows
  }, [shown, cal, novel, byId])

  const laneLayout = useMemo(() => {
    let y = 0
    return lanes.map((lane) => {
      const open = !!expanded[lane.key]
      const shownChars = lane.chars.slice(0, 6)
      const extraChars = lane.chars.length - shownChars.length
      const charRows = open ? shownChars.length + (extraChars > 0 ? 1 : 0) : 0
      const h = LANE_TOP + charRows * LANE_CHAR_H + (charRows > 0 ? 4 : 0)
      const item = { ...lane, y, h, open, shownChars, extraChars }
      y += h
      return item
    })
  }, [lanes, expanded])

  const lanesH = laneLayout.reduce((n, l) => n + l.h, 0)

  const laneMarkers = useMemo(() => {
    const out = new Map<string, Placed[]>()
    if (!cal || mode !== 'lanes') return out
    for (const lane of lanes) {
      const items = lane.events.flatMap((e) => {
        if (!e.date) return []
        const v = dateToSortable(e.date, cal)
        const vEnd = e.dateEnd ? dateToSortable(e.dateEnd, cal) : v
        return [{ entity: e, x1: xOf(Math.min(v, vEnd)), x2: xOf(Math.max(v, vEnd)) }]
      })
      items.sort((a, b) => a.x1 - b.x1)
      const raw = items.map((it) => ({
        ...it,
        occ: it.x2 + Math.max(10, estimateTextWidth(it.entity.name) + 34),
      }))
      // 一行只有两个子行：宁可轻微重叠，也不让某一行的行高变成三倍
      const laid = assignRows(
        raw.map((r) => ({ x1: r.x1, x2: r.occ })),
        8,
        2,
      )
      out.set(
        lane.key,
        raw.map((r, i) => ({ entity: r.entity, x1: r.x1, x2: r.x2, row: laid[i].row })),
      )
    }
    return out
  }, [lanes, mode, cal, xOf])

  /* ---------------- hover 浮层 ---------------- */

  const hovered = useMemo(
    () => (novel && hoverId ? (novel.entities.find((e) => e.id === hoverId) ?? null) : null),
    [novel, hoverId],
  )

  const hoverInfo = useMemo(() => {
    if (!hovered || !novel) return null
    /* 参与者、地点都走和别处同一套取值：入边（角色 → 事件）与出边（事件 →
       角色）都要，作者写哪边都算。手工摆的时间线上那几个浮层也用这一份，
       两处不会说法不一。 */
    return {
      loc: resolvePlace(novel, hovered.at),
      parts: castOf(novel, hovered.id),
    }
  }, [hovered, novel])

  const moveTip = useCallback((clientX: number, clientY: number) => {
    lastPt.current = { x: clientX, y: clientY }
    const tip = tipRef.current
    const body = bodyRef.current
    if (!tip || !body) return
    const r = body.getBoundingClientRect()
    const { w, h } = tipSize.current
    const pad = 10
    let x = clientX - r.left + 16
    let y = clientY - r.top + 14
    // 右边 / 下边放不下就翻到反侧，再不行就贴边，永远不出容器
    if (x + w + pad > r.width) x = clientX - r.left - w - 16
    if (y + h + pad > r.height) y = clientY - r.top - h - 12
    tip.style.transform = `translate(${clamp(x, pad, Math.max(pad, r.width - w - pad))}px, ${clamp(
      y,
      pad,
      Math.max(pad, r.height - h - pad),
    )}px)`
    tip.style.opacity = '1'
  }, [])

  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!tip || !hovered) return
    // 尺寸只在悬停对象变化时量一次，mousemove 里不再触发布局读取
    tipSize.current = { w: tip.offsetWidth, h: tip.offsetHeight }
    const p = lastPt.current
    if (p) moveTip(p.x, p.y)
  }, [hovered, moveTip])

  /* ---------------- 早退与分支 ---------------- */

  if (!novel || !cal) return null

  const noEvents = events.length === 0
  const noDates = dated.length === 0
  const contentH =
    mode === 'axis'
      ? HEAD_H + Math.max(96, axisRowCount * ROW_H + 20)
      : HEAD_H + lanesH + 16

  const newEventButton = (primary: boolean) => (
    <button
      type="button"
      className={cx('btn', primary ? 'btn-primary' : 'btn-ghost')}
      onClick={() => addEntity('event')}
    >
      <Plus size={13} />
      新建事件
    </button>
  )

  return (
    <div
      ref={bodyRef}
      className="relative flex h-full min-h-0 flex-col"
      onMouseMove={(e) => {
        // 浮层位置直接写 DOM，不 setState，避免每帧重渲染上百个事件
        if (hoverId) moveTip(e.clientX, e.clientY)
      }}
    >
      {/* ---------------- 工具栏 ---------------- */}
      <div
        className="flex flex-none flex-wrap items-center gap-x-2 gap-y-2 px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--color-line)', background: 'var(--color-surface)' }}
      >
        <span className="flex items-center gap-1.5 pl-1" style={{ color: 'var(--color-ink-faint)' }}>
          <ClockCounterClockwise size={13} />
          <span className="t-micro">时间线</span>
        </span>

        <Divider />

        {/* 两种模式：这不是筛选，是两种提问方式 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cx('btn', mode === 'axis' ? 'btn-ghost' : 'btn-plain')}
            style={mode === 'axis' ? { color: 'var(--color-ink)' } : undefined}
            aria-pressed={mode === 'axis'}
            onClick={() => setMode('axis')}
            title="一条轴，看先后顺序"
          >
            <ListBullets size={13} />
            事件轴
          </button>
          <button
            type="button"
            className={cx('btn', mode === 'lanes' ? 'btn-ghost' : 'btn-plain')}
            style={mode === 'lanes' ? { color: 'var(--color-ink)' } : undefined}
            aria-pressed={mode === 'lanes'}
            onClick={() => setMode('lanes')}
            title="每个地点一行，看同一时期各地在发生什么"
          >
            <Rows size={13} />
            轨道
          </button>
          <button
            type="button"
            className={cx('btn', mode === 'presence' ? 'btn-ghost' : 'btn-plain')}
            style={mode === 'presence' ? { color: 'var(--color-ink)' } : undefined}
            aria-pressed={mode === 'presence'}
            onClick={() => setMode('presence')}
            title="谁在什么时候、什么地方 —— 用来发现本不该碰面的人被安排在了一起"
          >
            <UsersThree size={13} />
            在场
          </button>
        </div>

        <Divider />

        <button
          type="button"
          className={cx('btn', showUndated ? 'btn-ghost' : 'btn-plain')}
          style={
            showUndated
              ? {
                  color: 'var(--color-accent)',
                  borderColor: 'color-mix(in oklab, var(--color-accent) 42%, transparent)',
                }
              : undefined
          }
          aria-pressed={showUndated}
          /* 一个都没有的时候它是空按钮，点了什么也不会发生 —— 干脆不可点，
             免得看起来像坏了（这也是这个按钮最容易被误会的地方）。 */
          disabled={undated.length === 0}
          onClick={() => setShowUndated((v) => !v)}
          title={
            undated.length === 0
              ? '所有事件都填了时间，没有落在轴外的'
              : '没填时间的事件落不到轴上，点一下把它们在下面摊开'
          }
        >
          <CalendarBlank size={13} />
          无日期
          <span className="t-num">{undated.length}</span>
        </button>

        <Divider />

        {/* 时间窗：框着一段的时候，必须随时看得见「我在看的是哪一段」。
            在场那张矩阵按别的方式分桶，不受这个窗口影响，所以那儿不显示。 */}
        {win && mode !== 'presence' && (
          <span
            data-window="1"
            data-window-a={win.a}
            data-window-b={win.b}
            className="t-num flex items-center gap-1.5"
            style={{
              padding: '2px 3px 2px 7px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-accent-wash)',
              color: 'var(--color-ink-mid)',
            }}
            title="只看这一段。点右边 × 回到全部"
          >
            {shown.length === 0
              ? '这一段没有事件'
              : `${formatYearShort(shown[0].date!.year, cal)} – ${formatYearShort(shown[shown.length - 1].date!.year, cal)}`}
            <span style={{ color: 'var(--color-ink-faint)' }}>
              {shown.length} / {dated.length} 件
            </span>
            <button
              type="button"
              className="btn btn-plain"
              style={{ padding: 1 }}
              onClick={() => setWin(null)}
              title="回到全部"
            >
              <X size={10} />
            </button>
          </span>
        )}

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="btn btn-plain"
            title="缩小"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => clamp(z / 1.6, 1, 12))}
          >
            <MagnifyingGlassMinus size={13} />
          </button>
          <button
            type="button"
            className="btn btn-plain"
            title="适配宽度"
            disabled={zoom === 1}
            onClick={() => setZoom(1)}
          >
            <ArrowsHorizontal size={13} />
          </button>
          <button
            type="button"
            className="btn btn-plain"
            title="放大"
            disabled={zoom >= 12}
            onClick={() => setZoom((z) => clamp(z * 1.6, 1, 12))}
          >
            <MagnifyingGlassPlus size={13} />
          </button>
          {zoom > 1 && (
            <span className="t-num pr-1" style={{ color: 'var(--color-ink-faint)' }}>
              ×{zoom.toFixed(1)}
            </span>
          )}
        </div>

        <Divider />

        {newEventButton(false)}

        <div className="min-w-2 flex-1" />

        {/* 历法可见：作者必须随时知道自己写在哪个历法里 */}
        <div className="flex items-center gap-2 pr-1" title={`当前历法：${cal.name}`}>
          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {dated.length} 已定位 · {undated.length} 无日期
          </span>
          <Divider />
          <span className="flex items-center gap-1.5">
            <span
              className="text-[12px] font-medium"
              style={{ color: 'var(--color-ink-mid)' }}
            >
              {cal.name}
            </span>
            <span className="flex items-center gap-1">
              {cal.eras.map((era) => (
                <span
                  key={era.name}
                  className="chip"
                  style={{ color: 'var(--color-ink-soft)', borderColor: 'var(--color-line)' }}
                >
                  {era.name}
                </span>
              ))}
            </span>
          </span>
        </div>
      </div>

      {/* ---------------- 主体 ---------------- */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 在场模式是另一个问题：「谁在什么时候什么地方」。
            它不依赖事件是否填了时间，所以单独成一支，不走下面的事件渲染。 */}
        {mode === 'presence' ? (
          <PresenceMatrix />
        ) : noEvents ? (
          <div className="grid min-h-0 flex-1 place-items-center">
            <Empty
              title="时间线还是空的"
              hint="建一个事件，把它的时间、地点和参与者填上，这条轴就会自己长出来。"
              action={newEventButton(true)}
            />
          </div>
        ) : noDates ? (
          <>
            <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
              <Empty
                title="事件都还没有世界内时间"
                hint={`时间线靠 date 落位。给事件填上${cal.name}的纪元、年和月，它就会出现在轴上；在那之前它只能待在这份「时间未定」清单里。`}
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {newEventButton(true)}
                    {!showUndated && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setShowUndated(true)}
                      >
                        <CalendarBlank size={13} />
                        先看看这些事件
                      </button>
                    )}
                  </div>
                }
              />
            </div>
            {showUndated && undatedItems.length > 0 && (
              <UndatedStrip
                items={undatedItems}
                selectedId={selectedId}
                onSelect={select}
                onClose={() => setShowUndated(false)}
              />
            )}
          </>
        ) : (
          <>
            {/* 这一条没人猜得到：刻度条看着只是「时间标签」，其实能拖 */}
            {rangeHint && !win && shown.length >= 6 && (
              <div
                data-range-hint="1"
                className="flex flex-none items-start gap-2 px-3 py-2 text-[11.5px] leading-relaxed"
                style={{
                  background: 'color-mix(in oklab, var(--color-accent) 6%, transparent)',
                  borderBottom: '1px solid var(--color-line-soft)',
                  color: 'var(--color-ink-soft)',
                }}
              >
                <span className="flex-1">
                  事件多了以后，整条轴会把早年挤成一条缝。在刻度条上按住拖一段，就只看那一段 ——
                  行数会立刻降下来。
                  <b style={{ color: 'var(--color-ink)' }}>点一下刻度条 = 回到全部。</b>
                </span>
                <button type="button" className="btn btn-plain flex-none" onClick={() => setRangeHint(false)}>
                  知道了
                </button>
              </div>
            )}
            <div
              ref={attachScroller}
              className="min-h-0 flex-1 overflow-auto"
              onScroll={() => {
                // 滚动后鼠标底下的东西已经换了，旧的浮层必须撤掉
                if (hoverId) setHoverId(null)
              }}
            >
              <div style={{ position: 'relative', width: innerW, height: contentH }}>
                {/* 刻度条：竖向钉住，横向跟着内容走。
                    它同时也是「时间窗」的选框 —— 在这一条上拖一段，就只看那段。
                    选框必须和刻度用同一个坐标，否则框住的不是你眼睛看到的东西。 */}
                <div
                  ref={rulerRef}
                  data-ruler="1"
                  onPointerDown={startBrush}
                  title="在刻度上按住拖一段 = 只看那一段；点一下 = 回到全部"
                  style={{
                    position: 'sticky',
                    top: 0,
                    left: 0,
                    zIndex: 6,
                    width: '100%',
                    height: HEAD_H,
                    background: 'var(--color-surface)',
                    borderBottom: '1px solid var(--color-line)',
                    cursor: 'col-resize',
                    userSelect: 'none',
                  }}
                >
                  {/* 只有拖的时候才画框。定了之后框就是「你看到的一切」，
                      再糊一层颜色只是噪声 —— 说明在顶上的那颗标签里。 */}
                  {brush && axis && (
                    <div
                      aria-hidden
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: plotLeft + xOf(Math.min(brush.a, brush.b)),
                        width: Math.abs(xOf(Math.max(brush.a, brush.b)) - xOf(Math.min(brush.a, brush.b))),
                        background: 'color-mix(in oklab, var(--color-accent) 16%, transparent)',
                        borderLeft: '1px solid var(--color-accent)',
                        borderRight: '1px solid var(--color-accent)',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                  {mode === 'lanes' && (
                    <div
                      style={{
                        position: 'sticky',
                        left: 0,
                        zIndex: 7,
                        width: LABEL_W,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        paddingLeft: 12,
                        background: 'var(--color-surface)',
                        borderRight: '1px solid var(--color-line)',
                      }}
                    >
                      <span className="t-micro">地点 / 时间</span>
                    </div>
                  )}
                  {ticks.map((t) => {
                    const x = plotLeft + xOf(t.value)
                    const era = isEraLabel(t.label)
                    return (
                      <div
                        key={t.value}
                        style={{ position: 'absolute', top: 0, height: '100%', left: x }}
                      >
                        <div
                          aria-hidden
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            width: 1,
                            background: era
                              ? 'var(--color-line-strong)'
                              : 'var(--color-line-soft)',
                          }}
                        />
                        <div
                          className="t-num"
                          style={{
                            position: 'absolute',
                            top: 7,
                            left: 0,
                            // 两头的刻度字不能被画布边缘切掉：靠边就贴边对齐
                            transform:
                              x < PAD_X + 26
                                ? 'none'
                                : x > innerW - 34
                                  ? 'translateX(-100%)'
                                  : 'translateX(-50%)',
                            whiteSpace: 'nowrap',
                            color: era ? 'var(--color-accent)' : 'var(--color-ink-faint)',
                          }}
                        >
                          {t.label}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 竖向网格：刻度的影子，让远处的事件也能对上时间 */}
                {ticks.map((t) => (
                  <div
                    key={`g${t.value}`}
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: HEAD_H,
                      bottom: 0,
                      left: plotLeft + xOf(t.value),
                      width: 1,
                      background: 'var(--color-line-soft)',
                      opacity: 0.55,
                    }}
                  />
                ))}

                {mode === 'axis'
                  ? axisMarkers.map((m) => (
                      <EventMarker
                        key={m.entity.id}
                        entity={m.entity}
                        x1={m.x1}
                        x2={m.x2}
                        top={HEAD_H + 10 + m.row * ROW_H}
                        leftBase={0}
                        cal={cal}
                        active={selectedId === m.entity.id}
                        hot={hoverId === m.entity.id}
                        onSelect={select}
                        onEnter={(e, id) => {
                          setHoverId(id)
                          moveTip(e.clientX, e.clientY)
                        }}
                        onLeave={() => setHoverId(null)}
                      />
                    ))
                  : laneLayout.map((lane) => {
                      const marks = laneMarkers.get(lane.key) ?? []
                      const laneActive = lane.locId !== null && selectedId === lane.locId
                      return (
                        <div
                          key={lane.key}
                          style={{
                            position: 'absolute',
                            left: 0,
                            top: HEAD_H + lane.y,
                            width: '100%',
                            height: lane.h,
                            borderBottom: '1px solid var(--color-line-soft)',
                          }}
                        >
                          {/* 地点列：横向滚动时钉在左边 */}
                          <div
                            style={{
                              position: 'sticky',
                              left: 0,
                              zIndex: 3,
                              width: LABEL_W,
                              height: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'center',
                              gap: 2,
                              padding: '0 8px 0 4px',
                              background: 'var(--color-base)',
                              borderRight: '1px solid var(--color-line)',
                            }}
                          >
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className="btn btn-plain"
                                style={{ padding: '2px 3px' }}
                                onClick={() =>
                                  setExpanded((prev) => ({ ...prev, [lane.key]: !prev[lane.key] }))
                                }
                                title={
                                  lane.chars.length === 0
                                    ? '这个地点还没有常驻角色'
                                    : lane.open
                                      ? '收起常驻角色'
                                      : '展开常驻角色'
                                }
                                disabled={lane.chars.length === 0}
                              >
                                {lane.open ? <CaretDown size={11} /> : <CaretRight size={11} />}
                              </button>
                              <button
                                type="button"
                                className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium"
                                style={{
                                  color: laneActive ? 'var(--color-ink)' : 'var(--color-ink-mid)',
                                  cursor: lane.locId ? 'pointer' : 'default',
                                }}
                                onClick={() => lane.locId && select(lane.locId)}
                                disabled={!lane.locId}
                              >
                                {lane.name}
                              </button>
                              <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                                {lane.events.length}
                              </span>
                            </div>

                            {lane.open && (
                              <div className="flex flex-col gap-[2px] pl-[19px]">
                                {lane.shownChars.map((c) => (
                                  <button
                                    key={c.id}
                                    type="button"
                                    className="chip self-start"
                                    style={{
                                      maxWidth: '100%',
                                      background: 'var(--color-surface-2)',
                                      borderColor: 'var(--color-line)',
                                      color: 'var(--color-ink-soft)',
                                    }}
                                    onClick={() => select(c.id)}
                                    title={`选中「${c.name}」`}
                                  >
                                    <TypeDot type="character" size={5} />
                                    <span className="truncate">{c.name}</span>
                                  </button>
                                ))}
                                {lane.extraChars > 0 && (
                                  <span
                                    className="t-num"
                                    style={{ color: 'var(--color-ink-faint)' }}
                                  >
                                    +{lane.extraChars}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {marks.map((m) => (
                            <EventMarker
                              key={m.entity.id}
                              entity={m.entity}
                              x1={m.x1}
                              x2={m.x2}
                              top={SUB_ROW_TOP[m.row]}
                              leftBase={LABEL_W}
                              cal={cal}
                              compact={mode === 'lanes'}
                              active={selectedId === m.entity.id}
                              hot={hoverId === m.entity.id}
                              onSelect={select}
                              onEnter={(e, id) => {
                                setHoverId(id)
                                moveTip(e.clientX, e.clientY)
                              }}
                              onLeave={() => setHoverId(null)}
                            />
                          ))}
                        </div>
                      )
                    })}

                {mode === 'lanes' && laneLayout.length === 0 && (
                  <div
                    className="text-[12.5px]"
                    style={{ position: 'absolute', top: HEAD_H + 24, left: 20, color: 'var(--color-ink-soft)' }}
                  >
                    {win
                      ? '这一段里没有带地点的事件。点一下刻度条回到全部。'
                      : '还没有带地点的事件。给事件填上「发生地点」，轨道就会多一行。'}
                  </div>
                )}

                {win && shown.length === 0 && (
                  <div
                    data-window-empty="1"
                    style={{
                      position: 'absolute',
                      top: HEAD_H + 24,
                      left: 20,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: 'var(--color-ink-soft)',
                      fontSize: 12.5,
                    }}
                  >
                    这一段里没有事件。
                    <button type="button" className="btn btn-plain" onClick={() => setWin(null)}>
                      回到全部
                    </button>
                  </div>
                )}
              </div>
            </div>

            {showUndated && undatedItems.length > 0 && (
              <UndatedStrip
                items={undatedItems}
                selectedId={selectedId}
                onSelect={select}
                onClose={() => setShowUndated(false)}
              />
            )}
          </>
        )}
      </div>

      {/* ---------------- hover 浮层 ---------------- */}
      {hovered && (
        <div
          ref={tipRef}
          data-tip="1"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            zIndex: 30,
            width: 302,
            opacity: 0,
            pointerEvents: 'none',
            willChange: 'transform',
            padding: '10px 12px 9px',
            background: 'var(--color-overlay)',
            border: '1px solid var(--color-line-strong)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-raise)',
          }}
        >
          <div className="flex items-center gap-2">
            <TypeDot type="event" size={8} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {hovered.name}
            </span>
            <TypeChip type="event" />
          </div>

          <div className="mt-2 flex items-start gap-1.5">
            <CalendarBlank
              size={12}
              style={{ flex: 'none', marginTop: 2, color: 'var(--color-ink-faint)' }}
            />
            <span className="t-num" style={{ color: 'var(--color-ink-mid)' }}>
              {formatDate(hovered.date, cal)}
              {hovered.dateEnd ? ` → ${formatDate(hovered.dateEnd, cal)}` : ''}
            </span>
          </div>

          <div className="mt-1 flex items-start gap-1.5">
            <MapPin
              size={12}
              style={{ flex: 'none', marginTop: 2, color: 'var(--color-ink-faint)' }}
            />
            <span
              className="text-[12px]"
              style={{ color: hoverInfo?.loc ? 'var(--color-ink-mid)' : 'var(--color-ink-faint)' }}
            >
              {hoverInfo?.loc ? hoverInfo.loc.name : '未定地点'}
            </span>
          </div>

          <div className="mt-1 flex items-start gap-1.5">
            <UsersThree
              size={12}
              style={{ flex: 'none', marginTop: 2, color: 'var(--color-ink-faint)' }}
            />
            {hoverInfo && hoverInfo.parts.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {hoverInfo.parts.slice(0, 6).map((p) => (
                  <span key={p.id} className="flex items-center gap-1">
                    <TypeDot type={p.type} size={5} />
                    <span className="text-[12px]" style={{ color: 'var(--color-ink-mid)' }}>
                      {p.name}
                    </span>
                  </span>
                ))}
                {hoverInfo.parts.length > 6 && (
                  <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                    +{hoverInfo.parts.length - 6}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
                还没有参与角色
              </span>
            )}
          </div>

          {hovered.fields?.['后果'] && (
            <p className="t-prose mt-2 line-clamp-4 text-[12.5px]">
              {hovered.fields['后果']}
            </p>
          )}

          <div
            className="t-num mt-2 pt-1.5"
            style={{ borderTop: '1px solid var(--color-line-soft)', color: 'var(--color-ink-faint)' }}
          >
            {hovered.id}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================================================
   零件
   ============================================================ */

function Divider() {
  return (
    <span
      aria-hidden
      style={{ width: 1, height: 16, background: 'var(--color-line)', flex: 'none' }}
    />
  )
}

/** 一个事件在轴 / 轨道上的画法：点或跨度条 + 标题 + 短日期 */
function EventMarker({
  entity,
  x1,
  x2,
  top,
  leftBase,
  cal,
  active,
  hot,
  compact,
  onSelect,
  onEnter,
  onLeave,
}: {
  entity: Entity
  x1: number
  x2: number
  top: number
  leftBase: number
  cal: CalendarSystem
  active: boolean
  hot: boolean
  compact?: boolean
  onSelect: (id: string) => void
  onEnter: (e: ReactMouseEvent<HTMLButtonElement>, id: string) => void
  onLeave: () => void
}) {
  const color = `var(${ENTITY_META.event.cssVar})`
  const isRange = !!entity.dateEnd && x2 - x1 > 2
  const barW = Math.max(10, x2 - x1)
  const filled = active || hot
  const dateLabel =
    isRange && entity.dateEnd
      ? `${formatDateShort(entity.date, cal)}–${formatDateShort(entity.dateEnd, cal)}`
      : formatDateShort(entity.date, cal)

  return (
    <button
      type="button"
      data-event={entity.id}
      onClick={() => onSelect(entity.id)}
      onMouseEnter={(e) => onEnter(e, entity.id)}
      onMouseLeave={onLeave}
      style={{
        position: 'absolute',
        left: leftBase + (isRange ? x1 : x1 - 4),
        top,
        height: compact ? 18 : 22,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: isRange ? '0 7px 0 3px' : '0 6px 0 0',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        background: filled
          ? active
            ? 'color-mix(in oklab, var(--color-accent) 16%, transparent)'
            : 'var(--color-surface-2)'
          : 'transparent',
        border: `1px solid ${
          active
            ? 'color-mix(in oklab, var(--color-accent) 52%, transparent)'
            : hot
              ? 'var(--color-line)'
              : 'transparent'
        }`,
        borderRadius: 'var(--radius-sm)',
        transition: 'background-color 0.16s var(--ease-out-quint), border-color 0.16s var(--ease-out-quint)',
      }}
    >
      {isRange ? (
        <span
          aria-hidden
          style={{
            width: barW,
            height: 8,
            flex: 'none',
            borderRadius: 'var(--radius-sm)',
            background: `color-mix(in oklab, ${color} 26%, transparent)`,
            border: `1px solid color-mix(in oklab, ${color} 62%, transparent)`,
          }}
        />
      ) : (
        <TypeDot type="event" size={8} />
      )}
      <span
        className="text-[12.5px] font-medium"
        style={{ color: active ? 'var(--color-ink)' : 'var(--color-ink-mid)' }}
      >
        {entity.name}
      </span>
      {!compact && (
        <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
          {dateLabel}
        </span>
      )}
    </button>
  )
}

/** 时间未定的事件：落不到轴上，但不能就这样消失 */
function UndatedStrip({
  items,
  selectedId,
  onSelect,
  onClose,
}: {
  items: Array<{ entity: Entity; locName: string | null }>
  selectedId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}) {
  return (
    <div
      className="flex-none px-4 py-2.5"
      style={{ borderTop: '1px solid var(--color-line)', background: 'var(--color-surface)' }}
    >
      <SectionLabel
        right={
          <span className="flex items-center gap-2">
            <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
              {items.length} 个事件没有时间
            </span>
            <button type="button" className="btn btn-plain" onClick={onClose} title="收起">
              <X size={12} />
            </button>
          </span>
        }
      >
        时间未定
      </SectionLabel>
      <div className="flex max-h-[92px] flex-wrap gap-1.5 overflow-y-auto">
        {items.map(({ entity, locName }) => {
          const active = selectedId === entity.id
          return (
            <button
              key={entity.id}
              type="button"
              className="chip"
              onClick={() => onSelect(entity.id)}
              style={{
                background: active ? 'var(--color-surface-3)' : 'var(--color-surface-2)',
                borderColor: active
                  ? 'color-mix(in oklab, var(--color-accent) 46%, transparent)'
                  : 'var(--color-line)',
                color: active ? 'var(--color-ink)' : 'var(--color-ink-mid)',
              }}
            >
              <TypeDot type="event" size={5} />
              <span>{entity.name}</span>
              {locName && (
                <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                  {locName}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
