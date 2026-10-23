import { useEffect, useState } from 'react'
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  Bank,
  BookBookmark,
  ClockCounterClockwise,
  MapTrifold,
  ShareNetwork,
  SquaresFour,
  WarningCircle,
} from '@phosphor-icons/react'
import { useStore, type ViewId } from './store/useNovel'
import { describeSaveState, isSaveProblem } from './lib/save-status'
import { Library } from './views/Library'
import { OverviewView } from './views/OverviewView'
import { EntitiesView } from './views/EntitiesView'
import { CanvasGraph } from './components/CanvasGraph'
import { TimelineSection } from './views/TimelineSection'
import { MapsSection } from './views/MapsView'
import { OutlineView } from './views/OutlineView'
import { Rail } from './components/Rail'
import { SearchPalette, SearchTrigger } from './components/SearchPalette'

/** 检测外部改动的间隔。5 秒足够及时，又不会让文件夹一直转 */
const DISK_POLL_MS = 5000

/* 六个功能 + 一个概览。顺序按「从宏观到具体」排。
   原来的「字典」并进了「概念」条目 —— 词和条目本来就是同一个东西。 */
export const VIEWS: Array<{ id: ViewId; label: string; icon: typeof Bank }> = [
  { id: 'overview', label: '概览', icon: SquaresFour },
  { id: 'entities', label: '设定', icon: Bank },
  { id: 'sketch', label: '关系网', icon: ShareNetwork },
  { id: 'timeline', label: '时间线', icon: ClockCounterClockwise },
  { id: 'maps', label: '地图', icon: MapTrifold },
  { id: 'outline', label: '大纲', icon: BookBookmark },
]

