/* ============================================================
   把「字典」并进「概念」

   为什么并：
   词条（Term）和条目（Entity）几乎是同一个东西 —— 名字、说明、正文、
   关系、搜索。唯一的差别是词条多了「读音」「直译」两个字段，以及
   「哪些词被引用但还没解释」的检查。前者是自定义字段，后者本来应该是
   「断链报告」（对所有条目都成立），都不需要再存一份数据。

   而且分开存必然出矛盾：[[息]] 的跳转只认条目，词条在字典里算「已解释」，
   于是警告没了、链接却还是死的。一份数据、多处视图，这条规矩也适用于词。

   迁移只做一次（幂等地做）：
   · 每个词 → 一个「概念」条目，读音/直译进自定义字段，定义进正文
   · 概念类型补上「读音」「直译」两个字段声明（老项目也要补）
   · 词条列表清空；`词条.json` 继续写空数组，老文件仍然读得动
   ============================================================ */

import { createEntity, type Entity, type Novel } from './types'

/** 概念类型补齐的两个字段。定义在各条目的 fields 里 */
export const CONCEPT_TERM_FIELDS = [
  { key: '读音', label: '读音' },
  { key: '直译', label: '直译' },
] as const

export interface TermMigration {
  novel: Novel
  /** 真的动了东西才为 true：调用方据此安排一次落盘 */
  changed: boolean
  /** 迁移成概念条目的词数 */
  migrated: number
  /** 名字已经被别的条目占了、于是内容并进那条的个数 */
  mergedIntoExisting: number
}

/**
 * 同名的条目已经存在时，把词里的内容并进去，而不是再造一个同名条目
 * （同名条目在 [[双括号]] 里是没法区分的）。
 */
function appendToBody(e: Entity, definition: string, extra: string): string {
  const body = e.body ?? ''
  const text = definition.trim()
  if (!text) return body
  if (body.includes(text)) return body
  const block = [extra ? `${extra}` : '', text].filter(Boolean).join('\n\n')
  return body.trim() ? `${body.replace(/\s+$/, '')}\n\n${block}` : block
}

export function migrateTerms(n: Novel): TermMigration {
  const terms = Array.isArray(n.terms) ? n.terms : []
  const conceptSchema = n.project.fieldSchemas?.concept ?? []
  const have = new Set(conceptSchema.map((f) => f.key))
  const addFields = CONCEPT_TERM_FIELDS.filter((f) => !have.has(f.key))

  if (terms.length === 0 && addFields.length === 0) {
    return { novel: n, changed: false, migrated: 0, mergedIntoExisting: 0 }
  }

  const entities = [...n.entities]
  const byName = new Map(entities.map((e) => [e.name, e]))
  let migrated = 0
  let mergedIntoExisting = 0

  for (const t of terms) {
    const name = (t.term ?? '').trim()
    if (!name) continue
    const definition = t.definition ?? ''
    const pronunciation = (t.pronunciation ?? '').trim()
    const gloss = (t.gloss ?? '').trim()
    // 老字典把「和某个条目有关」写成了「参与」，那对词讲不通，落成「相关」
    const links = (t.links ?? []).map((l) => ({ ...l, type: '相关' }))

    const existing = byName.get(name)
    if (existing) {
      const extra = [pronunciation && `读音：${pronunciation}`, gloss && `直译：${gloss}`]
        .filter(Boolean)
        .join('　')
      const nextBody = appendToBody(existing, definition, extra ? `（原词条）${extra}` : '')
      const merged: Entity = {
        ...existing,
        body: nextBody,
        fields: {
          ...(existing.fields ?? {}),
          ...(pronunciation ? { 读音: pronunciation } : {}),
          ...(gloss ? { 直译: gloss } : {}),
        },
      }
      const at = entities.indexOf(existing)
      entities[at] = merged
      byName.set(name, merged)
      mergedIntoExisting++
      continue
    }

    const entity: Entity = {
      ...createEntity('concept', name),
      body: definition,
      links,
      ...(gloss ? { summary: gloss } : {}),
      fields: {
        ...(pronunciation ? { 读音: pronunciation } : {}),
        ...(gloss ? { 直译: gloss } : {}),
      },
    }
    entities.push(entity)
    byName.set(name, entity)
    migrated++
  }

  const next: Novel = {
    ...n,
    entities,
    // 词条列表清空：内容已经在条目里了。留着只会再长出第二份真相。
    terms: [],
    project: {
      ...n.project,
      fieldSchemas: {
        ...n.project.fieldSchemas,
        concept: [...conceptSchema, ...addFields],
      },
    },
  }

  return {
    novel: next,
    changed: migrated > 0 || mergedIntoExisting > 0 || addFields.length > 0,
    migrated,
    mergedIntoExisting,
  }
}
