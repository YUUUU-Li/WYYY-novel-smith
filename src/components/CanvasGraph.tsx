/* ============================================================
   手绘图谱

   交互模型：
     进入时是「选定」模式（不做任何危险操作）
       · 点方格 → 在左侧显示这个词条的设定
       · 拖方格 → 摆位置
       · 拖空白 → 平移画布；滚轮 → 缩放
     工具栏切到「连线」→ 点起点、再点终点，建立关系
     工具栏切到「删除方格」→ 点方格，连同它所有的线一起删掉
     工具栏切到「删除连线」→ 点线，只删那一条关系

   为什么把危险操作放进独立模式：
   删除和连线都是不可逆的动作。如果它们和「选定」混在一起，
   你只想看一眼设定就可能误删。所以模式切换是这里的安全边界。

   两个方格之间可以有多条线（比如两条方向相反的单项箭头），
   它们会各自散开成曲线，不重叠。
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretDown,
  CaretRight,
  CrosshairSimple,
  LinkSimple,
  Trash,
  X,
} from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import {
  CANVAS_H,
  CANVAS_W,
  DEFAULT_VIEW_ID,
  NODE_H,
  NODE_W,
  arrowAt,
  edgeColorVar,
  edgePath,
  freeSpot,
  labelWidth,
  layoutGraph,
  positionOf,
  truncateLabel,
  withoutPosition,
  withPosition,
  type LaidOutEdge,
  type LaidOutNode,
} from '../lib/canvas-graph'
import {
  ENTITY_META,
  LINK_COLORS,
  LINK_DASHES,
  LINK_DIRECTIONS,
  type Entity,
  type EntityType,
  type LinkColor,
  type LinkDash,
  type LinkDirection,
} from '../lib/types'
import { resolvePlace } from '../lib/places'
import { Empty, TypeDot } from './ui'
import { countWords, clamp } from '../lib/util'

type Mode = 'select' | 'link' | 'unlink' | 'unplace'

/** 新连线还没有关系名时用的占位文字。点一下就能改名。 */
const PLACEHOLDER_TYPE = '点击编辑关系'

/** 正在改名的连线 */
interface Renaming {
  edgeKey: string
  fromId: string
  toId: string
  oldType: string
  value: string
}

