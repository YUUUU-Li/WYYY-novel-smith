/* ============================================================
   正文里的 [[双括号]] 指向了不存在的东西

   这件事以前躲在「字典」里，而且只认「自造词」：既不是条目、也不在词典里
   的词才算。可「引用了一个不存在的东西」这件事，对角色、地点、事件全都
   一样要紧 —— 它是一条断链，不是一种文学术语问题。

   而且那时候它和跳转是两套判断：`[[息]]` 的跳转只解析条目，所以链接是死的；
   字典却把「息」算作已解释，于是警告也跟着消失了。现在只有一套判断：
   解析不到 = 断链，列出来，一键把它建成条目。
   ============================================================ */

import type { Novel } from './types'

export interface UnresolvedLink {
  name: string
  /** 在正文里出现了几次 */
  count: number
  /** 出现在哪些条目里（最多记 5 个，够用来找回去） */
  sources: Array<{ id: string; name: string }>
}

/** 和 cm-jump 用同一套写法：[[名字]] 或 [[名字|显示文字]]，不跨行 */
const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

export function unresolvedLinks(novel: Novel): UnresolvedLink[] {
  const names = new Set(novel.entities.map((e) => e.name))
  const found = new Map<string, UnresolvedLink>()

  for (const e of novel.entities) {
    LINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LINK_RE.exec(e.body ?? '')) !== null) {
      const name = m[1].trim()
      if (!name) continue
      // 指向自己的条目不算断链（[[林昭]] 写在他的页面上）
      if (names.has(name)) continue
      const hit = found.get(name)
      if (hit) {
        hit.count++
        if (hit.sources.length < 5 && !hit.sources.some((s) => s.id === e.id)) {
          hit.sources.push({ id: e.id, name: e.name })
        }
      } else {
        found.set(name, { name, count: 1, sources: [{ id: e.id, name: e.name }] })
      }
    }
  }

  return Array.from(found.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}
