/* ============================================================
   全文搜索

   为什么值得单独做一层：
   设定库里最真实的痛苦不是「没有条目」，而是「我记得在某处写过
   这件事，但找不到」。只搜名字等于没搜 —— 真正的信息藏在正文、
   自定义字段（能力/外貌/动机）、关系备注和大纲里。

   设计取舍：
   1. 分级权重而不是模糊打分。模糊打分的排序结果难以解释，
      作者看到「为什么这条排第一」会困惑。分级是确定的、可预期的。
   2. 一次线性扫描，不做倒排索引。几百个条目、几十万字正文下，
      线性扫描是毫秒级；倒排索引会带来增量维护的复杂度，
      而我们的数据可能被外部随时改写（文件优先），索引反而容易过期。
   3. 每命中一处都给上下文片段。只给「命中 3 次」对作者没有帮助，
      他要看到那句话。
   ============================================================ */

import type { Entity, Novel, OutlineNode } from './types'

export type HitKind = 'character' | 'location' | 'event' | 'faction' | 'item' | 'concept'

export type HitField =
  | 'name'
  | 'tag'
  | 'summary'
  | 'field'
  | 'linkNote'
  | 'body'
  | 'outline'
  | 'term'
  | 'termDefinition'

export interface SearchHit {
  /** 唯一键：同一实体的同类字段只保留最高分那一条 */
  key: string
  kind: HitKind | 'outline' | 'term'
  /** 实体 id / 大纲节点 id / 词条 id */
  id: string
  title: string
  /** 实体类型；大纲与词条为空 */
  entityType?: Entity['type']
  score: number
  field: HitField
  /** 命中字段的人类可读名，例如「正文」「能力」「关系备注」 */
  fieldLabel: string
  /** 上下文片段，命中词用 ⟪⟫ 标出（渲染时替换成高亮） */
  snippet: string
  /** 该实体在所有字段里命中的总次数，用于给「还有 N 处」提示 */
  totalMatches: number
}

/** 字段权重。数值本身不重要，重要的是层级关系确定且可解释。 */
const SCORE = {
  nameExact: 1000,
  namePrefix: 800,
  nameContains: 600,
  tag: 400,
  summary: 300,
  field: 250,
  linkNote: 200,
  body: 100,
  outline: 150,
  termExact: 900,
  term: 500,
  termDefinition: 200,
} as const

const FIELD_LABEL: Record<HitField, string> = {
  name: '名称',
  tag: '标签',
  summary: '一句话',
  field: '自定义字段',
  linkNote: '关系备注',
  body: '正文',
  outline: '大纲',
  term: '词条',
  termDefinition: '词条释义',
}

/** 命中标记。用特殊括号而不是 HTML 标签，避免下游必须处理转义 */
const MARK_OPEN = '⟪'
const MARK_CLOSE = '⟫'

interface MatchInfo {
  count: number
  index: number
}

/** 在 haystack 里找 needle，返回命中次数与首次位置 */
function find(haystack: string, needle: string): MatchInfo {
  if (!haystack || !needle) return { count: 0, index: -1 }
  const hay = haystack.toLowerCase()
  const idx = hay.indexOf(needle)
  if (idx === -1) return { count: 0, index: -1 }
  let count = 0
  let p = idx
  while (p !== -1) {
    count++
    p = hay.indexOf(needle, p + needle.length)
  }
  return { count, index: idx }
}

/**
 * 截取命中附近的上下文。
 * 片段长度按字符算，中文一个字就是一个字符，所以 60 字符左右刚好
 * 是一屏能读完的两行。
 */
function snippetAround(
  text: string,
  needle: string,
  radius = 34,
  maxSnippets = 2,
): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!needle) return flat.slice(0, radius * 2)
  const hay = flat.toLowerCase()

  const marks: number[] = []
  let p = hay.indexOf(needle)
  while (p !== -1 && marks.length < maxSnippets) {
    marks.push(p)
    p = hay.indexOf(needle, p + needle.length)
  }
  if (marks.length === 0) return flat.slice(0, radius * 2)

  const pieces: string[] = []
  for (const m of marks) {
    const start = Math.max(0, m - radius)
    const end = Math.min(flat.length, m + needle.length + radius)
    const head = start > 0 ? '…' : ''
    const tail = end < flat.length ? '…' : ''
    const before = flat.slice(start, m)
    const hit = flat.slice(m, m + needle.length)
    const after = flat.slice(m + needle.length, end)
    pieces.push(`${head}${before}${MARK_OPEN}${hit}${MARK_CLOSE}${after}${tail}`)
  }
  return pieces.join(' ／ ')
}

/** 把片段拆成 [{text, hit}] 供渲染高亮，避免下游再解析标记 */
export function parseSnippet(snippet: string): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = []
  let rest = snippet
  while (rest.length > 0) {
    const open = rest.indexOf(MARK_OPEN)
    if (open === -1) {
      out.push({ text: rest, hit: false })
      break
    }
    const close = rest.indexOf(MARK_CLOSE, open + 1)
    if (close === -1) {
      out.push({ text: rest, hit: false })
      break
    }
    if (open > 0) out.push({ text: rest.slice(0, open), hit: false })
    out.push({ text: rest.slice(open + 1, close), hit: true })
    rest = rest.slice(close + 1)
  }
  return out.filter((p) => p.text.length > 0)
}

function walkOutline(
  nodes: OutlineNode[],
  visit: (node: OutlineNode) => void,
): void {
  for (const n of nodes) {
    visit(n)
    walkOutline(n.children, visit)
  }
}

/**
 * 搜一整部小说。
 *
 * 同一个实体的同一个字段只保留一条结果（分数最高的那次命中），
 * 否则搜一个高频词会刷出上百条同一个角色的正文命中，把别的结果挤没。
 */
