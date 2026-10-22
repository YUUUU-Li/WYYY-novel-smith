/* ============================================================
   文件格式层：Markdown + YAML front matter 的读写
   
   为什么自己写一个极简 YAML 子集解析器而不装 js-yaml：
   我们要处理的只有「扁平标量 / 字符串数组 / 对象数组 / 嵌套对象」
   四种形状，可控。而且这层将来要挪到 Rust 侧（Tauri），
   保持格式简单能省掉一次移植风险。
   
   系键约束：解析失败绝不能吞掉用户数据。解析不了就退回纯文本。
   ============================================================ */

import type {
  Entity,
  EntityLink,
  EntityType,
  GraphPosition,
  LinkColor,
  LinkDirection,
  NovelDate,
} from './types'
import { LINK_COLORS } from './types'

/* ---------------- 极简 YAML 子集 ---------------- */

type Scalar = string | number | boolean
type YamlValue = Scalar | YamlValue[] | { [k: string]: YamlValue }

const FRONT_MATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** 把标量文本按需要加引号 */
function quoteIfNeeded(v: string): string {
  if (v === '') return "''"
  // 中文内容几乎总是安全，只有这些情况需要引号
  if (/^[\s]|[\s]$|[:#[\]{}",&*?|<>=!%@`]|^[-?]|^(true|false|null|~|\d+(\.\d+)?)$/i.test(v)) {
    return `'${v.replace(/'/g, "''")}'`
  }
  return v
}

function parseScalar(raw: string): YamlValue {
  const v = raw.trim()
  if (v === '') return ''
  if (/^(null|~)$/i.test(v)) return ''
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true'
  // 引号字符串
  if (
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2) ||
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
  ) {
    return v.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"')
  }
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  return v
}

