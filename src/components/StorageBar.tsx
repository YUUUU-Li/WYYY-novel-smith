/* ============================================================
   存储位置指示条

   为什么这个要放在作品库最显眼的位置：
   「我的东西到底存在哪」是这类工具最该被回答的问题。
   藏在设置里的存储位置，等于让用户提心吊胆。
   所以它是一个常驻的条，说清楚当前存在哪、怎么切成文件夹。
   ============================================================ */

import { FolderOpen, HardDrives, WarningCircle, X } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { isTauri } from '../lib/storage-tauri'
import { useState } from 'react'

/* 同一个界面装在两种壳里，说法必须跟着换：
   装在桌面程序里时，用户面前没有「浏览器」，也不该被告知去换个浏览器。 */
const DESKTOP = isTauri()

export function StorageBar() {
  const mode = useStore((s) => s.storageMode)
  const rootName = useStore((s) => s.rootName)
  const pendingRoot = useStore((s) => s.pendingRoot)
  const canUse = useStore((s) => s.canUseFilesystem)
  const chooseFolder = useStore((s) => s.chooseFolder)
  const resumeFolder = useStore((s) => s.resumeFolder)
  const disconnectFolder = useStore((s) => s.disconnectFolder)

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
      {/* 上次用过文件夹时的续用提示。只有浏览器需要它：
          桌面版记得真实路径，启动就自己接上了，不用麻烦用户。 */}
      {!DESKTOP && pendingRoot && mode !== 'filesystem' && (
        <div
          className="mb-3 flex items-center gap-3 rounded-[var(--radius-lg)] px-4 py-3"
          style={{
            background: 'color-mix(in oklab, var(--color-accent) 8%, transparent)',
            border: '1px solid color-mix(in oklab, var(--color-accent) 26%, transparent)',
          }}
        >
          <WarningCircle size={15} style={{ color: 'var(--color-accent)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">
              继续使用上次的小说库文件夹「{pendingRoot}」
            </div>
            <div
              className="mt-0.5 text-[11px] leading-relaxed"
              style={{ color: 'var(--color-ink-soft)' }}
            >
              浏览器不允许程序自己重新打开你的文件夹，所以需要你点一下授权。这是浏览器的安全限制。
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary flex-none"
            disabled={busy}
            onClick={() => void run(resumeFolder)}
          >
            {busy ? '授权中…' : '继续使用'}
          </button>
        </div>
      )}

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
          {mode === 'filesystem' ? (
            <div className="text-[11.5px]">
              <span style={{ color: 'var(--color-ink-faint)' }}>小说库根目录：</span>
              <span style={{ color: 'var(--color-accent)' }}>{rootName}</span>
              <span style={{ color: 'var(--color-ink-faint)' }}>
                {' '}
                · 每部作品在这下面各自一个文件夹，条目是单独的 Markdown 文件，可以直接用记事本打开
              </span>
            </div>
          ) : (
            <div className="text-[11.5px]" style={{ color: 'var(--color-ink-faint)' }}>
              {DESKTOP
                ? '当前暂存在程序内部（关掉程序不会丢，但你看不到文件）。选一个文件夹，内容就变成能拷走、能编辑的纯文本。'
                : canUse
                  ? '当前暂存在浏览器里（关掉浏览器不会丢，但你看不到文件）。选一个文件夹，内容就变成能拷走、能编辑的纯文本。'
                  : '当前浏览器不支持文件夹写入（Firefox / Safari 尚未实现）。用 Edge 或 Chrome 打开即可启用。'}
            </div>
          )}
        </div>

        {mode === 'filesystem' ? (
          <button
            type="button"
            className="btn btn-plain flex-none"
            disabled={busy}
            onClick={disconnectFolder}
            title={DESKTOP ? '切换回程序内部存储' : '切换回浏览器存储'}
          >
            <X size={12} />
            {DESKTOP ? '换回程序内部存储' : '换回浏览器存储'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost flex-none"
            disabled={busy || !canUse}
            onClick={() => void run(chooseFolder)}
          >
            <FolderOpen size={13} />
            {busy ? '处理中…' : '选择小说库文件夹'}
          </button>
        )}
      </div>

      {err && (
        <div
          className="mt-2 text-[11.5px]"
          style={{ color: 'var(--color-danger)' }}
          role="alert"
        >
          {err}
        </div>
      )}
    </div>
  )
}