export function searchNovel(novel: Novel, rawQuery: string, limit = 40): SearchHit[] {
  const q = rawQuery.trim().toLowerCase()
  if (q.length === 0) return []

  const hits = new Map<string, SearchHit>()

  const offer = (hit: SearchHit) => {
    const prev = hits.get(hit.key)
    if (!prev || hit.score > prev.score) hits.set(hit.key, hit)
    else if (prev) prev.totalMatches = Math.max(prev.totalMatches, hit.totalMatches)
  }

  /* ---------- 实体 ---------- */
  for (const e of novel.entities) {
    let total = 0
    const id = e.id
    const base = { id, title: e.name, entityType: e.type }

    // 名称：精确 > 前缀 > 包含
    const nameLower = e.name.toLowerCase()
    if (nameLower === q) {
      total++
      offer({ ...base, key: `${id}:name`, kind: e.type, score: SCORE.nameExact, field: 'name', fieldLabel: FIELD_LABEL.name, snippet: e.name, totalMatches: 1 })
    } else if (nameLower.startsWith(q)) {
      total++
      offer({ ...base, key: `${id}:name`, kind: e.type, score: SCORE.namePrefix, field: 'name', fieldLabel: FIELD_LABEL.name, snippet: e.name, totalMatches: 1 })
    } else if (nameLower.includes(q)) {
      total++
      offer({ ...base, key: `${id}:name`, kind: e.type, score: SCORE.nameContains, field: 'name', fieldLabel: FIELD_LABEL.name, snippet: e.name, totalMatches: 1 })
    }

    const tagHit = e.tags.find((t) => t.toLowerCase().includes(q))
    if (tagHit) {
      total++
      offer({ ...base, key: `${id}:tag`, kind: e.type, score: SCORE.tag, field: 'tag', fieldLabel: FIELD_LABEL.tag, snippet: tagHit, totalMatches: 1 })
    }

    if (e.summary) {
      const m = find(e.summary, q)
      if (m.count > 0) {
        total += m.count
        offer({ ...base, key: `${id}:summary`, kind: e.type, score: SCORE.summary, field: 'summary', fieldLabel: FIELD_LABEL.summary, snippet: snippetAround(e.summary, q), totalMatches: m.count })
      }
    }

    // 自定义字段：能力、外貌、动机这些往往是信息密度最高的地方
    if (e.fields) {
      for (const [k, v] of Object.entries(e.fields)) {
        if (!v) continue
        const m = find(v, q)
        if (m.count > 0) {
          total += m.count
          offer({ ...base, key: `${id}:field:${k}`, kind: e.type, score: SCORE.field, field: 'field', fieldLabel: k, snippet: snippetAround(v, q), totalMatches: m.count })
        }
      }
    }

    // 关系备注：写在这里的往往是「为什么他们是这种关系」的关键
    for (const l of e.links) {
      if (!l.note) continue
      const m = find(l.note, q)
      if (m.count > 0) {
        total += m.count
        const target = novel.entities.find((x) => x.id === l.to)
        const label = target ? `${l.type} · ${target.name}` : l.type
        offer({ ...base, key: `${id}:link:${l.to}:${l.type}`, kind: e.type, score: SCORE.linkNote, field: 'linkNote', fieldLabel: label, snippet: snippetAround(l.note, q), totalMatches: m.count })
      }
    }

    if (e.body) {
      const m = find(e.body, q)
      if (m.count > 0) {
        total += m.count
        offer({ ...base, key: `${id}:body`, kind: e.type, score: SCORE.body, field: 'body', fieldLabel: FIELD_LABEL.body, snippet: snippetAround(e.body, q), totalMatches: m.count })
      }
    }

    // 把总命中次数回填到该实体的全部结果上，供「还有 N 处」提示
    if (total > 0) {
      for (const h of hits.values()) {
        if (h.id === id) h.totalMatches = total
      }
    }
  }

  /* ---------- 大纲 ---------- */
  const outlineVisit = (n: OutlineNode) => {
    const inTitle = find(n.title, q)
    const inSummary = find(n.summary, q)
    const inPlot = n.plotlines.find((p) => p.toLowerCase().includes(q))
    const count = inTitle.count + inSummary.count + (inPlot ? 1 : 0)
    if (count === 0) return
    const snippet = inSummary.count > 0 ? snippetAround(n.summary, q) : n.title
    offer({
      key: `outline:${n.id}`,
      kind: 'outline',
      id: n.id,
      title: n.title,
      score: SCORE.outline + (inTitle.count > 0 ? 100 : 0),
      field: 'outline',
      fieldLabel: n.kind === 'volume' ? '卷' : n.kind === 'chapter' ? '章' : '场景',
      snippet,
      totalMatches: count,
    })
  }
  walkOutline(novel.outline, outlineVisit)

  /* 词条（term）不再单列：字典已经并进「概念」条目，词就是条目，
     条目本来就搜得到。老数据由 adopt 里的迁移搬到条目里。 */

  return Array.from(hits.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // 同分时命中次数多的排前面，然后按标题稳定排序
      if (b.totalMatches !== a.totalMatches) return b.totalMatches - a.totalMatches
      return a.title.localeCompare(b.title, 'zh-Hans-CN')
    })
    .slice(0, limit)
}

/** 供界面显示的分类标签 */
export function hitKindLabel(kind: SearchHit['kind']): string {
  if (kind === 'outline') return '大纲'
  if (kind === 'term') return '词条'
  const map: Record<string, string> = {
    character: '角色',
    location: '地点',
    event: '事件',
    faction: '势力',
    item: '物品',
    concept: '概念',
  }
  return map[kind] ?? kind
}