/** 按逗号切分，但忽略引号内和括号内的逗号 */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      cur += ch
      if (ch === quote && s[i + 1] === quote) {
        cur += s[++i]
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

/** 解析 `{ a: 1, b: 'x' }` 或 `[a, b, c]` 或标量 */
function parseInline(raw: string): YamlValue {
  const v = raw.trim()
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (inner === '') return []
    return splitTopLevel(inner).map(parseInline)
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim()
    const obj: Record<string, YamlValue> = {}
    if (inner === '') return obj
    for (const part of splitTopLevel(inner)) {
      const idx = part.indexOf(':')
      if (idx === -1) continue
      const k = part.slice(0, idx).trim().replace(/^['"]|['"]$/g, '')
      obj[k] = parseInline(part.slice(idx + 1))
    }
    return obj
  }
  return parseScalar(v)
}

/**
 * 解析 front matter 文本。
 *
 * 支持两种块状结构，恰好覆盖我们序列化器产出的全部形状：
 *   key:
 *     - { to: 'x', type: 'y' }     ← 对象数组（links）
 *   key:
 *     子键: 值                      ← 一层嵌套对象（fields）
 *
 * 注意一个踩过的坑：不能用 `if (pendingItems)` 判断该写数组还是对象，
 * 因为空数组在 JS 里是真值，会把 fields 写成 []，字段在重开时全部丢失。
 * 必须显式看「哪一边真的收到了内容」。
 */
export function parseFrontMatter(text: string): {
  data: Record<string, YamlValue>
  body: string
} {
  const m = FRONT_MATTER_RE.exec(text)
  if (!m) return { data: {}, body: text }

  const lines = m[1].split(/\r?\n/)
  const data: Record<string, YamlValue> = {}

  /** 一个待收集内容的块级 key：不知道会收成数组还是对象，先两边都准备 */
  let blockKey: string | null = null
  let blockItems: YamlValue[] = []
  let blockObj: Record<string, YamlValue> = {}

  const flush = () => {
    if (blockKey === null) return
    // 优先级：收到过数组项就用数组，否则用对象，都没收到就是空对象
    if (blockItems.length > 0) data[blockKey] = blockItems
    else if (Object.keys(blockObj).length > 0) data[blockKey] = blockObj
    else data[blockKey] = {}
    blockKey = null
    blockItems = []
    blockObj = {}
  }

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const indentMatch = /^(\s+)(.*)$/.exec(line)

    // ---- 块内缩进行 ----
    if (indentMatch && blockKey !== null) {
      const rest = indentMatch[2].trim()

      if (rest.startsWith('- ')) {
        const itemRaw = rest.slice(2).trim()
        // `- key: value` 这种要留在数组里，不能退化成字符串
        if (/^[^\s:]+:\s/.test(itemRaw) || /^[^\s:]+:$/.test(itemRaw)) {
          const ci = itemRaw.indexOf(':')
          const obj: Record<string, YamlValue> = {}
          obj[itemRaw.slice(0, ci).trim()] = parseInline(itemRaw.slice(ci + 1))
          blockItems.push(obj)
        } else {
          blockItems.push(parseInline(itemRaw))
        }
        continue
      }

      const ci = rest.indexOf(':')
      if (ci !== -1) {
        const k = rest.slice(0, ci).trim()
        const v = parseInline(rest.slice(ci + 1))
        // 缩进键可能属于数组里最后一个对象，也可能是嵌套对象的子键
        const last = blockItems[blockItems.length - 1]
        if (last && typeof last === 'object' && !Array.isArray(last)) {
          ;(last as Record<string, YamlValue>)[k] = v
        } else {
          blockObj[k] = v
        }
        continue
      }
    }

    // ---- 顶层 key ----
    const ci = line.indexOf(':')
    if (ci === -1) continue
    flush()
    const key = line.slice(0, ci).trim()
    const rest = line.slice(ci + 1).trim()
    if (rest === '') {
      blockKey = key
    } else {
      data[key] = parseInline(rest)
    }
  }
  flush()

  return { data, body: text.slice(m[0].length) }
}

/* ---------------- 序列化 ---------------- */

/** 坐标只保留一位小数：再多只会让 diff 变吵，肉眼看不出差别 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function serializeDate(d: NovelDate): string {
  const parts: string[] = [`year: ${d.year}`]
  if (d.era) parts.push(`era: ${quoteIfNeeded(d.era)}`)
  if (d.month) parts.push(`month: ${quoteIfNeeded(d.month)}`)
  if (d.monthIndex !== undefined) parts.push(`monthIndex: ${d.monthIndex}`)
  if (d.day !== undefined) parts.push(`day: ${d.day}`)
  if (d.order !== undefined) parts.push(`order: ${d.order}`)
  return `{ ${parts.join(', ')} }`
}

function serializeLink(l: EntityLink): string {
  // 方向用子类型标记存（`to#both`），不占一个字段。
  // 理由：dir 只有三个短值，而一条系系里最常看的是 to 和 type；
  // 把方向挂上去比多一行键值更省地方，绘改文件时也更好读。
  // 老文件里没有 # 后缀，读的时候按默认的 forward 处理，向后兼容。
  const dirTag =
    l.dir === 'both' ? '#both' : l.dir === 'none' ? '#none' : l.dir === 'forward' ? '#fwd' : ''
  const parts = [`to: ${quoteIfNeeded(l.to + dirTag)}`, `type: ${quoteIfNeeded(l.type)}`]
  if (l.weight !== undefined) parts.push(`weight: ${l.weight}`)
  if (l.dash === 'dashed') parts.push('dashed: true')
  if (l.color) parts.push(`color: ${l.color}`)
  if (l.note) parts.push(`note: ${quoteIfNeeded(l.note)}`)
  return `{ ${parts.join(', ')} }`
}

function serializeArray(key: string, values: string[]): string | null {
  if (values.length === 0) return null
  return `${key}: [${values.map(quoteIfNeeded).join(', ')}]`
}

/**
 * 把一个实体序列化成 Markdown 文件。
 * 
 * 字段顺序是刻意的：先身份（id/type/name），再分类（tags），
 * 再系系（links），最后时间与地理。这样 diff 起来人是能读的。
 */
export function serializeEntity(e: Entity): string {
  const lines: string[] = ['---']
  lines.push(`id: ${quoteIfNeeded(e.id)}`)
  lines.push(`type: ${e.type}`)
  lines.push(`name: ${quoteIfNeeded(e.name)}`)

  const tags = serializeArray('tags', e.tags)
  if (tags) lines.push(tags)

  if (e.summary) lines.push(`summary: ${quoteIfNeeded(e.summary)}`)
  if (e.status) lines.push(`status: ${quoteIfNeeded(e.status)}`)
  if (e.date) lines.push(`date: ${serializeDate(e.date)}`)
  if (e.dateEnd) lines.push(`dateEnd: ${serializeDate(e.dateEnd)}`)
  if (e.at) lines.push(`at: ${quoteIfNeeded(e.at)}`)

  // 绘绘图谱的位置。坐标保留一位小数就够了 —— 再多只会让 diff 变吵
  if (e.graphPos && e.graphPos.length > 0) {
    lines.push('graphPos:')
    for (const p of e.graphPos) {
      lines.push(
        `  - { view: ${quoteIfNeeded(p.viewId)}, x: ${round1(p.x)}, y: ${round1(p.y)} }`,
      )
    }
  }

  if (e.fields && Object.keys(e.fields).length > 0) {
    lines.push('fields:')
    for (const [k, v] of Object.entries(e.fields)) {
      lines.push(`  ${k}: ${quoteIfNeeded(v)}`)
    }
  }

  if (e.links.length > 0) {
    lines.push('links:')
    for (const l of e.links) {
      lines.push(`  - ${serializeLink(l)}`)
    }
  }

  lines.push('---')
  lines.push('')
  return lines.join('\n') + (e.body.endsWith('\n') ? e.body : e.body + '\n')
}

/* ---------------- 反序列化 ---------------- */

/**
 * 数字字段的宽松转换。
 * 空值必须变成 undefined 而不是 0：否则「没填」会被写成
 * `monthIndex: null` 或 `weight: 0`，往返之后就多出假的字段。
 */
function optionalNumber(v: YamlValue | undefined): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  const s = String(v).trim()
  if (s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function toDate(v: YamlValue): NovelDate | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, YamlValue>
  const year = Number(o.year)
  if (!Number.isFinite(year)) return undefined
  return {
    year,
    era: typeof o.era === 'string' && o.era !== '' ? o.era : undefined,
    month: typeof o.month === 'string' && o.month !== '' ? o.month : undefined,
    monthIndex: optionalNumber(o.monthIndex),
    day: optionalNumber(o.day),
    order: optionalNumber(o.order),
  }
}

function toStringArray(v: YamlValue | undefined): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean)
  if (typeof v === 'string' && v.trim()) {
    // 容忍 `tags: a, b, c` 这种没写方括号的写法
    return v.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** 判断一个值是不是调色板里已知的颜色名 */
function isLinkColor(v: YamlValue | undefined): v is LinkColor {
  if (typeof v !== 'string') return false
  return LINK_COLORS.some((c) => c.value === v)
}

function toLinks(v: YamlValue | undefined): EntityLink[] {
  if (!Array.isArray(v)) return []
  const out: EntityLink[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, YamlValue>
    const rawTo = o.to !== undefined ? String(o.to) : ''
    if (!rawTo) continue
    const type = o.type !== undefined ? String(o.type) : ''
    if (!type) continue

    // 解出方向子类型标记。老文件没有它，按 forward 处理。
    let to = rawTo
    let dir: LinkDirection | undefined
    const hash = rawTo.lastIndexOf('#')
    if (hash > 0) {
      const tag = rawTo.slice(hash + 1)
      if (tag === 'both') {
        dir = 'both'
        to = rawTo.slice(0, hash)
      } else if (tag === 'none') {
        dir = 'none'
        to = rawTo.slice(0, hash)
      } else if (tag === 'fwd' || tag === 'forward') {
        dir = 'forward'
        to = rawTo.slice(0, hash)
      }
      // 认不出的标记就当它是名字的一部分，不要吞掉
    }

    out.push({
      to,
      type,
      dir,
      dash: o.dashed === true || o.dashed === 'true' ? 'dashed' : undefined,
      // 只接受调色板里已知的名字，未知值当作没设 ——
      // 免得绘改文件写错一个词就让线变成看不见的颜色
      color: isLinkColor(o.color) ? o.color : undefined,
      note: o.note !== undefined && String(o.note) !== '' ? String(o.note) : undefined,
      weight: optionalNumber(o.weight),
    })
  }
  return out
}

/** 解析绘绘图谱的位置数组 */
function toGraphPositions(v: YamlValue | undefined): GraphPosition[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: GraphPosition[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, YamlValue>
    const viewId = o.view !== undefined ? String(o.view) : ''
    const x = Number(o.x)
    const y = Number(o.y)
    if (!viewId || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ viewId, x, y })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 从 Markdown 文本还原实体。
 * filePath 只在有真实文件时才有意义（将来 Tauri 形态）。
 */
export function parseEntity(text: string, hint?: { id?: string; file?: string }): Entity {
  const { data, body } = parseFrontMatter(text)

  const type = String(data.type ?? 'concept') as EntityType

  const fields: Record<string, string> = {}
  if (data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields)) {
    for (const [k, v] of Object.entries(data.fields as Record<string, YamlValue>)) {
      fields[k] = String(v)
    }
  }

  return {
    id: String(data.id ?? hint?.id ?? ''),
    type,
    name: String(data.name ?? '未命名'),
    tags: toStringArray(data.tags),
    summary: data.summary !== undefined ? String(data.summary) : undefined,
    status: data.status !== undefined ? String(data.status) : undefined,
    links: toLinks(data.links),
    date: toDate(data.date),
    dateEnd: toDate(data.dateEnd),
    at: data.at !== undefined ? String(data.at) : undefined,
    graphPos: toGraphPositions(data.graphPos),
    fields: Object.keys(fields).length ? fields : undefined,
    body: body.replace(/^\r?\n/, ''),
    file: hint?.file,
  }
}

/* ---------------- 文件名 ---------------- */

/** Windows 不允许的字符要换掉，否则将来落盘会炸 */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '·')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '未命名'
  )
}
