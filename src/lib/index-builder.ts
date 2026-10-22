/* ============================================================
   内存索引：从实体数组算出所有派生结构
   
   文件是真相，索引只是缓存。任何时候索引都可以整个丢掉重建。
   这也是为什么改文件、绘工编辑文件都能被正确反映。
   
   核心工作：把「单向书写」的 links 变成双向可见的系系。
   你在林昭里写「林昭 → 苏无咎：宿敌」，苏无咎那边自动能看到
   「← 林昭：宿敌」。你永远不用写两遍，也不会出现单边幽灵系系。
   ============================================================ */

import type {
  Backlink,
  Entity,
  EntityType,
  Novel,
  NovelIndex,
  Project,
} from './types'
import { compareDates } from './dates'
import { resolvePlace } from './places'

export type LinkDirection = 'out' | 'in'

export interface ResolvedLink extends Backlink {
  direction: LinkDirection
  /** 被指向实体（out 时是对方，in 时是自己） */
  other: Entity
}

export function buildIndex(novel: Novel): NovelIndex {
  const byId = new Map<string, Entity>()
  for (const e of novel.entities) byId.set(e.id, e)

  const linksOf = new Map<string, Backlink[]>()
  const dangling: NovelIndex['dangling'] = []
  const byTag = new Map<string, string[]>()

  const push = (id: string, b: Backlink) => {
    const list = linksOf.get(id)
    if (list) list.push(b)
    else linksOf.set(id, [b])
  }

  for (const e of novel.entities) {
    for (const l of e.links) {
      const target = byId.get(l.to)
      if (!target) {
        dangling.push({ fromId: e.id, to: l.to, type: l.type })
        continue
      }
      // 出边：从 e 的视角
      push(e.id, {
        fromId: e.id,
        fromName: e.name,
        fromType: e.type,
        type: l.type,
        note: l.note,
      })
      // 入边：从目标的视角，名字用 e 的
      push(l.to, {
        fromId: e.id,
        fromName: e.name,
        fromType: e.type,
        type: l.type,
        note: l.note,
      })
    }

    for (const t of e.tags) {
      const list = byTag.get(t)
      if (list) list.push(e.id)
      else byTag.set(t, [e.id])
    }
  }

  // 搜索：名字 > 标签 > 摘要 > 正文，命中越靠前权重越高
  const search = (query: string): Entity[] => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const scored: Array<{ e: Entity; score: number }> = []
    for (const e of novel.entities) {
      let score = 0
      const name = e.name.toLowerCase()
      if (name === q) score = 100
      else if (name.startsWith(q)) score = 80
      else if (name.includes(q)) score = 60
      if (score === 0 && e.tags.some((t) => t.toLowerCase().includes(q))) score = 40
      if (score === 0 && e.summary?.toLowerCase().includes(q)) score = 25
      if (score === 0 && e.body.toLowerCase().includes(q)) score = 12
      if (score > 0) scored.push({ e, score })
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.e)
  }

  return { byId, linksOf, dangling, byTag, search }
}

/**
 * 取一个实体的全部系系，出边和入边分开，各自内部按类型聚拢。
 * 界面上的「系系」区块就是吃这个。
 */
export function resolveLinks(
  entity: Entity,
  index: NovelIndex,
): { out: ResolvedLink[]; in: ResolvedLink[] } {
  const out: ResolvedLink[] = []
  const seenOut = new Set<string>()

  for (const l of entity.links) {
    const other = index.byId.get(l.to)
    if (!other) continue
    const key = `out:${l.to}:${l.type}`
    if (seenOut.has(key)) continue
    seenOut.add(key)
    out.push({
      fromId: entity.id,
      fromName: entity.name,
      fromType: entity.type,
      type: l.type,
      note: l.note,
      direction: 'out',
      other,
    })
  }

  const ins: ResolvedLink[] = []
  const seenIn = new Set<string>()
  for (const e of Array.from(index.linksOf.get(entity.id) ?? [])) {
    // linksOf 同时含出边和入边，这里只保留别人指向我的
    if (e.fromId === entity.id) continue
    const other = index.byId.get(e.fromId)
    if (!other) continue
    const key = `in:${e.fromId}:${e.type}`
    if (seenIn.has(key)) continue
    seenIn.add(key)
    ins.push({ ...e, direction: 'in', other })
  }

  return { out, in: ins }
}

/* ---------------- 查询辅助 ---------------- */

