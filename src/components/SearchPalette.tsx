/* ============================================================
   全局搜索面板（Ctrl/Cmd + K）

   为什么做成浮层面板而不是一个搜索页：
   搜索是「打断当前动作、查完立刻回来」的操作。做成页面会逼作者
   离开正在做的事，而且每次都要重新找回原来的位置。
   浮层则用完即走。

   键盘全程可用：↑↓ 选、Enter 打开、Esc 关。
   鼠标用户也能直接点 —— 两条路都要通，不能只做一条。
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BookBookmark,
  MagnifyingGlass,
  TextAa,
  Translate,
} from '@phosphor-icons/react'
import { useStore, type ViewId } from '../store/useNovel'
import { hitKindLabel, parseSnippet, searchNovel, type SearchHit } from '../lib/search'
import { TypeDot } from './ui'
import { cx } from '../lib/util'

/** 命中跳转到哪个视图 */
function viewForHit(hit: SearchHit): ViewId {
  if (hit.kind === 'outline') return 'outline'
  return 'entities'
}

export function SearchPalette() {
  const novel = useStore((s) => s.novel)
  const select = useStore((s) => s.select)
  const setView = useStore((s) => s.setView)
  const open = useStore((s) => s.searchOpen)
  const setOpen = useStore((s) => s.setSearchOpen)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const hits = useMemo(() => {
    if (!novel || query.trim().length === 0) return []
    return searchNovel(novel, query)
  }, [novel, query])

  /* 打开时聚焦输入框并重置状态 */
  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      // 等一帧再聚焦，否则浮层还没挂载完
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  /* 结果变化时把光标收回顶部，避免停留在越界位置 */
  useEffect(() => {
    setCursor(0)
  }, [query])

  /* 选中项滚进可视区 */
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  if (!novel || !open) return null

  const commit = (hit: SearchHit | undefined) => {
    if (!hit) return
    setOpen(false)
    setView(viewForHit(hit))
    if (hit.kind !== 'outline') select(hit.id)
    else select(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(0, hits.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(hits[cursor])
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4"
      style={{
        paddingTop: '12vh',
        background: 'color-mix(in oklab, var(--color-base) 66%, transparent)',
        backdropFilter: 'blur(3px)',
      }}
      onMouseDown={(e) => {
        // 点空白处关闭，但点面板内部不关
        if (e.target === e.currentTarget) setOpen(false)
      }}
      role="dialog"
      aria-modal="true"
      aria-label="在全书中搜索"
    >
      <div
        className="anim-fade-up flex w-full max-w-[680px] flex-col overflow-hidden"
        style={{
          maxHeight: '72vh',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-line-strong)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-float)',
        }}
        onKeyDown={onKeyDown}
      >
        {/* 输入行 */}
        <div
          className="flex flex-none items-center gap-3 px-4"
          style={{ height: 52, borderBottom: '1px solid var(--color-line)' }}
        >
          <MagnifyingGlass size={15} style={{ color: 'var(--color-ink-faint)' }} />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            style={{ color: 'var(--color-ink)' }}
            placeholder="搜名字、标签、正文、能力、关系备注、大纲、词条…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
              {hits.length} 条
            </span>
          )}
          <button
            type="button"
            className="btn btn-plain flex-none"
            onClick={() => setOpen(false)}
            title="关闭（Esc）"
          >
            Esc
          </button>
        </div>

        {/* 结果 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          {query.trim().length === 0 ? (
            <div className="px-5 py-8">
              <div className="t-micro mb-3">可以搜什么</div>
              <div className="flex flex-col gap-2.5">
                <Hint icon={<TextAa size={12} />} text="正文里的任意一句话" />
                <Hint icon={<TextAa size={12} />} text="自定义字段，比如角色的「能力」和「动机」" />
                <Hint icon={<TextAa size={12} />} text="关系备注，比如「十年前那场审判的当事人」" />
                <Hint icon={<BookBookmark size={12} />} text="大纲的卷、章、场景标题与梗概" />
                <Hint icon={<Translate size={12} />} text="词条与它的释义" />
              </div>
              <div
                className="mt-5 pt-4 text-[11.5px] leading-relaxed"
                style={{
                  borderTop: '1px solid var(--color-line-soft)',
                  color: 'var(--color-ink-faint)',
                }}
              >
                ↑↓ 选择，Enter 打开，Esc 关闭。搜到的每一处都会给出上下文，
                所以你不用猜它为什么出现。
              </div>
            </div>
          ) : hits.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <div className="text-[13px]" style={{ color: 'var(--color-ink-mid)' }}>
                没有找到「{query}」
              </div>
              <div
                className="mx-auto mt-2 max-w-[40ch] text-[11.5px] leading-relaxed"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                它可能还没被写进任何条目。想让某个词以后能被搜到，
                可以新建一个条目，或者在正文里用
                <span className="t-num"> [[{query}]] </span>
                标注它。
              </div>
            </div>
          ) : (
            <ul className="py-1.5">
              {hits.map((hit, i) => (
                <li key={hit.key}>
                  <button
                    type="button"
                    data-idx={i}
                    onMouseMove={() => setCursor(i)}
                    onClick={() => commit(hit)}
                    className={cx(
                      'flex w-full items-start gap-3 px-4 py-2 text-left transition-colors',
                    )}
                    style={{
                      background:
                        i === cursor
                          ? 'var(--color-surface-3)'
                          : 'transparent',
                    }}
                  >
                    {/* 类型标识 */}
                    <span className="mt-[3px] flex-none">
                      {hit.kind === 'outline' ? (
                        <BookBookmark size={13} style={{ color: 'var(--color-ink-faint)' }} />
                      ) : hit.kind === 'term' ? (
                        <Translate size={13} style={{ color: 'var(--color-ink-faint)' }} />
                      ) : (
                        <TypeDot type={hit.kind} size={8} />
                      )}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[13px] font-medium">{hit.title}</span>
                        <span
                          className="t-num"
                          style={{ color: 'var(--color-ink-faint)' }}
                        >
                          {hitKindLabel(hit.kind)}
                        </span>
                        <span
                          className="chip"
                          style={{
                            color:
                              hit.field === 'body'
                                ? 'var(--color-ink-soft)'
                                : 'var(--color-accent)',
                            borderColor:
                              hit.field === 'body'
                                ? 'var(--color-line)'
                                : 'color-mix(in oklab, var(--color-accent) 30%, transparent)',
                            background: 'transparent',
                          }}
                        >
                          {hit.fieldLabel}
                        </span>
                        {hit.totalMatches > 1 && (
                          <span
                            className="t-num"
                            style={{ color: 'var(--color-ink-faint)' }}
                          >
                            共 {hit.totalMatches} 处
                          </span>
                        )}
                      </div>
                      {/* 上下文：命中词高亮 */}
                      <div
                        className="t-prose mt-1 line-clamp-2"
                        style={{ fontSize: 12.5, lineHeight: 1.7 }}
                      >
                        {parseSnippet(hit.snippet).map((part, k) =>
                          part.hit ? (
                            <mark
                              key={k}
                              style={{
                                background:
                                  'color-mix(in oklab, var(--color-accent) 30%, transparent)',
                                color: 'var(--color-ink)',
                                borderRadius: 'var(--radius-xs)',
                                padding: '0 1px',
                              }}
                            >
                              {part.text}
                            </mark>
                          ) : (
                            <span key={k}>{part.text}</span>
                          ),
                        )}
                      </div>
                    </div>

                    {i === cursor && (
                      <ArrowRight
                        size={13}
                        className="mt-1 flex-none"
                        style={{ color: 'var(--color-accent)' }}
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 页脚：说明跳转去向 */}
        {hits.length > 0 && (
          <div
            className="flex flex-none items-center justify-between px-4 py-2"
            style={{ borderTop: '1px solid var(--color-line-soft)' }}
          >
            <span className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
              Enter 打开条目并跳到设定视图；大纲和词条会跳到各自的视图
            </span>
            <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
              {cursor + 1} / {hits.length}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function Hint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span style={{ color: 'var(--color-ink-faint)' }} aria-hidden>
        {icon}
      </span>
      <span className="text-[12px]" style={{ color: 'var(--color-ink-soft)' }}>
        {text}
      </span>
    </div>
  )
}

/** 顶栏上的入口按钮，让键盘快捷键不是唯一入口 */
export function SearchTrigger() {
  const setOpen = useStore((s) => s.setSearchOpen)
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <button
      type="button"
      className="btn btn-ghost flex-none"
      onClick={() => setOpen(true)}
      title="在全书中搜索"
    >
      <MagnifyingGlass size={13} />
      <span>搜索</span>
      <span
        className="t-num ml-1 rounded px-1"
        style={{
          background: 'var(--color-sunken)',
          border: '1px solid var(--color-line)',
          color: 'var(--color-ink-faint)',
        }}
      >
        {isMac ? '⌘K' : 'Ctrl K'}
      </span>
    </button>
  )
}
