/* ============================================================
   手绘图谱：几何与布局

   和 views/GraphView.tsx 的区别：
   那个是「力导向模拟」—— 节点自己找位置、互相推挤，你只能观察。
   这个是「自由摆放」—— 你拖进来、自己排、自己连线，像在纸上画。
   两种模式解决的是不同需求，所以是两套代码，不是一套的两个开关。

   几何计算全在这里，纯函数，不碰 React。这样能测，
   而且画布组件的代码能保持在「只负责画和收事件」的规模。
   ============================================================ */

import type { Entity, EntityLink, LinkColor, LinkDash, LinkDirection } from './types'
import { linkColorHex } from './types'

/** 画布的虚拟坐标系。所有位置都存在这个空间里。 */
export const CANVAS_W = 2000
export const CANVAS_H = 1400

/** 节点方格的边长（虚拟坐标）*/
export const NODE_W = 132
export const NODE_H = 46

/**
 * 连线与方格之间留出的空隙。
 *
 * 为什么需要它：线原来精确裁到方格边框上，箭头尖正好压在边框，
 * 斜向的线还会因为裁切用的是「中心到中心」方向而偏出实际交点，
 * 结果箭头被方格盖住（线画在方格下面）。
 * 留 7px 之后箭头和边框之间有可见的呼吸空间。
 */
export const NODE_GAP = 7

/** 关系名最长显示多少个字，超出截断。防止长文字盖住旁边的线 */
export const LABEL_MAX_CHARS = 10

/** 默认视图 id。第一次打开手绘图谱时用它。 */
export const DEFAULT_VIEW_ID = 'main'

export function nodeCenter(x: number, y: number): { x: number; y: number } {
  return { x: x + NODE_W / 2, y: y + NODE_H / 2 }
}

/**
 * 拖动落点 → 节点左上角坐标。
 * 以落点为中心放置，符合「我把它扔在这里」的直觉；
 * 然后夹进画布范围内，免得拖到边上就再也点不到。
 */