export function App() {
  const ready = useStore((s) => s.ready)
  const novel = useStore((s) => s.novel)
  const view = useStore((s) => s.view)
  const init = useStore((s) => s.init)
  const checkDisk = useStore((s) => s.checkDisk)

  useEffect(() => {
    void init()
  }, [init])

  /**
   * 定时检测「文件被程序之外的东西改过」。
   * 只在打开着小说时才有意义，所以在 novel 为空时直接不启动定时器。
   */
  useEffect(() => {
    if (!novel) return
    const timer = setInterval(() => void checkDisk(), DISK_POLL_MS)
    return () => clearInterval(timer)
  }, [novel, checkDisk])

  /**
   * 全局快捷键 Ctrl/Cmd + K 打开搜索。
   * 绑在 window 上而不是某个容器上，因为作者可能刚从编辑器里
   * 松开键盘，焦点在哪儿是不确定的 —— 搜索必须随时能唤出来。
   */
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearchOpen])

  /**
   * 全局撤回 / 重做：Ctrl/Cmd+Z 撤回，Ctrl+Shift+Z 或 Ctrl+Y 重做。
   *
   * 为什么要在编辑器里让路：正文是 CodeMirror，它自带一套更细的撤销
   * （按字符/按输入段）。如果这里抢走 Ctrl+Z，作者在正文里打字时的
   * 撤销粒度会突然变成"整块回退"，反而更难用。所以焦点在编辑区里时
   * 交给它自己，在别处（改设定、拖位置、删条目）才用全局这套。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const el = e.target as HTMLElement | null
      const inEditor =
        !!el &&
        (el.closest('.cm-editor') !== null ||
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable)
      if (inEditor) return
      e.preventDefault()
      const s = useStore.getState()
      if (k === 'y' || (k === 'z' && e.shiftKey)) s.redo()
      else s.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 关窗之前把还没落盘的改动写掉。
   *
   * 桌面版：拦下 close 请求 → 先 flush → 再真正销毁窗口。不这么做的话，
   *   「拖完一个词条就顺手点 ×」这种动作里，那次改动只在内存里，窗口一关
   *   就没了 —— 浏览器上至少还有个页面卸载事件，桌面版连那个都靠不住。
   *   如果 flush 报错，**不关窗**：让错误留在界面上，总比一声不响地丢稿子好。
   *
   * 浏览器版：只剩 beforeunload，来不及做异步写盘，只能在有未保存改动时
   *   让浏览器弹一句确认。
   */
  useEffect(() => {
    const flush = useStore.getState().flushNow
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().saveState.kind === 'idle') {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    let unlisten: (() => void) | undefined
    let cancelled = false
    void (async () => {
      const { isTauri } = await import('./lib/storage-tauri')
      if (!isTauri()) return
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const off = await win.onCloseRequested(async (event) => {
        event.preventDefault()
        await flush().catch(() => undefined)
        if (isSaveProblem(useStore.getState().saveState)) return // 存不下就别关
        await win.destroy()
      })
      if (cancelled) off()
      else unlisten = off
    })()

    return () => {
      cancelled = true
      unlisten?.()
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  if (!ready) {
    return (
      <div className="h-full grid place-items-center">
        <div className="flex flex-col items-center gap-3">
          <div className="skeleton w-[120px] h-[10px]" />
          <div className="skeleton w-[72px] h-[10px]" />
        </div>
      </div>
    )
  }

  if (!novel) return <Library />

  return (
    <div className="h-full flex flex-col">
      <DiskChangeBanner />
      <TopBar />
      <div className="flex-1 min-h-0 flex">
        <Rail />
        <main className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
          {view === 'overview' && <OverviewView />}
          {view === 'entities' && <EntitiesView />}
          {view === 'sketch' && <CanvasGraph />}
          {view === 'timeline' && <TimelineSection />}
          {view === 'maps' && <MapsSection />}
          {view === 'outline' && <OutlineView />}
          <UndoFlash />
          </main>
      </div>
      <SearchPalette />
    </div>
  )
}

/* ============================================================
   撤回 / 重做之后闪一下

   撤回会把画面切回"那一步发生的地方"（见 store 里的 UndoContext）。
   但有两种情况切换本身不足以让人接住：
     · 本来就停在那页 → 零视觉变化
     · 切页了，但被撤回的那一小块不在视线中心
   所以再加一层极淡的整页闪光，成本最低的「这里刚刚变过」。
   ============================================================ */

function UndoFlash() {
  const flashKey = useStore((s) => s.flashKey)
  if (flashKey === 0) return null
  // key 变化 = 重新挂载 = 动画重播一次
  return <div key={flashKey} className="undo-flash" aria-hidden />
}

/* ============================================================
   撤回 / 重做

   一个按钮管全应用：设定、大纲、时间线、地图、关系网，改的都是同一份
   Novel，所以共用同一个栈。关系网页原来那块自己的撤销按钮已经并进来了
   —— 两个撤销按钮会让人不知道该按哪个，而且各自只有一半的历史。

   为什么显示「撤回：删除条目」而不是只写「撤回」：
   作者在删东西之前手是抖的，按下之前应该能看见这一步撤的是什么。
   ============================================================ */

function UndoRedo() {
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const undoDepth = useStore((s) => s.undoDepth)
  const redoDepth = useStore((s) => s.redoDepth)
  const undoLabel = useStore((s) => s.undoLabel)
  const redoLabel = useStore((s) => s.redoLabel)

  return (
    <div className="flex flex-none items-center gap-0.5">
      <button
        type="button"
        className="btn btn-plain"
        onClick={undo}
        disabled={undoDepth === 0}
        title={
          undoDepth === 0
            ? '没有可撤回的改动'
            : `撤回：${undoLabel ?? '编辑'}（Ctrl+Z，还可退 ${undoDepth} 步）`
        }
        aria-label="撤回"
      >
        <ArrowUUpLeft size={14} />
      </button>
      <button
        type="button"
        className="btn btn-plain"
        onClick={redo}
        disabled={redoDepth === 0}
        title={
          redoDepth === 0
            ? '没有可重做的改动'
            : `重做：${redoLabel ?? '编辑'}（Ctrl+Shift+Z，还可重做 ${redoDepth} 步）`
        }
        aria-label="重做"
      >
        <ArrowUUpRight size={14} />
      </button>
    </div>
  )
}

/* ============================================================
   保存状态指示

   为什么它必须存在：
   落盘失败原先是被静默吞掉的。磁盘满、浏览器收回文件夹权限、
   文件夹被移走 —— 这些情况下作者会一直打字以为都存上了。
   对「文件即真相」的工具来说这是最严重的一类问题。

   所以：成功时安静（不打扰），失败时醒目（可重试）。
   ============================================================ */

function SaveIndicator() {
  const state = useStore((s) => s.saveState)
  const retrySave = useStore((s) => s.retrySave)
  // 只在「已保存」状态需要重新计算相对时间，其他状态不需要走时钟
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (state.kind !== 'saved') return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [state.kind])

  const label = describeSaveState(state, now)
  const problem = isSaveProblem(state)

  if (problem) {
    return (
      <div
        className="flex flex-none items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1"
        style={{
          background: 'color-mix(in oklab, var(--color-danger) 12%, transparent)',
          border: '1px solid color-mix(in oklab, var(--color-danger) 34%, transparent)',
        }}
        role="alert"
      >
        <WarningCircle size={13} style={{ color: 'var(--color-danger)' }} />
        <span className="text-[11.5px]" style={{ color: 'var(--color-ink)' }}>
          {label}
        </span>
        <button
          type="button"
          className="btn btn-plain"
          style={{ color: 'var(--color-danger)', padding: '2px 6px' }}
          onClick={() => void retrySave()}
          title="再试一次写盘"
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <span
      className="t-num flex-none"
      style={{
        color:
          state.kind === 'saved' ? 'var(--color-ink-faint)' : 'var(--color-ink-soft)',
      }}
      title="改动会自动保存"
    >
      {label}
    </span>
  )
}

/* ============================================================
   外部改动提示
   
   为什么是「提示」而不是自动处理：
   一次错误的自动合并会毁掉设定，而多问一句的成本只是点一下。
   这个决定该由作者做。而且横幅必须说清「不做选择会怎样」，
   否则用户会以为放着不管就没事 —— 其实下次保存就会覆盖磁盘。
   ============================================================ */

function DiskChangeBanner() {
  const diskChange = useStore((s) => s.diskChange)
  const applyDiskVersion = useStore((s) => s.applyDiskVersion)
  const keepMemoryVersion = useStore((s) => s.keepMemoryVersion)
  const dismissDiskChange = useStore((s) => s.dismissDiskChange)
  const openWorkFolder = useStore((s) => s.openWorkFolder)

  if (!diskChange) return null

  /* 两种原因的界面不该长一个样。
     「找不到文件夹」时，磁盘上根本没有可载入的版本，
     给「载入磁盘版本 / 保留当前版本」等于让人在两个都没用的按钮里猜。 */
  const missing = diskChange.kind === 'missing'

  return (
    <div
      className="flex-none flex flex-wrap items-center gap-3 px-4 py-2.5 anim-fade-up"
      style={{
        background: 'color-mix(in oklab, var(--color-warn) 10%, var(--color-surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--color-warn) 30%, transparent)',
      }}
      role="status"
      aria-live="polite"
    >
      <WarningCircle size={15} style={{ color: 'var(--color-warn)' }} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">
          {missing ? '打不开小说库文件夹了' : '小说库文件夹里的内容被程序之外的东西改过了'}
        </div>
        <div
          className="mt-0.5 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--color-ink-soft)' }}
        >
          {diskChange.summary}。
          <span style={{ color: 'var(--color-ink-faint)' }}>
            {' '}
            {missing
              ? '稿子还在那个文件夹里，没有被动过；重新选一次它就能接着用。选之前别关程序。'
              : '如果你在外部编辑过那些 Markdown，选「载入磁盘版本」；如果这些改动是误操作，选「保留当前版本」。'}
          </span>
        </div>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {missing ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void openWorkFolder().catch(() => undefined)}
          >
            打开原来的文件夹
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void applyDiskVersion()}
            >
              载入磁盘版本
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void keepMemoryVersion()}
            >
              保留当前版本
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-plain"
          onClick={dismissDiskChange}
          title={missing ? '知道了。下次保存会失败，除非重新选一次文件夹' : '知道了。注意：下次保存仍然会覆盖磁盘上的改动'}
        >
          稍后再说
        </button>
      </div>
    </div>
  )
}