export function entitiesOfType(novel: Novel, type: EntityType): Entity[] {
  return novel.entities
    .filter((e) => e.type === type)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/** 某地点系联的角色与事件：图谱和地图侧栏都要用。
    `at` 走一次解析 —— 事件的地点可能是地图区域，而那个区域绑的就是这个地点。 */
export function relatedAt(novel: Novel, locationId: string): Entity[] {
  const out: Entity[] = []
  for (const e of novel.entities) {
    if (resolvePlace(novel, e.at)?.entityId === locationId) out.push(e)
    else if (e.links.some((l) => l.to === locationId && (l.type === '常驻' || l.type === '出生地')))
      out.push(e)
  }
  return out
}

/**
 * 一场事件里的角色（参与角色）。
 *
 * 「参与」这条系系是单向书写的：可能写在事件上（在事件里选参与角色），
 * 也可能写在角色上（绘绘连线或者老文件）。两个方向都算，
 * 否则同一个信息会因为「写在谁那边」而有时看得见有时看不见。
 */
export function castOf(novel: Novel, eventId: string): Entity[] {
  const byId = new Map(novel.entities.map((e) => [e.id, e]))
  const ev = byId.get(eventId)
  const out: Entity[] = []
  const seen = new Set<string>()
  const add = (e: Entity | undefined) => {
    if (!e || e.type !== 'character' || seen.has(e.id)) return
    seen.add(e.id)
    out.push(e)
  }

  if (ev) for (const l of ev.links) if (l.type.includes('参与')) add(byId.get(l.to))
  for (const e of novel.entities) {
    if (e.type !== 'character') continue
    if (e.links.some((l) => l.type.includes('参与') && l.to === eventId)) add(e)
  }
  return out
}

/** 按世界内时间排序的实体，时间线吃这个 */
export function entitiesByDate(novel: Novel): Entity[] {
  return novel.entities
    .filter((e) => e.date)
    .sort((a, b) => compareDates(a.date, b.date, novel.project.calendar))
}

/** 项目统计，用在概览和空状态里 */
export function projectStats(novel: Novel) {
  const counts = {} as Record<EntityType, number>
  for (const e of novel.entities) counts[e.type] = (counts[e.type] ?? 0) + 1
  const linkCount = novel.entities.reduce((sum, e) => sum + e.links.length, 0)
  const countOutline = (nodes: Novel['outline']): number =>
    nodes.reduce((sum, n) => sum + 1 + countOutline(n.children), 0)
  return {
    entities: novel.entities.length,
    links: linkCount,
    outlineNodes: countOutline(novel.outline),
    terms: novel.terms.length,
    counts,
  }
}

/**
 * 图谱用的邻接数据。
 * depth 控制从中心往外扩几圈，避免一次渲染几千条线。
 */
export function graphNeighborhood(
  centerId: string,
  index: NovelIndex,
  depth = 2,
): { nodes: Entity[]; edges: Array<{ source: string; target: string; type: string }> } {
  const nodes = new Map<string, Entity>()
  const edges = new Map<string, { source: string; target: string; type: string }>()
  const center = index.byId.get(centerId)
  if (!center) return { nodes: [], edges: [] }
  nodes.set(center.id, center)

  let frontier = [center.id]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      const e = index.byId.get(id)
      if (!e) continue
      const linked = [
        ...e.links.map((l) => ({ other: l.to, type: l.type })),
        ...Array.from(index.linksOf.get(id) ?? [])
          .filter((b) => b.fromId !== id)
          .map((b) => ({ other: b.fromId, type: b.type })),
      ]
      for (const { other, type } of linked) {
        const target = index.byId.get(other)
        if (!target) continue
        const key = [id, other].sort().join('|') + `|${type}`
        if (!edges.has(key)) edges.set(key, { source: id, target: other, type })
        if (!nodes.has(other)) {
          nodes.set(other, target)
          next.push(other)
        }
      }
    }
    frontier = next
  }

  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) }
}

/** 未连接的实体，图谱里单独提示，避免「孤岛」被忽略 */
export function isolatedEntities(novel: Novel): Entity[] {
  const linked = new Set<string>()
  for (const e of novel.entities) {
    for (const l of e.links) {
      linked.add(e.id)
      linked.add(l.to)
    }
  }
  return novel.entities.filter((e) => !linked.has(e.id))
}

export function projectUpdated(project: Project): Project {
  return { ...project, updatedAt: Date.now() }
}
