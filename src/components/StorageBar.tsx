/* ============================================================
   这部作品存在哪

   「文件夹即作品」之后，这条要回答的问题变了：
   以前是"整个小说库存在哪"（一个根目录装很多作品），现在是
   "**这部作品**存在哪个文件夹" —— 所以文案要从"库"改成"作品"。

   顺带承担另一个入口：「打开作品文件夹…」。别人的作品、以前的备份、
   从网盘拷回来的东西，都是指一下文件夹就开始用。
   ============================================================ */

import { FolderOpen, HardDrives, WarningCircle } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { supportsFileSystem } from '../lib/storage'
import { isTauri } from '../lib/storage-tauri'
import { useState } from 'react'

const DESKTOP = isTauri()
const CAN_PICK = DESKTOP || supportsFileSystem()

export function StorageBar() {
  const mode = useStore((s) => s.storageMode)
  const rootName = useStore((s) => s.rootName)
  const openWorkFolder = useStore((s) => s.openWorkFolder)
  const hasNovel = useStore((s) => s.novel !== null)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-6">
      <div
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] px-4 py-2.5"
        style={{
          border: '1px solid var(--color-line-soft)',
          background: 'color-mix(in oklab, var(--color-surface) 60%, transparent)',
        }}
      >
        <span
          className="flex flex-none items-center gap-2"
          style={{ color: 'var(--color-ink-faint)' }}
          aria-hidden
        >
          {mode === 'filesystem' ? <FolderOpen size={14} /> : <HardDrives size={14} />}
        </span>

        <div className="min-w-0 flex-1">
          {!hasNovel ? (
            /* 作品库页没有"当前这部作品"，所以这里只能说清模型本身；
               每部作品具体在哪，写在它自己的卡片上。 */
            <div className="text-[11.5px]" style={{ color: 'var(--color-ink-faint)' }}>
              一个文件夹就是一部作品：文件夹里放着 novel.json 和各类型目录，拷走它就是备份。
              每部作品的位置写在卡片下面。
            </div>
          ) : mode === 'filesystem' ? (
            <div className="text-[11.5px]">
              <span style={{ color: 'var(--color-ink-faint)' }}>这部作品保存在文件夹：</span>
              <span style={{ color: 'var(--color-accent)' }}>{rootName}</span>
              <span style={{ color: 'var(--color-ink-faint)' }}>
                {' '}
                · 一个文件夹就是一部作品，拷走它就是备份；每个条目是单独的 Markdown 文件
              </span>
            </div>
          ) : (
            <div className="text-[11.5px]" style={{ color: 'var(--color-ink-faint)' }}>
              {CAN_PICK
                ? '这部作品暂时存在程序内部（关掉程序不会丢，但你看不到文件）。新建作品时会让你选一个文件夹，那之后它就是纯文本。'
                : '这个浏览器不支持文件夹访问（Firefox / Safari 尚未实现）。用 Edge / Chrome，或者用桌面版。'}
            </div>
          )}
        </div>

        <button
          type="button"
          className="btn btn-ghost flex-none"
          disabled={busy || !CAN_PICK}
          onClick={() => void run(openWorkFolder)}
          title="选一个已经存在的作品文件夹（里面有 novel.json），登记进作品库并打开"
        >
          <FolderOpen size={13} />
          {busy ? '处理中…' : '打开作品文件夹'}
        </button>
      </div>

      {err && (
        <div
          className="mt-2 flex items-start gap-2 text-[11.5px]"
          style={{ color: 'var(--color-danger)' }}
          role="alert"
        >
          <WarningCircle size={14} className="mt-0.5 flex-none" />
          <span className="whitespace-pre-line">{err}</span>
        </div>
      )}
    </div>
  )
}
