/* ============================================================
   作品库

   两种状态：
   · 一本都没有 → 直接把「新建」摆在正中央，不需要先点一下按钮
   · 有作品     → 列出作品，右上角可新建

   刻意保持极简：不解释设计理念，不介绍功能，不显示演示说明。
   作者来这里只做两件事：打开一本，或者建一本。
   ============================================================ */

import { useEffect, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, Plus, Trash } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { ConfirmButton } from '../components/ui'
import { StorageBar } from '../components/StorageBar'

export function Library() {
  const summaries = useStore((s) => s.summaries)
  const openProject = useStore((s) => s.openProject)
  const openWorkFolder = useStore((s) => s.openWorkFolder)
  const relocateWork = useStore((s) => s.relocateWork)
  const newProject = useStore((s) => s.newProject)
  const deleteProject = useStore((s) => s.deleteProject)
  const [err, setErr] = useState<string | null>(null)

  const empty = summaries.length === 0
  const [creating, setCreating] = useState(empty)
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 空状态下一进来就聚焦标题框，直接可以打字
  useEffect(() => {
    if (empty) requestAnimationFrame(() => inputRef.current?.focus())
  }, [empty])

  const submit = () => {
    const t = title.trim()
    if (!t) return
    setTitle('')
    setCreating(false)
    void newProject(t)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div
        className="mx-auto w-full px-8"
        style={{ maxWidth: empty ? 520 : 900, paddingTop: empty ? '22vh' : 72 }}
      >
        {empty ? (
          /* ---------------- 空状态：新建是唯一的主角 ---------------- */
          <div className="anim-fade-up">
            <h1 className="t-title" style={{ fontSize: 26 }}>
              新建小说
            </h1>
            <p
              className="mt-2 text-[13px] leading-relaxed"
              style={{ color: 'var(--color-ink-soft)' }}
            >
              先起个名字，设定、图谱、时间线、地图之后再慢慢填。
            </p>

            <div className="mt-6 flex items-center gap-2">
              <input
                ref={inputRef}
                className="input"
                style={{ fontSize: 15, padding: '10px 12px' }}
                value={title}
                placeholder="小说的名字"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
              />
              <button
                type="button"
                className="btn btn-primary flex-none"
                style={{ padding: '10px 16px', fontSize: 13.5 }}
                onClick={submit}
                disabled={!title.trim()}
              >
                创建
              </button>
            </div>

            <p
              className="mt-3 text-[11.5px]"
              style={{ color: 'var(--color-ink-faint)' }}
            >
              按回车也可以。
            </p>

            {/* 第一次用桌面版的人，手里往往已经有作品文件夹了。
                空作品库以"新建"为主角是对的，但必须让"打开已有的"同样显眼 ——
                否则会以为自己得重新建一部，或者去选上一级目录。 */}
            <div className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-2">
              <span className="text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
                已经有作品了？
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  void openWorkFolder().catch((e) =>
                    setErr(e instanceof Error ? e.message : '操作失败'),
                  )
                }
                title="选一个已经存在的作品文件夹（里面有 novel.json）"
              >
                <FolderOpen size={13} />
                打开作品文件夹
              </button>
            </div>

            {err && (
              <div className="mt-3 text-[11.5px] whitespace-pre-line" style={{ color: 'var(--color-danger)' }} role="alert">
                {err}
              </div>
            )}

            <div className="mt-12">
              <StorageBar />
            </div>
          </div>
        ) : (
          /* ---------------- 有作品：列表 ---------------- */
          <>
            <div className="flex items-center justify-between gap-4">
              <h1 className="t-title" style={{ fontSize: 22 }}>
                作品库
              </h1>
              {!creating && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={13} />
                  新建
                </button>
              )}
            </div>

            {creating && (
              <div className="mt-4 flex items-center gap-2">
                <input
                  ref={inputRef}
                  className="input"
                  autoFocus
                  value={title}
                  placeholder="小说的名字"
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                    if (e.key === 'Escape') {
                      setCreating(false)
                      setTitle('')
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary flex-none"
                  onClick={submit}
                  disabled={!title.trim()}
                >
                  创建
                </button>
                <button
                  type="button"
                  className="btn btn-plain flex-none"
                  onClick={() => {
                    setCreating(false)
                    setTitle('')
                  }}
                >
                  取消
                </button>
              </div>
            )}

            <ul className="mt-6">
              {summaries.map((p) => (
                <li
                  key={p.id}
                  className="group flex items-center gap-3 py-3"
                  style={{ borderTop: '1px solid var(--color-line-soft)' }}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => void openProject(p.id)}
                  >
                    <div className="truncate text-[14px] font-medium">{p.title}</div>
                    <div
                      className="t-num mt-0.5"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {p.entityCount} 条 · {relTime(p.updatedAt)}
                    </div>
                    {/* 每部作品自己的保存位置。
                        这里必须用 p.location（作品自己的），不能用全局的
                        rootName —— 那是"当前打开的那本"，会让列表里每张卡
                        都顶着同一部作品的名字。 */}
                    <div
                      className="mt-0.5 truncate text-[11px]"
                      style={{ color: 'var(--color-ink-faint)', opacity: 0.8 }}
                      title={p.locationPath ?? p.location ?? '程序内部存储'}
                    >
                      位置：{p.locationPath ?? p.location ?? '程序内部存储'}{p.kind === 'internal' ? '（还没落到文件夹）' : ''}
                    </div>
                  </button>

                  <button
                    type="button"
                    className="btn btn-plain flex-none"
                    onClick={() => void openProject(p.id)}
                  >
                    打开
                    <ArrowRight size={12} />
                  </button>


                  {p.kind === 'folder' && (
                    <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        className="btn btn-plain"
                        title="文件夹被改名或挪走了？指到它现在的位置（不搬文件）"
                        aria-label="重新指定位置"
                        onClick={() => void relocateWork(p.id).catch((e) => setErr(e instanceof Error ? e.message : '操作失败'))}
                      >
                        <FolderOpen size={12} />
                      </button>
                    </span>
                  )}
                  <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <ConfirmButton onConfirm={() => void deleteProject(p.id)}>
                      <Trash size={12} />
                    </ConfirmButton>
                  </span>
                </li>
              ))}
            </ul>

            {err && (
              <div className="mt-4 text-[11.5px]" style={{ color: 'var(--color-danger)' }} role="alert">
                {err}
              </div>
            )}

            <div className="mt-10">
              <StorageBar />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}