export function CanvasGraph() {
  const novel = useStore((s) => s.novel)
  const index = useStore((s) => s.index)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const updateEntity = useStore((s) => s.updateEntity)

  const viewId = DEFAULT_VIEW_ID

  /** 默认是选定模式：进入时什么都不会被改动 */
  const [mode, setMode] = useState<Mode>('select')
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  /** 连线时的起点 */
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  /** 新建连线用的样式，也是工具栏上贴着「连线」按钮的那几组选择 */
  const [nextDir, setNextDir] = useState<LinkDirection>('forward')
  const [nextDash, setNextDash] = useState<LinkDash>('solid')
  /** 不选颜色时用 null，交给关系名自动分配 */
  const [nextColor, setNextColor] = useState<LinkColor | null>(null)
  const [collapsed, setCollapsed] = useState<Set<EntityType>>(new Set())
  const [draggingOver, setDraggingOver] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)

  /* 删除模式下鼠标压在谁身上。
     删除是「点一下就没了」的动作，没有悬停反馈就只能凭运气点 ——
     尤其连线又细又挤，所以两侧都要有明确的「就是这一个」提示。
     只在删除模式里记录，平时不产生任何重渲染。 */
  const [hoverNode, setHoverNode] = useState<string | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)


  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const panRef = useRef<{
    x: number
    y: number
    ox: number
    oy: number
    /** 指针移动是否超过阈值。用来区分「点空白」和「拖空白」 */
    moved: boolean
  } | null>(null)

  /** 超过这个像素距离才算「拖动」，否则算「点击」 */
  const DRAG_THRESHOLD = 5

  const graph = useMemo(
    () => (novel ? layoutGraph(novel.entities, viewId) : { nodes: [], edges: [], notPlaced: [] }),
    [novel, viewId],
  )

  const selected = novel?.entities.find((e) => e.id === selectedId) ?? null

  /* 手绘页没有自己的撤销栈了：这里每一次改动都经 updateEntity 进 store，
     统一由顶栏那个撤回按钮 / Ctrl+Z 负责。
     以前这里存一份「受影响的 links + graphPos」，只管画布内的删除和改名，
     结果同一个页面有两个撤销（一个只管一半），作者不知道该按哪个。 */

  /* 切换模式时清掉中间状态，避免带着上一个模式的残留操作 */
  const switchMode = (m: Mode) => {
    setMode(m)
    setLinkFrom(null)
    setHint(null)
    setRenaming(null)
  }

  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(null), 2200)
    return () => clearTimeout(t)
  }, [hint])

  /* ---------- 坐标换算 ---------- */

  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const el = stageRef.current
      if (!el) return { x: 0, y: 0 }
      const r = el.getBoundingClientRect()
      return {
        x: (clientX - r.left - offset.x) / scale,
        y: (clientY - r.top - offset.y) / scale,
      }
    },
    [offset, scale],
  )

  /* ---------- 拖词条进画布 ---------- */

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDraggingOver(false)
    const id = e.dataTransfer.getData('text/plain')
    if (!id || !novel) return
    // 已经在画布上的，拖动它只是把它移到新位置，不复制
    const entity = novel.entities.find((x) => x.id === id)
    if (!entity) return
    const p = toCanvas(e.clientX, e.clientY)
    const spot = freeSpot(graph.nodes, p.x, p.y)
    updateEntity(id, { graphPos: withPosition(entity, viewId, spot.x, spot.y) })
    select(id)
  }

  /* ---------- 方格上的动作（按模式分派） ---------- */

  const onNodeActivate = (node: LaidOutNode) => {
    if (!novel) return

    if (mode === 'select') {
      select(node.id)
      return
    }

    if (mode === 'link') {
      if (!linkFrom) {
        setLinkFrom(node.id)
        return
      }
      if (linkFrom === node.id) {
        setLinkFrom(null)
        return
      }
      const from = novel.entities.find((x) => x.id === linkFrom)
      if (!from) return
      // 连线也要进撤销栈 —— 连错了能一步退回，和删除同等对待
      // 新关系先不带名字，显示成「点击编辑关系」，点一下就能改。
      // 不自动套用词表里的第一个关系类型 —— 那样会凭空造出一堆
      // 你并没指定的关系，比空着更糟。
      updateEntity(from.id, {
        links: [
          ...from.links,
          {
            to: node.id,
            type: PLACEHOLDER_TYPE,
            dir: nextDir,
            dash: nextDash,
            color: nextColor ?? undefined,
          },
        ],
      })
      setHint(`已连上：${from.name} → ${node.entity.name}，点线上的文字可改关系名`)
      setLinkFrom(null)
      return
    }

    if (mode === 'unplace') {
      // 先把所有指向它的关系摘掉
      for (const e of novel.entities) {
        if (e.id === node.id) continue
        if (e.links.some((l) => l.to === node.id)) {
          updateEntity(e.id, { links: e.links.filter((l) => l.to !== node.id) })
        }
      }
      // 再把这个格子从画布上拿掉（条目本身保留，只是不在图上）
      const self = novel.entities.find((x) => x.id === node.id)
      if (self) updateEntity(self.id, { graphPos: withoutPosition(self, viewId) })
      if (selectedId === node.id) select(null)
      setHint(`已移除「${node.entity.name}」及它的连线`)
    }
  }

  /* ---------- 删除一条线 ----------
     每一条线对应一条 links 记录，所以删除要精确落到那一条：
     写入方是 edge.fromId，目标与类型定位到具体记录。
     同一对格子之间可能有多条同类型同方向的线，所以用**索引**定位，
     不能只按 (to, type) 匹配，否则会一次删掉好几条。 */
  const onEdgeActivate = (edge: LaidOutEdge) => {
    if (!novel || mode !== 'unlink') return
    const owner = novel.entities.find((x) => x.id === edge.fromId)
    if (!owner) return

    const idx = owner.links.findIndex(
      (l) => l.to === edge.toId && l.type === edge.type,
    )
    if (idx === -1) return
    const next = owner.links.filter((_, i) => i !== idx)
    updateEntity(owner.id, { links: next })
    setHint(`已删除关系「${edge.type}」`)
  }

  /* ---------- 编辑关系名 ---------- */

  const beginRename = (edge: LaidOutEdge) => {
    setRenaming({
      edgeKey: edge.key,
      fromId: edge.fromId,
      toId: edge.toId,
      oldType: edge.type,
      value: edge.type === PLACEHOLDER_TYPE ? '' : edge.type,
    })
  }

  const commitRename = () => {
    if (!renaming || !novel) return
    const name = renaming.value.trim()
    const owner = novel.entities.find((x) => x.id === renaming.fromId)
    if (!owner) {
      setRenaming(null)
      return
    }
    // 名字可以留空：留空就显示「点击编辑关系」，等同于「还没想好」
    const finalName = name === '' ? PLACEHOLDER_TYPE : name
    const idx = owner.links.findIndex(
      (l) => l.to === renaming.toId && l.type === renaming.oldType,
    )
    if (idx === -1) {
      setRenaming(null)
      return
    }
    updateEntity(owner.id, {
      links: owner.links.map((l, i) => (i === idx ? { ...l, type: finalName } : l)),
    })
    setRenaming(null)
  }

  /* ---------- 拖动方格 / 平移画布 ---------- */

  const onNodePointerDown = (e: React.PointerEvent, node: LaidOutNode) => {
    // 只有选定模式能拖动摆位。其它模式拖了会误操作，所以不允许。
    if (mode !== 'select') return
    e.stopPropagation()
    // 同样要阻止默认行为，否则在名字上按下会被当成选择文字
    e.preventDefault()
    dragRef.current = {
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: node.x,
      originY: node.y,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (d && novel) {
      const entity = novel.entities.find((x) => x.id === d.id)
      if (!entity) return
      const dx = (e.clientX - d.startX) / scale
      const dy = (e.clientY - d.startY) / scale
      updateEntity(d.id, {
        graphPos: withPosition(
          entity,
          viewId,
          clamp(d.originX + dx, 0, CANVAS_W - NODE_W),
          clamp(d.originY + dy, 0, CANVAS_H - NODE_H),
        ),
      })
      return
    }
    const p = panRef.current
    if (p) {
      const moved =
        p.moved ||
        Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD
      panRef.current = { ...p, moved }
      setOffset({ x: p.ox + (e.clientX - p.x), y: p.oy + (e.clientY - p.y) })
    }
  }

  const onPointerUp = () => {
    // 连线模式下「点空白取消连线」只在没有拖动时成立。
    // 拖动了就说明你是想移动画面，不该顺手把连线也取消掉。
    if (panRef.current && !panRef.current.moved && mode === 'link') {
      setLinkFrom(null)
    }
    dragRef.current = null
    panRef.current = null
  }

  /**
   * 拖空白平移画面。
   *
   * 所有模式下都生效 —— 否则连线连到屏幕外时得先切回「选定」才能移动。
   * 方格和线的处理函数会 stopPropagation，所以只有点在空白处才走到这里。
   *
   * 注意事件目标可能是两种情况：
   *   · 画布容器本身（点在 SVG 之外）
   *   · 铺满画布的那张 SVG（点在空白网格上，这是更常见的情况）
   * 两者都标记成 stage，缺一个就会出现「偶尔能拖动」的怪现象。
   */
  const onStagePointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement | SVGElement
    const isStage = e.target === e.currentTarget || (el as HTMLElement).dataset?.stage === '1'
    if (!isStage) return
    /* 阻止默认行为：浏览器默认会把「按住拖动」当成选择文字，
       那会让平移失效。配合容器上的 user-select:none 一起用。 */
    e.preventDefault()
    panRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  /* 滚轮缩放，以光标为锚点 */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      setScale((prev) => {
        const next = clamp(prev * (e.deltaY > 0 ? 0.9 : 1.1), 0.35, 2.2)
        const k = next / prev
        setOffset((o) => ({ x: mx - k * (mx - o.x), y: my - k * (my - o.y) }))
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (!novel || !index) return null

  if (novel.entities.length === 0) {
    return (
      <Empty
        title="还没有条目可以画"
        hint="先去「设定」里建几个角色和地点，它们会出现在左边的列表里，拖进画布就成一格。"
      />
    )
  }

  const byType = new Map<EntityType, Entity[]>()
  for (const e of novel.entities) {
    const list = byType.get(e.type)
    if (list) list.push(e)
    else byType.set(e.type, [e])
  }

  const cursor =
    mode === 'link' || mode === 'unplace' || mode === 'unlink' ? 'crosshair' : 'grab'

  /* 当前模式该干什么。选定模式不用解释，所以是空的。 */
  const modeHint =
    mode === 'link'
      ? linkFrom
        ? '再点一个方格完成连线'
        : '点起点方格'
      : mode === 'unlink'
        ? '点一条线删除它'
        : mode === 'unplace'
          ? '点一个方格删除它和它的所有线'
          : null

  return (
    <div className="flex h-full min-h-0">
      {/* ---------------- 左：词条列表（常驻）+ 选中项设定（可关闭） ----------------
          两块合成一条：词条列表一直在，选中方格时在它上面插入一块可关闭的设定。
          之前是「选中就整块替换掉列表」，看起来像两个东西在抢同一个位置 —
          而且想再拖一个词条进来就得先关掉设定，很别扭。 */}
      <aside
        className="flex flex-none min-h-0 flex-col"
        style={{
          width: 240,
          borderRight: '1px solid var(--color-line)',
          background: 'var(--color-surface)',
        }}
      >
        <div className="flex-none px-4 pt-4 pb-2">
          <div className="t-micro">词条</div>
          <div
            className="mt-1.5 text-[11.5px] leading-relaxed"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            拖进右边画布就生成一格；点一格看它的设定
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 选中方格的设定。放在列表上面，因为它是对当前操作的解释 */}
          {selected && <NodeDetails entity={selected} onClose={() => select(null)} />}

          {Array.from(byType.entries()).map(([type, list]) => {
              const isCollapsed = collapsed.has(type)
              const placed = list.filter((e) => positionOf(e, viewId)).length
              return (
                <div key={type} className="px-2 pb-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s)
                        if (n.has(type)) n.delete(type)
                        else n.add(type)
                        return n
                      })
                    }
                  >
                    {isCollapsed ? <CaretRight size={10} /> : <CaretDown size={10} />}
                    <TypeDot type={type} size={6} />
                    <span className="text-[12px] font-semibold">
                      {ENTITY_META[type].plural}
                    </span>
                    <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                      {placed > 0 ? `${placed}/${list.length}` : list.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul>
                      {list.map((e) => {
                        const onCanvas = positionOf(e, viewId) !== null
                        return (
                          <li key={e.id}>
                            <div
                              draggable
                              data-id={e.id}
                              onDragStart={(ev) => {
                                ev.dataTransfer.setData('text/plain', e.id)
                                ev.dataTransfer.effectAllowed = 'copy'
                              }}
                              onClick={() => select(e.id)}
                              title={onCanvas ? '已在画布上' : '拖进右边画布'}
                              className="flex cursor-grab items-center gap-2 px-2 py-1.5"
                              style={{ opacity: onCanvas ? 0.42 : 1 }}
                            >
                              <span
                                className="t-num flex-none"
                                style={{ color: 'var(--color-accent)', width: 8 }}
                              >
                                {onCanvas ? '·' : ''}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                                {e.name}
                              </span>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}

          {graph.notPlaced.length > 0 && (
            <div
              className="mx-4 mt-3 mb-4 pt-3 text-[11px] leading-relaxed"
              style={{
                borderTop: '1px solid var(--color-line-soft)',
                color: 'var(--color-ink-faint)',
              }}
            >
              有 {graph.notPlaced.length} 个条目和画布上的东西有关系，但还没拖进来。
            </div>
          )}
        </div>
      </aside>

      {/* ---------------- 右：画布 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具栏：左边是功能按键，线型选择贴在「连线」旁边 */}
        <div
          className="flex flex-none flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--color-line)' }}
        >
          <button
            type="button"
            className="nav-tab"
            onClick={() => switchMode('select')}
            aria-current={mode === 'select' ? 'page' : undefined}
            title="选定：点方格看设定，拖方格摆位置"
          >
            <CrosshairSimple size={14} />
            选定
          </button>

          {/* 连线 + 紧贴它的样式选择 */}
          <div className="flex items-center">
            <button
              type="button"
              className="nav-tab"
              onClick={() => switchMode('link')}
              aria-current={mode === 'link' ? 'page' : undefined}
              title="连线：点起点方格，再点终点方格"
            >
              <LinkSimple size={14} />
              连线
            </button>
            <select
              className="input t-num"
              style={{ width: 88, marginLeft: 6, padding: '5px 8px' }}
              value={nextDir}
              onChange={(e) => setNextDir(e.target.value as LinkDirection)}
              title="线头样式"
            >
              {LINK_DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <select
              className="input t-num"
              style={{ width: 68, marginLeft: 4, padding: '5px 8px' }}
              value={nextDash}
              onChange={(e) => setNextDash(e.target.value as LinkDash)}
              title="线型"
            >
              {LINK_DASHES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            {/* 颜色用色块直接显示，比下拉列表更直观。
                十二个低饱和传统色，只用来区分线条，不做强调。
                色块多了，所以允许换行 —— 窗口窄的时候宁可占两行，也不要溢出。 */}
            <div className="ml-2 flex flex-wrap items-center gap-1" title="线的颜色">
              <button
                type="button"
                className="btn btn-plain"
                style={{
                  padding: '2px 6px',
                  fontSize: 11,
                  color: nextColor === null ? 'var(--color-accent)' : 'var(--color-ink-faint)',
                }}
                onClick={() => setNextColor(null)}
                aria-pressed={nextColor === null}
                title="不指定颜色，按关系名自动分配"
              >
                自动
              </button>
              {LINK_COLORS.map((c) => {
                const on = nextColor === c.value
                return (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setNextColor(on ? null : c.value)}
                    title={c.label}
                    aria-pressed={on}
                    style={{
                      width: 15,
                      height: 15,
                      background: c.hex,
                      border: on
                        ? '2px solid var(--color-ink)'
                        : '1px solid var(--color-line-strong)',
                      outline: on ? '1px solid var(--color-surface)' : 'none',
                      outlineOffset: -3,
                      cursor: 'pointer',
                    }}
                  />
                )
              })}
            </div>
          </div>

          <button
            type="button"
            className="nav-tab"
            onClick={() => switchMode('unlink')}
            aria-current={mode === 'unlink' ? 'page' : undefined}
            title="删除连线：点一条线只删那一条"
          >
            <Trash size={14} />
            删除连线
          </button>

          <button
            type="button"
            className="nav-tab"
            onClick={() => switchMode('unplace')}
            aria-current={mode === 'unplace' ? 'page' : undefined}
            title="删除方格：点一个方格，连同它的所有线一起移除"
          >
            <Trash size={14} />
            删除方格
          </button>


          <div className="flex-1" />

          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {graph.nodes.length} 格 · {graph.edges.length} 线
          </span>

          {/* 只留一个复位。缩放用滚轮就够了，所以去掉了加减按钮；
              复位还是要有一个 —— 滚轮缩放是以光标为锚点的，
              放大到很深的地方之后不容易靠手感退回来。 */}
          <button
            type="button"
            className="btn btn-plain"
            onClick={() => {
              setScale(1)
              setOffset({ x: 0, y: 0 })
            }}
            title="缩放复位（缩放用滚轮）"
          >
            <CrosshairSimple size={14} />
            复位
          </button>
        </div>

        {/* 画布 */}
        <div
          ref={stageRef}
          data-stage="1"
          className="relative min-h-0 flex-1 overflow-hidden"
          style={{
            background: 'var(--color-base)',
            cursor,
            /* 禁止选中文本。
               不加这条的话，在方格的名字上按下拖动会被浏览器判定成
               「选择文字」，于是拖动变成拖选、画面不动 ——
               必须先在空白处点一下取消选中才能移动，很别扭。
               画布类界面的标准做法就是关掉文本选择。 */
            userSelect: 'none',
            WebkitUserSelect: 'none',
            backgroundImage:
              'linear-gradient(var(--color-line-soft) 1px, transparent 1px), linear-gradient(90deg, var(--color-line-soft) 1px, transparent 1px)',
            backgroundSize: `${40 * scale}px ${40 * scale}px`,
            backgroundPosition: `${offset.x}px ${offset.y}px`,
            outline: draggingOver ? '2px dashed var(--color-accent)' : 'none',
            outlineOffset: -6,
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setDraggingOver(true)
          }}
          onDragLeave={() => setDraggingOver(false)}
          onDrop={onDrop}
          onPointerDown={onStagePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <svg
            className="absolute origin-top-left"
            width={CANVAS_W}
            height={CANVAS_H}
            /* 这张 SVG 铺满整个画布，所以「点空白」时事件目标其实是它。
               必须同样标记成 stage，否则平移会被守卫条件拦掉 ——
               只有点到 SVG 之外的窄边才生效，表现为「偶尔能拖动」。 */
            data-stage="1"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              overflow: 'visible',
            }}
          >
            {/* 连线画在方格下面 */}
            {graph.edges.map((e) => {
              const color = edgeColorVar(e.type, e.color)
              const arrows = arrowAt(e)
              const path = edgePath(e)
              const clickable = mode === 'unlink'
              const isRenaming = renaming?.edgeKey === e.key
              const isPlaceholder = e.type === PLACEHOLDER_TYPE
              /* 删除模式下被指到的那一条。
                 线本身就有颜色（好多还是朱砂），所以「变淡红」在它身上看不出
                 来 —— 改用三件事一起说：外面套一圈红色光晕、线加粗、标签前
                 挂一个红叉。光晕是跟颜色无关的那一层，任何线色下都成立。 */
              const doomed = clickable && hoverEdge === e.key
              const labelColor = doomed ? 'var(--color-danger)' : color
              const w = (isPlaceholder ? labelWidth(e.type) + 12 : labelWidth(e.type)) + (doomed ? 20 : 0)
              return (
                <g key={e.key} data-edge={e.key}>
                  {/* 加宽的透明点击区：线太细，直接点很难点中 */}
                  {clickable && (
                    <path
                      d={path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={16}
                      style={{ cursor: 'pointer' }}
                      onPointerEnter={() => setHoverEdge(e.key)}
                      onPointerLeave={() => setHoverEdge((k) => (k === e.key ? null : k))}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        onEdgeActivate(e)
                      }}
                    />
                  )}
                  {/* 光晕：垫在下面的一圈宽红线 */}
                  {doomed && (
                    <path
                      d={path}
                      fill="none"
                      stroke="var(--color-danger)"
                      strokeWidth={9}
                      strokeOpacity={0.22}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                  <path
                    d={path}
                    fill="none"
                    stroke={doomed ? 'var(--color-danger)' : color}
                    strokeWidth={doomed ? 3 : 1.7}
                    strokeDasharray={e.dash === 'dashed' ? '6 5' : undefined}
                    style={{ pointerEvents: 'none' }}
                  />
                  {arrows.to && (
                    <polygon points={arrows.to} fill={color} style={{ pointerEvents: 'none' }} />
                  )}
                  {arrows.from && (
                    <polygon points={arrows.from} fill={color} style={{ pointerEvents: 'none' }} />
                  )}

                  {/* 关系名：垫一块底色避免和网格叠在一起，点一下可以改名。
                      文字按上限截断，否则长名字会盖住邻线的标签和点击区。 */}
                  <rect
                    x={e.mx - w / 2}
                    y={e.my - 10}
                    width={w}
                    height={19}
                    fill={doomed ? 'var(--color-danger-wash)' : 'var(--color-base)'}
                    rx={doomed ? 5 : 0}
                    style={{ pointerEvents: 'none' }}
                  />
                  {/* 要删的那条：标签前面挂个红叉 */}
                  {doomed && (
                    <text
                      x={e.mx - w / 2 + 6}
                      y={e.my + 5}
                      textAnchor="middle"
                      style={{
                        fontFamily: 'var(--font-ui)',
                        fontSize: 15,
                        fontWeight: 700,
                        fill: 'var(--color-danger)',
                        pointerEvents: 'none',
                      }}
                    >
                      ×
                    </text>
                  )}
                  {!isRenaming && (
                    <>
                      <text
                        x={e.mx}
                        y={e.my + 4}
                        textAnchor="middle"
                        onClick={
                          clickable
                            ? undefined
                            : (ev) => {
                                ev.stopPropagation()
                                beginRename(e)
                              }
                        }
                        style={{
                          fontFamily: 'var(--font-ui)',
                          fontSize: 12,
                          fontWeight: 600,
                          // 占位文字用淡色 + 下划线，提示「这里可以改」
                          fill: isPlaceholder && !doomed ? 'var(--color-ink-faint)' : labelColor,
                          cursor: clickable ? 'pointer' : 'text',
                          textDecoration: isPlaceholder ? 'underline' : 'none',
                          // 删除模式下标签也让位给下面的点击区，
                          // 否则鼠标一压到名字上，光晕就没了
                          pointerEvents: clickable ? 'none' : 'auto',
                        }}
                      >
                        {truncateLabel(e.type)}
                      </text>
                      {/* 加宽点击区：12px 的字太难点中。
                          宽度与底色块一致，不会伸出去抢邻线的点击。
                          删除模式下整块让开，好让下面那条宽点击区接手。 */}
                      {!clickable && (
                        <rect
                          x={e.mx - w / 2}
                          y={e.my - 9}
                          width={w}
                          height={18}
                          fill="transparent"
                          style={{ cursor: 'text' }}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            beginRename(e)
                          }}
                        />
                      )}
                    </>
                  )}
                </g>
              )
            })}

            {/* 改名输入框：浮在线上，回车或失焦保存，Esc 取消。
                用 SVG 的 foreignObject 是为了直接复用 HTML 输入框，
                不必自己实现一套文本编辑。 */}
            {renaming &&
              (() => {
                const e = graph.edges.find((x) => x.key === renaming.edgeKey)
                if (!e) return null
                return (
                  <foreignObject
                    x={e.mx - 80}
                    y={e.my - 14}
                    width={160}
                    height={28}
                    style={{ overflow: 'visible' }}
                  >
                    <input
                      autoFocus
                      value={renaming.value}
                      placeholder="输入关系名"
                      onChange={(ev) =>
                        setRenaming((r) => (r ? { ...r, value: ev.target.value } : r))
                      }
                      onKeyDown={(ev) => {
                        ev.stopPropagation()
                        if (ev.key === 'Enter') commitRename()
                        if (ev.key === 'Escape') setRenaming(null)
                      }}
                      onBlur={commitRename}
                      onClick={(ev) => ev.stopPropagation()}
                      style={{
                        width: '100%',
                        height: '100%',
                        textAlign: 'center',
                        fontFamily: 'var(--font-ui)',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--color-ink)',
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-accent)',
                        outline: 'none',
                        padding: '0 6px',
                      }}
                    />
                  </foreignObject>
                )
              })()}

            {/* 方格 */}
            {graph.nodes.map((n) => {
              const active = selectedId === n.id
              const isFrom = linkFrom === n.id
              const meta = ENTITY_META[n.entity.type]
              const danger = mode === 'unplace'
              /* 删除模式 + 鼠标压在这个方格上：整个方格泛一层淡红，
                 告诉你「点下去删的就是这一个」。 */
              const doomed = danger && hoverNode === n.id
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  style={{
                    cursor:
                      mode === 'select'
                        ? 'grab'
                        : mode === 'link'
                          ? 'crosshair'
                          : 'pointer',
                  }}
                  onPointerEnter={() => {
                    if (danger) setHoverNode(n.id)
                  }}
                  onPointerLeave={() => setHoverNode((x) => (x === n.id ? null : x))}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onClick={() => onNodeActivate(n)}
                >
                  {/* 圆角矩形要用 clipPath 裁：左边那条类型色带是另一个
                      rect，直接给主体加 rx 的话色带会在圆角处戳出来。 */}
                  <defs>
                    <clipPath id={`nsr-${n.id}`}>
                      <rect width={NODE_W} height={NODE_H} rx={10} />
                    </clipPath>
                  </defs>
                  <g clipPath={`url(#nsr-${n.id})`}>
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      fill={doomed ? 'var(--color-danger-wash)' : 'var(--color-surface)'}
                    />
                    {/* 左边这条类型色带。删除模式下也换成朱砂 ——
                        不然一格里两种颜色，「整个方格都要没了」就说不圆。 */}
                    <rect
                      width={4}
                      height={NODE_H}
                      fill={doomed ? 'var(--color-danger)' : `var(${meta.cssVar})`}
                    />
                  </g>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill="none"
                    stroke={
                      danger
                        ? 'var(--color-danger)'
                        : isFrom
                          ? 'var(--color-accent)'
                          : active
                            ? 'var(--color-ink)'
                            : `var(${meta.cssVar})`
                    }
                    strokeWidth={doomed ? 2.6 : active || isFrom || danger ? 2 : 1.2}
                  />
                  <text
                    x={14}
                    y={NODE_H / 2 + 5}
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 13.5,
                      fontWeight: 600,
                      fill: 'var(--color-ink)',
                    }}
                  >
                    {n.entity.name.length > 8 ? n.entity.name.slice(0, 8) + '…' : n.entity.name}
                  </text>
                </g>
              )
            })}
          </svg>

          {/* 操作提示贴在画布上，不放在工具栏里。
              放在工具栏的话，提示一出现、一消失，工具栏就多折一行、少折一行，
              整个画布跟着上下跳 —— 而这行字恰恰是在你要点画布的时候出现的。
              贴在这里既不会挤动任何东西，又离鼠标更近。 */}
          <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5">
            {modeHint && (
              <span
                className="px-2.5 py-1 text-[12px]"
                style={{
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-line)',
                  color: mode === 'link' ? 'var(--color-accent)' : 'var(--color-warn)',
                }}
              >
                {modeHint}
              </span>
            )}
            {hint && (
              <span
                className="px-2.5 py-1 text-[12px]"
                style={{
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-line)',
                  color: 'var(--color-ink-soft)',
                }}
              >
                {hint}
              </span>
            )}
          </div>

          {graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div
                className="px-5 py-4 text-center"
                style={{
                  border: '1px dashed var(--color-line-strong)',
                  background: 'color-mix(in oklab, var(--color-base) 85%, transparent)',
                }}
              >
                <div className="text-[13px] font-semibold">把左边的词条拖进来</div>
                <div className="mt-1 text-[11.5px]" style={{ color: 'var(--color-ink-faint)' }}>
                  拖进来会生成一个方格，再用工具栏的「连线」连关系
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   选中项的设定速览
   放在左栏、替代词条列表。比另开一个右侧面板更安静，
   也不会把画布挤窄。
   ============================================================ */

function NodeDetails({ entity, onClose }: { entity: Entity; onClose: () => void }) {
  const novel = useStore((s) => s.novel)
  const select = useStore((s) => s.select)
  const meta = ENTITY_META[entity.type]

  const outgoing = entity.links
    .map((l) => ({ l, other: novel?.entities.find((e) => e.id === l.to) }))
    .filter((x) => x.other)

  const incoming =
    novel?.entities
      .filter((e) => e.id !== entity.id && e.links.some((l) => l.to === entity.id))
      .map((e) => ({ e, link: e.links.find((l) => l.to === entity.id)! })) ?? []

  const at = novel ? resolvePlace(novel, entity.at) : null

  return (
    <div className="anim-fade-up">
      <div className="px-4 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <TypeDot type={entity.type} size={8} />
              <span className="t-micro">{meta.label}</span>
            </div>
            <div className="mt-1.5 text-[17px] font-bold leading-snug">
              {entity.name}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-plain flex-none"
            onClick={onClose}
            title="关闭设定（方格还在画布上）"
          >
            <X size={13} />
          </button>
        </div>

        {entity.summary && (
          <p className="t-prose mt-3" style={{ fontSize: 13.5 }}>
            {entity.summary}
          </p>
        )}
      </div>

      {entity.fields && Object.keys(entity.fields).length > 0 && (
        <div className="mt-4 px-4">
          <div className="t-micro mb-2">要点</div>
          <div className="flex flex-col gap-2.5">
            {Object.entries(entity.fields)
              .filter(([, v]) => v?.trim())
              .map(([k, v]) => (
                <div key={k}>
                  <div
                    className="text-[11px] font-semibold"
                    style={{ color: 'var(--color-ink-soft)' }}
                  >
                    {k}
                  </div>
                  <div className="t-prose mt-0.5" style={{ fontSize: 12.5 }}>
                    {v}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {(outgoing.length > 0 || incoming.length > 0) && (
        <div className="mt-4 px-4">
          <div className="t-micro mb-2">关系</div>
          <div className="flex flex-col gap-0.5">
            {outgoing.map(({ l, other }) => (
              <button
                key={`o-${l.to}-${l.type}`}
                type="button"
                onClick={() => select(other!.id)}
                className="flex items-center gap-2 py-1 text-left"
                style={{ color: 'var(--color-ink-mid)' }}
              >
                <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>→</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{other!.name}</span>
                <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
                  {l.type}
                </span>
              </button>
            ))}
            {incoming.map(({ e, link }) => (
              <button
                key={`i-${e.id}-${link.type}`}
                type="button"
                onClick={() => select(e.id)}
                className="flex items-center gap-2 py-1 text-left"
                style={{ color: 'var(--color-ink-mid)' }}
              >
                <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>←</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.name}</span>
                <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
                  {link.type}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(at || entity.date) && (
        <div className="mt-4 px-4">
          <div className="t-micro mb-2">其他</div>
          {at && (
            <div className="text-[12.5px]" style={{ color: 'var(--color-ink-soft)' }}>
              发生地点：{at.name}
            </div>
          )}
          {entity.date && (
            <div className="t-num mt-1" style={{ color: 'var(--color-ink-faint)' }}>
              {novel?.project.calendar.name} · {entity.date.year}
            </div>
          )}
        </div>
      )}

      <div
        className="mt-4 px-4 pb-5 text-[11px]"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        {countWords(entity.body)} 字正文 · 在「设定」里编辑全文
      </div>
    </div>
  )
}