export function placeAt(dropX: number, dropY: number): { x: number; y: number } {
  return {
    x: clamp(dropX - NODE_W / 2, 0, CANVAS_W - NODE_W),
    y: clamp(dropY - NODE_H / 2, 0, CANVAS_H - NODE_H),
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 取某个条目在某个视图下的位置 */
export function positionOf(entity: Entity, viewId: string): { x: number; y: number } | null {
  const hit = entity.graphPos?.find((p) => p.viewId === viewId)
  return hit ? { x: hit.x, y: hit.y } : null
}

/** 写入/更新某视图下的位置，返回新的 graphPos 数组 */
export function withPosition(
  entity: Entity,
  viewId: string,
  x: number,
  y: number,
): NonNullable<Entity['graphPos']> {
  const rest = (entity.graphPos ?? []).filter((p) => p.viewId !== viewId)
  return [...rest, { viewId, x, y }]
}

/** 移除某视图下的位置（从画面里拿掉，但条目本身还在）*/
export function withoutPosition(
  entity: Entity,
  viewId: string,
): NonNullable<Entity['graphPos']> {
  return (entity.graphPos ?? []).filter((p) => p.viewId !== viewId)
}

/* ---------------- 连线 ---------------- */

export interface LaidOutNode {
  id: string
  entity: Entity
  x: number
  y: number
  cx: number
  cy: number
}

export interface LaidOutEdge {
  /** 稳定 key：同一对格子之间的第 N 条线，用来区分并行连线 */
  key: string
  fromId: string
  toId: string
  type: string
  note?: string
  dir: LinkDirection
  dash: LinkDash
  /** 这条线自己的颜色（没设则为 undefined，渲染时按关系名推导） */
  color?: LinkColor
  /** 两端中心点 */
  x1: number
  y1: number
  x2: number
  y2: number
  /** 曲线起止点：已经裁到方格边缘 */
  sx: number
  sy: number
  ex: number
  ey: number
  /**
   * 线段中点（不是曲线中点）。
   * 多条线时每条的中点是「中点 + 法线 × 偏移」，所以彼此分得很开。
   */
  mx: number
  my: number
  /** 散开量。0 表示这条线走中线 */
  offset: number
  /** 线段的单位法线方向，画标注和命中测试都要用 */
  nx: number
  ny: number
  /**
   * 这条线的绘制方向是否与数据里的方向相反。
   * 布局时为了稳定会按节点 id 排序决定两端，所以画箭头时要靠它还原真实方向。
   */
  reversed: boolean
}

/** 两格之间有多条线时，每条线横向散开的距离 */
const PARALLEL_GAP = 30

export interface CanvasGraph {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  /** 在这个视图里有链接但没被拖进来的条目，用来提示「还有东西可以加」*/
  notPlaced: Entity[]
}

/**
 * 把数据整理成可绘制的东西。
 *
 * 只画「两端都已经放上画布」的连线 —— 一端没放的画不出来，
 * 但那条关系会在侧栏的条目上标出来，提示你把它也拖进来。
 */
export function layoutGraph(
  entities: Entity[],
  viewId: string,
  opts: { showDangling?: boolean } = {},
): CanvasGraph {
  const nodes: LaidOutNode[] = []
  const byId = new Map<string, Entity>()

  for (const e of entities) {
    byId.set(e.id, e)
    const pos = positionOf(e, viewId)
    if (!pos) continue
    const c = nodeCenter(pos.x, pos.y)
    nodes.push({ id: e.id, entity: e, x: pos.x, y: pos.y, cx: c.x, cy: c.y })
  }

  const placed = new Map(nodes.map((n) => [n.id, n]))
  const edges: LaidOutEdge[] = []

  /* 先按「无序节点对」把关系分组。
     分组的目的是让同一对格子之间的多条线各自散开 ——
     否则两条单项箭头会画在同一条轨迹上，完全看不出是两条。 */
  interface Pending {
    a: LaidOutNode
    b: LaidOutNode
    type: string
    note?: string
    dir: LinkDirection
    dash: LinkDash
    color?: LinkColor
  }
  const groups = new Map<string, Pending[]>()
  const groupOrder: string[] = []

  for (const n of nodes) {
    for (const l of n.entity.links) {
      const other = placed.get(l.to)
      if (!other) continue // 另一端没放上画布

      const pairKey = [n.id, l.to].sort().join('|')
      const bucket = groups.get(pairKey) ?? []

      /* 每一条 links 记录都画成自己的一条线。
         为什么不合并两边写下的同类型关系：
         合并之后删除只能两边一起删，作者无法只删掉一条 ——
         而「甲→乙 师徒」和「乙→甲 师徒」在语义上本来就是两件事。
         所以这里不做去重，各自成线，各自可编辑、可单独删除。 */
      bucket.push({
        a: n,
        b: other,
        type: l.type,
        note: l.note,
        dir: l.dir ?? 'forward',
        dash: l.dash ?? 'solid',
        color: l.color,
      })
      if (!groups.has(pairKey)) {
        groups.set(pairKey, bucket)
        groupOrder.push(pairKey)
      }
    }
  }

  for (const pairKey of groupOrder) {
    const list = groups.get(pairKey) ?? []
    // 排序让线序稳定：不排的话编辑一次线的位置就会跳。
    // 先按关系名，再按方向（谁指向谁）—— 光靠关系名不够，
    // 因为「甲→乙 师徒」和「乙→甲 师徒」名字相同。
    const ordered = [...list].sort((x, y) => {
      if (x.type !== y.type) return x.type < y.type ? -1 : 1
      if (x.a.id !== y.a.id) return x.a.id < y.a.id ? -1 : 1
      return 0
    })
    const count = ordered.length

    for (let i = 0; i < count; i++) {
      const p = ordered[i]
      // 散开量：只有一条线时走中线；多条时以中心对称分布，
      // 两条在 ±15，三条在 -30/0/+30
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * PARALLEL_GAP

      /* 关键：a 与 b 必须按节点的固定次序（id 字典序）确定，
         不能用「关系写在谁那里」来决定。
         否则同一条线的两端谁在前会随数据变动，法线方向也跟着翻转，
         偏移量正负相抵，两条线会画在同一条轨迹上。
         这是实测踩到的坑：不排序时两条线的中点完全重合。 */
      const [first, second] = p.a.id <= p.b.id ? [p.a, p.b] : [p.b, p.a]
      const seg = trimToBoxes(first, second)
      const dx = seg.x2 - seg.x1
      const dy = seg.y2 - seg.y1
      const len = Math.hypot(dx, dy) || 1
      // 法线方向在固定次序下是稳定的
      const nx = -dy / len
      const ny = dx / len
      // 记录这条线在数据里的实际方向，供箭头使用（dir 是绝对语义）
      const reversed = first.id !== p.a.id

      /* 整条线段（含两端）都沿法线平移 offset，而不是画成曲线。
         为什么不用曲线：贝塞尔在中点附近的两条曲线几乎重合，
         关系名会叠在一起、看起来还是被覆盖。平行直线分得最开，
         也最符合「两条并排的线」的直觉。 */
      const sx = seg.x1 + nx * offset
      const sy = seg.y1 + ny * offset
      const ex = seg.x2 + nx * offset
      const ey = seg.y2 + ny * offset

      // 线段的真正中点：因为整条都平移了，中点就是平移后的中点
      const labelX = (sx + ex) / 2
      const labelY = (sy + ey) / 2

      edges.push({
        // key 必须唯一定位一条 links 记录：同一对格子之间
        // 可以有多条同类型、甚至方向也相同的线，所以带上写入方和序号
        key: `${pairKey}|${p.type}|${p.a.id}|${i}`,
        fromId: p.a.id,
        toId: p.b.id,
        type: p.type,
        note: p.note,
        dir: p.dir,
        dash: p.dash,
        color: p.color,
        x1: p.a.cx,
        y1: p.a.cy,
        x2: p.b.cx,
        y2: p.b.cy,
        sx,
        sy,
        ex,
        ey,
        mx: labelX,
        my: labelY,
        offset,
        nx,
        ny,
        reversed,
      })
    }
  }

  // 有链接但没上画布的条目：侧栏据此提示「可以加进来」
  const notPlaced = entities.filter(
    (e) =>
      !placed.has(e.id) &&
      (e.links.some((l) => byId.has(l.to) && placed.has(l.to)) ||
        entities.some((o) => o.links.some((l) => l.to === e.id) && placed.has(o.id))),
  )

  if (opts.showDangling === false) {
    return { nodes, edges, notPlaced }
  }
  return { nodes, edges, notPlaced }
}

/**
 * 把一条中心连线裁到两个方格的边缘外侧。
 *
 * 空隙不是固定值，而是按两格之间的距离收缩：
 * 两个方格紧贴时，硬留 7px 会让线段反向（起点落到终点外面），
 * 所以空间不够就少留、贴死就不留。
 * 这样既保证箭头不插进方格，也不会产生反向的线。
 */
function trimToBoxes(
  a: LaidOutNode,
  b: LaidOutNode,
): { x1: number; y1: number; x2: number; y2: number } {
  /* 两格「边框之间」还剩下多少空间。
     注意不能取两个轴向上的最小间隔 —— 水平排列的两个方格在竖直方向
     间隔是 0，那样算出来余量永远是 0，空隙就永远留不出来。
     这里按中心距离减去格子尺寸来算，与排列方向无关。 */
  const span = Math.hypot(b.cx - a.cx, b.cy - a.cy) - Math.max(NODE_W, NODE_H)
  // 余量一半给这一端、一半给那端；余量不足就少留、贴死就不留。
  // 硬留会让线段反向（起点落到终点外面）。
  const gap = Math.min(NODE_GAP, Math.max(0, span / 2))

  const offA = boxOffset(a.cx, a.cy, b.cx, b.cy, gap)
  const offB = boxOffset(b.cx, b.cy, a.cx, a.cy, gap)
  return {
    x1: a.cx + offA.x,
    y1: a.cy + offA.y,
    x2: b.cx + offB.x,
    y2: b.cy + offB.y,
  }
}

/**
 * 从方格中心朝目标方向，走到「格子边框 + 空隙」上的偏移量。
 *
 * 用矩形边界求交而不是圆形近似：方格是矩形，圆形近似会让
 * 箭头和边框之间留一道斜向的缝。
 */
function boxOffset(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  gap: number,
): { x: number; y: number } {
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return { x: 0, y: 0 }

  const hw = NODE_W / 2 + gap
  const hh = NODE_H / 2 + gap
  // 沿射线走到边界所需的缩放系数
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(dx)
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(dy)
  const s = Math.min(scaleX, scaleY)
  return { x: dx * s, y: dy * s }
}

/* ---------------- 连线用的 SVG 路径与箭头 ---------------- */

/** 箭头长度 */
export const ARROW_LEN = 9
/** 箭头张角 */
const ARROW_SPREAD = 0.42

/** 生成一条连线的路径。现在是直线段（两端已按偏移平移）*/
export function edgePath(e: LaidOutEdge): string {
  return `M ${e.sx} ${e.sy} L ${e.ex} ${e.ey}`
}

export function arrowAt(e: LaidOutEdge): { from: string | null; to: string | null } {
  // 布局时按 id 排序决定了线段两端，箭头要按数据里的真实方向画，
  // 所以 reversed 时把首尾对调。
  const tipX = e.reversed ? e.sx : e.ex
  const tipY = e.reversed ? e.sy : e.ey
  const tailX = e.reversed ? e.ex : e.sx
  const tailY = e.reversed ? e.ey : e.sy

  const to = arrowPoints(tailX, tailY, tipX, tipY)
  const from = arrowPoints(tipX, tipY, tailX, tailY)
  return { from: e.dir === 'both' ? from : null, to: e.dir === 'none' ? null : to }
}

/**
 * 生成箭头三角形的点集。
 * 终点处箭头朝内收，起点处朝外 —— 两端都要的话就是两个三角形。
 */
export function arrowPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string | null {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len < 1) return null
  const ux = dx / len
  const uy = dy / len
  const tipX = x2
  const tipY = y2
  const baseX = x2 - ux * ARROW_LEN
  const baseY = y2 - uy * ARROW_LEN
  // 垂直方向
  const px = -uy
  const py = ux
  const w = ARROW_LEN * ARROW_SPREAD
  const p1 = `${tipX},${tipY}`
  const p2 = `${baseX + px * w},${baseY + py * w}`
  const p3 = `${baseX - px * w},${baseY - py * w}`
  return `${p1} ${p2} ${p3}`
}

/**
 * 关系名截断。
 *
 * 为什么必须截断：两条平行线的间距只有 60px 左右，一个 20 字的关系名
 * 会有 240px 宽，必然盖住隔壁线上的文字，还会挡住你对那一条的点击
 * （文字在上面，点击区被抢走）。
 * 截断到 10 字之后最宽约 130px，配合 60px 的间距仍可能轻微交叠，
 * 但已经不会完全盖住邻线的标签和它的点击区 —— 完整名字点开就能看到。
 */
export function truncateLabel(text: string, max = LABEL_MAX_CHARS): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/** 关系名显示的宽度。按截断后的文字算，保证不会无限变宽 */
export function labelWidth(text: string): number {
  const shown = truncateLabel(text)
  // 中文按全角估算：每字约 12px，两端各留 4px 内边距
  return Math.min(180, shown.length * 12 + 8)
}

/** 一个新条目拖进画布时，找一个不压到已有节点的位置 */
export function freeSpot(nodes: LaidOutNode[], dropX: number, dropY: number): { x: number; y: number } {
  const base = placeAt(dropX, dropY)
  const overlaps = (p: { x: number; y: number }) =>
    nodes.some(
      (n) =>
        Math.abs(n.x - p.x) < NODE_W + 12 && Math.abs(n.y - p.y) < NODE_H + 12,
    )
  if (!overlaps(base)) return base
  // 沿右下方向螺旋找空位，最多试 40 个点
  for (let ring = 1; ring <= 8; ring++) {
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ]) {
      const candidate = {
        x: clamp(base.x + dx * ring * (NODE_W + 16), 0, CANVAS_W - NODE_W),
        y: clamp(base.y + dy * ring * (NODE_H + 16), 0, CANVAS_H - NODE_H),
      }
      if (!overlaps(candidate)) return candidate
    }
  }
  return base
}

/** 关系线该用什么颜色。
 *  显式设了颜色就用它；没设则按关系名哈希到六个实体色之一，
 *  保证同名关系在任何图里颜色一致。 */
export function edgeColorVar(linkType: string, color?: LinkColor): string {
  const hex = linkColorHex(color)
  if (hex) return hex
  // 简单哈希到六个实体色之一，纯为了视觉上能区分不同关系名
  let h = 0
  for (let i = 0; i < linkType.length; i++) h = (h * 31 + linkType.charCodeAt(i)) >>> 0
  const vars = [
    '--color-e-character',
    '--color-e-location',
    '--color-e-event',
    '--color-e-faction',
    '--color-e-item',
    '--color-e-concept',
  ]
  return `var(${vars[h % vars.length]})`
}

/** 供界面显示：一条关系当前的方向与线型描述 */
export function describeEdge(dir: LinkDirection, dash: LinkDash): string {
  const d = dir === 'both' ? '双向' : dir === 'none' ? '无线头' : '单向'
  const s = dash === 'dashed' ? '虚线' : '实线'
  return `${d}${s}`
}

export type { EntityLink }