/* ============================================================
   顶栏：项目身份 + 视图切换
   高度锁在 52px，永远单行。导航换行是设计事故。
   ============================================================ */

function TopBar() {
  const novel = useStore((s) => s.novel)!
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const backToLibrary = useStore((s) => s.backToLibrary)

  return (
    <header
      className="flex-none flex items-center gap-4 px-4 border-b"
      style={{
        // 导航标签改大之后，顶栏跟着抬高一点，否则朱砂线会贴到边上
        height: 56,
        borderColor: 'var(--color-line)',
        background: 'var(--color-surface)',
      }}
    >
      <button
        type="button"
        onClick={backToLibrary}
        className="btn btn-plain flex-none"
        title="回到作品库"
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            style={{
              width: 15,
              height: 15,
              borderRadius: 'var(--radius-xs)',
              border: '1px solid var(--color-accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 'var(--radius-xs)',
                background: 'var(--color-accent)',
              }}
            />
          </span>
          <span className="text-[12.5px] font-medium text-[var(--color-ink)]">
            {novel.project.title}
          </span>
        </span>
      </button>

      <div
        aria-hidden
        style={{ width: 1, height: 18, background: 'var(--color-line)' }}
      />

      {/* 视图切换。用 .nav-tab 而不是 .btn-ghost：
          后者 hover 时会填成墨色，而选中项长期处于选中态，
          鼠标划过就整块变黑。这里用底部朱砂线标记选中。 */}
      <nav className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
        {VIEWS.map((v) => {
          const Icon = v.icon
          const active = view === v.id
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className="nav-tab"
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={15} weight={active ? 'fill' : 'regular'} />
              <span>{v.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="flex-1" />

      <UndoRedo />

      <SaveIndicator />

      <SearchTrigger />
    </header>
  )
}
