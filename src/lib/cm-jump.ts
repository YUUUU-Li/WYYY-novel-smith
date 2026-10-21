/* ============================================================
   正文编辑器里的 [[双括号跳转]]

   这是让设定库「活起来」的机制：在一个角色里提到另一个角色，
   不用手动建链接，写个双括号就行。

   为什么做在编辑器里，而不是做一个「预览」模式：
   正文是 CodeMirror 编辑区，你写字和读字都在同一个地方。
   如果跳转只在预览里能用，那你就得先切模式才能点 —— 而恰恰是
   写到一半想起「那个角色叫什么来着」的时候最需要点它。

   交互（刻意选择）：
   - 平时：方括号是淡的，名字是正文的颜色，底下一条很轻的朱砂线
   - 悬停：整个词语转朱砂、线变实
   - 点击：跳到那个条目
   - 指向不存在的条目：灰字 + 虚线，点它不跳（你多半是想改那几个字）

   点击用的是 mousedown + preventDefault，不是 click：
   这样光标不会先落到链接里再跳走，视觉上干脆一些。
   代价是不能用鼠标把光标点进链接中间 —— 用方向键可以。
   ============================================================ */

import { RangeSetBuilder, StateEffect } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

export interface JumpOptions {
  /** 名字 → 实体 id；找不到返回 null */
  resolve: (name: string) => string | null
  onJump: (id: string) => void
}

/** 索引变了（比如刚刚新建了那个条目）时派发它，让装饰重算一次 */
export const refreshJumps = StateEffect.define<null>()

const bracketDeco = Decoration.mark({ class: 'ns-cm-bracket' })

/** [[名字]] 或 [[名字|显示文字]]。不跨行，也不允许嵌套方括号 */
const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g

function buildDecorations(view: EditorView, opts: JumpOptions): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()

  /* 只扫可见范围：几十万字的正文里，全量扫描会在每次输入时卡一下 */
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    WIKILINK.lastIndex = 0
    let m: RegExpExecArray | null

    while ((m = WIKILINK.exec(text)) !== null) {
      const start = from + m.index
      const end = start + m[0].length
      // [[名字|显示文字]] 的跳转目标是竖线前面那个
      const name = m[1].split('|')[0].trim()
      const id = name ? opts.resolve(name) : null

      // 名字那一段才是链接；方括号只做淡化，不当点击目标
      const linkDeco = Decoration.mark({
        class: id ? 'ns-cm-jump' : 'ns-cm-jump ns-cm-jump-missing',
        attributes: { 'data-jump': name },
      })

      builder.add(start, start + 2, bracketDeco)
      builder.add(start + 2, end - 2, linkDeco)
      builder.add(end - 2, end, bracketDeco)
    }
  }

  return builder.finish()
}

/**
 * 把 [[...]] 变成可点的跳转。返回一串扩展，直接塞给 CodeMirror 的
 * extensions 数组即可（它支持嵌套数组）。
 */
export function wikilinkJump(opts: JumpOptions) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts)
      }
      update(u: ViewUpdate) {
        const forced = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshJumps)),
        )
        if (u.docChanged || u.viewportChanged || forced) {
          this.decorations = buildDecorations(u.view, opts)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  const clicks = EditorView.domEventHandlers({
    mousedown(event) {
      const el = (event.target as HTMLElement | null)?.closest('[data-jump]')
      if (!el) return false
      const name = el.getAttribute('data-jump') ?? ''
      const id = opts.resolve(name)
      // 指向不存在的条目时不当链接用 —— 留着让用户能点进去改那几个字
      if (!id) return false
      event.preventDefault()
      opts.onJump(id)
      return true
    },
  })

  return [plugin, clicks]
}
