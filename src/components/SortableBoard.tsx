/* ============================================================
   可拖动的词条板

   目标是「像手机上挪 APP 那样」：按住一张卡片拖走，其余的自己让位，
   松手就落定。两种排版（卡片网格 / 紧凑表格）共用这一套逻辑 ——
   分开写迟早会长出两套手感不同的拖动。

   为什么用 Pointer Events 而不是 HTML5 拖放：
   HTML5 的 dragstart/drop 拿不到「按住那一刻」的坐标，做不出跟手的
   幽灵；而且在无头浏览器里没法用真实的鼠标事件驱动，等于没法验证。
   Pointer 事件两个问题都没有。

   三个关键决定：

   1. **指针捕获打在「板子」上，不打在被拖的卡片上。**
      预览重排会让卡片在 DOM 里换位置；捕获挂在会动的元素上，
      一旦 React 把它挪走，捕获就可能丢，拖到一半会断。

   2. **拖动阈值 5px。** 卡片本身是「点一下进入」的按钮，
      没有阈值的话每次点击都会被当成一次零距离拖动。

   3. **落点算法是「最近项 + 前后判定」，不是几何插槽。**
      网格和表格的行列结构不一样，但「离谁最近、在它的哪一侧」
      这一套对两者都成立，也就不必为每种排版各写一份。

   4. **拖动开始时把各卡片的位置拍一张快照，之后只看快照。**
      预览重排会让卡片当场换位置；如果一边重排一边按当前位置算落点，
      就会自己喂自己 —— 指针不动也可能来回跳。快照把这条路堵死。
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaretRight, Folder, FolderOpen } from '@phosphor-icons/react'
import type { OrgItem } from '../lib/org'
import { cx } from '../lib/util'

/** 拖动阈值：小于这个距离当成点击，不是拖动 */
const THRESHOLD = 5

/**
 * 按住期间把浏览器的「拖蓝选字」关掉，返回一个恢复函数。
 *
 * 不这么做的话：在卡片的名字上按下再移动，浏览器会判定成**选择文字**，
 * 于是拖动变成拖选、卡片不动 —— 必须先点到空白处取消选中才能挪。
 * 画布那边（CanvasGraph）踩过同一个坑，这是同一类界面的标准做法。
 *
 * 三道一起上，缺一条都会漏：
 *  1. body 上 user-select: none  —— 让选择在根上就起不来
 *  2. selectstart 上 preventDefault —— 兜住从别处起头的选择
 *  3. 清掉已有的选区 —— 按下之前如果已经选中了一段，拖动会去扩展它
 */
function blockSelection(): () => void {
  const stop = (e: Event) => e.preventDefault()
  document.addEventListener('selectstart', stop)
  const prev = document.body.style.userSelect
  document.body.style.userSelect = 'none'
  window.getSelection()?.removeAllRanges()
  return () => {
    document.removeEventListener('selectstart', stop)
    document.body.style.userSelect = prev
  }
}

/**
 * 落点。只有两种可能，刻意不做第三种：
 * 要么插到某条缝上（换位），要么整个丢进某个夹子。
 */
export type Drop =
  | { kind: 'reorder'; index: number }
  | { kind: 'drop'; folder: string }

/** 拖动开始时拍下的位置快照。拖动全程只看它，不看会动的 DOM */
interface SlotRect {
  id: string
  kind: 'folder' | 'entity'
  /** 视口坐标，用来判断「指针在不在这个框里」 */
  rect: DOMRect
  /** 相对板子的坐标，用来画那条红线 */
  rel: { left: number; top: number; width: number; height: number }
}

interface DragState {
  id: string
  kind: 'folder' | 'entity'
  name: string
  x: number
  y: number
  target: Drop | null
  /**
   * 这一板是不是「一列排下来」。
   *
   * 不能用 dense（表格 / 网格）来判断：卡片网格在窄窗口下会塌成一列，
   * 那已经是一份竖排列表了，再按「左右半边」决定前后就会错位 ——
   * 落在某张的下半部分会被判成「插到它前面」，看起来像顺序完全乱了。
   * 所以从**实测几何**推：头一行有几张卡。
   */
  isList: boolean
}

export interface SortableBoardProps {
  /** 当前容器（顶层是 ROOT），落点算出来后要回传给 store */
  containerId: string
  items: OrgItem[]
  dense: boolean
  /** 日期等由外面格式化好，板子只负责画 */
  describe: (item: OrgItem) => {
    sub?: string
    summary?: string
    tags?: string[]
    meta?: string[]
    words?: number
    colorVar?: string
  }
  onOpen: (item: OrgItem) => void
  /** visible 是屏幕上这一列的顺序 —— store 要靠它把 index 落回正确的位置 */
  onMove: (id: string, toContainer: string, index: number, visible: string[]) => void
  /** 正在拖的东西，让面包屑之类的地方也参与当落点 */
  onDragChange?: (dragging: boolean) => void
}

export function SortableBoard({
  containerId,
  items,
  dense,
  describe,
  onOpen,
  onMove,
  onDragChange,
}: SortableBoardProps) {
  const boardRef = useRef<HTMLDivElement | null>(null)
  const pressRef = useRef<{
    id: string
    startX: number
    startY: number
    pointerId: number
  } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  /**
   * 拖动结束后的一小段时间里，把 click 吞掉。
   *
   * 用「时间戳」而不是「一个布尔标志」：布尔标志会把**下一次**点击
   * 也吃掉 —— 用户拖完隔几秒点别的东西，第一次点会没反应。
   * 真正要吞的只有紧接着 pointerup 那一下（浏览器几乎立刻补发的 click）。
   */
  const suppressClickUntilRef = useRef(0)
  /** 按住期间那个「恢复选字」的函数，松手时调用 */
  const releaseSelectRef = useRef<(() => void) | null>(null)
  /** 拖动开始那一刻的卡片位置，按当时的显示顺序 */
  const rectsRef = useRef<SlotRect[]>([])
  /** 这一板是不是一列排下来的（见 DragState.isList 的注释） */
  const isListRef = useRef(false)

  /* 万一在按住的状态下被卸载（比如切了视图），别把监听器留在 document 上 */
  useEffect(() => {
    return () => {
      releaseSelectRef.current?.()
      releaseSelectRef.current = null
    }
  }, [])

  const [drag, setDrag] = useState<DragState | null>(null)

  const setDragState = useCallback(
    (next: DragState | null) => {
      dragRef.current = next
      setDrag(next)
      onDragChange?.(next !== null)
    },
    [onDragChange],
  )

  /** 拍快照：按当前 DOM 顺序记下每张卡的位置（视口坐标 + 板内坐标） */
  const snapshot = useCallback(() => {
    const board = boardRef.current
    if (!board) return
    const br = board.getBoundingClientRect()
    rectsRef.current = Array.from(board.querySelectorAll<HTMLElement>('[data-slot]')).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        id: el.dataset.id ?? '',
        kind: (el.dataset.kind as 'folder' | 'entity') ?? 'entity',
        rect: r,
        rel: { left: r.left - br.left, top: r.top - br.top, width: r.width, height: r.height },
      }
    })

    /* 头一行有几张卡 = 几列。用 top 的分组来数，比读 CSS 可靠：
       窗口一窄，grid 就从两三列塌成一列，而这里量的是它塌没塌。 */
    const slots = rectsRef.current
    if (slots.length === 0) {
      isListRef.current = true
      return
    }
    const top0 = Math.min(...slots.map((s) => s.rect.top))
    const cols = slots.filter((s) => Math.abs(s.rect.top - top0) < 6).length
    isListRef.current = cols <= 1
  }, [])

  /**
   * 找到指针底下的落点。
   *
   * 判定顺序（先粗后细）：
   *   1. 面包屑上的某一级（在板子外面）→ 放进那一级
   *   2. 指针落在某个**词条夹的框里** → 放进这个夹子（整框都算，不划小区）
   *   3. 其余情况 → 走换位，红线画在算出来的那条缝上
   */
  const computeTarget = useCallback(
    (x: number, y: number, dragId: string, isList: boolean): Drop | null => {
      const inBox = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

      /* 1. 面包屑（拖动时每一级都会挂上 data-drop-into） */
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-drop-into]'))) {
        const id = el.dataset.dropInto
        if (!id || id === dragId) continue
        if (inBox(el.getBoundingClientRect())) return { kind: 'drop', folder: id }
      }

      /* 快照里跟被拖的那一项无关的部分 */
      const rest = rectsRef.current.filter((s) => s.id !== dragId)

      /* 2. 词条夹的整个框都是「放进」区。
            不划小热区、不放小徽标 —— 框就是目标，指针进去整框变色。 */
      for (const s of rest) {
        if (s.kind !== 'folder') continue
        if (inBox(s.rect)) return { kind: 'drop', folder: s.id }
      }

      /* 3. 换位：用快照算（位置在拖动期间是死的）。
            排除被拖的那一项之后得到的 index，正好是「先把自己摘掉」
            之后该插到第几位 —— 就是 store 要的语义。 */
      if (rest.length === 0) return { kind: 'reorder', index: 0 }

      let best = 0
      let bestD = Number.POSITIVE_INFINITY
      rest.forEach((s, i) => {
        const r = s.rect
        const dx = x - (r.left + r.width / 2)
        const dy = y - (r.top + r.height / 2)
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = i
        }
      })

      const r = rest[best].rect
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2

      /* 插到「它前面」还是「它后面」。
         两种几何要分开判：

         · 一列排下来（表格，或者窄窗口下塌成一列的网格）——
           只能看竖直方向：落在这一项的下半 = 插到它后面。
         · 多列网格 —— 先看竖直：明确在这一行之上/之下就定了；
           落在同一行的带子里，才用左右半边决定前后。

         混着写（比如「在下面或是同行靠右」）会在网格里出问题：
         指针停在正中偏右半像素也会被判成「后面」，
         于是「拖到第一张那儿」会插到第二张前面。 */
      let after: boolean
      if (isList) {
        after = y > cy
      } else if (y > r.bottom) {
        after = true
      } else if (y < r.top) {
        after = false
      } else {
        after = x > cx
      }
      return { kind: 'reorder', index: after ? best + 1 : best }
    },
    [],
  )

  const onPointerDown = (e: React.PointerEvent, item: OrgItem) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    // 夹子上的「移入」热区、以及任何标了 data-no-drag 的东西不参与拖动
    if (el.closest('[data-no-drag]')) return
    pressRef.current = { id: item.id, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId }
    /* 这里**不能**抢指针捕获。
       一旦捕获，浏览器会把这次手势派生出来的 click 派发给捕获元素
       （也就是板子），卡片自己的 onClick 永远收不到 —— 表现就是
       「拖动和红线都对，但点卡片打不开了」。
       捕获推迟到真正开始拖动那一刻（越过阈值之后）再做。 */
    pressRef.current.pointerId = e.pointerId
    // 按下的这一刻就开始防选字，不能等越过阈值 —— 拖蓝在那之前就开始了
    releaseSelectRef.current?.()
    releaseSelectRef.current = blockSelection()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const press = pressRef.current
    if (!press) return
    const cur = dragRef.current

    if (!cur) {
      const far =
        Math.abs(e.clientX - press.startX) > THRESHOLD ||
        Math.abs(e.clientY - press.startY) > THRESHOLD
      if (!far) return
      const item = items.find((i) => i.id === press.id)
      if (!item) return
      // 先拍快照再算落点：之后的判定都基于这张不会变的图
      snapshot()
      // 到这里才算真的在拖，这时候抢捕获不会影响任何点击
      try {
        boardRef.current?.setPointerCapture(press.pointerId)
      } catch {
        /* 指针已经没了，忽略 */
      }
      const isList = isListRef.current
      setDragState({
        id: press.id,
        kind: item.kind,
        name: item.kind === 'folder' ? item.folder.name : item.entity.name,
        x: e.clientX,
        y: e.clientY,
        isList,
        target: computeTarget(e.clientX, e.clientY, press.id, isList),
      })
      return
    }

    setDragState({
      ...cur,
      x: e.clientX,
      y: e.clientY,
      target: computeTarget(e.clientX, e.clientY, cur.id, cur.isList),
    })
  }

  const finishDrag = () => {
    const cur = dragRef.current
    pressRef.current = null
    releaseSelectRef.current?.()
    releaseSelectRef.current = null
    if (!cur) return

    const stillThere = items.some((i) => i.id === cur.id)
    const curIndex = items.findIndex((i) => i.id === cur.id)
    setDragState(null)
    rectsRef.current = []
    if (!cur.target || !stillThere) return

    // 拖过就算拖动，别再触发「点一下进入」
    suppressClickUntilRef.current = performance.now() + 300

    /* 屏幕上这一列的顺序，**包含**被拖的那一项 ——
       reorderVisible 要自己把它从原槽位摘掉。
       早先这里把被拖的那一项滤掉了，于是它的旧槽位保留着它、
       收尾又补了一个它：同一个 id 在数组里出现两次，
       夹子上显示的条目数就凭空变大。 */
    const visible = items.map((i) => i.id)

    if (cur.target.kind === 'drop') {
      // 放进夹子：追加到那个夹子的末尾（moveItem 会自己夹到合法范围）
      onMove(cur.id, cur.target.folder, Number.MAX_SAFE_INTEGER, visible)
      return
    }
    if (cur.target.index === curIndex) return // 原地放下，不写盘
    onMove(cur.id, containerId, cur.target.index, visible)
  }

  const openItem = (item: OrgItem) => {
    if (performance.now() < suppressClickUntilRef.current) return
    onOpen(item)
  }

  /* ---------------- 落点的两种画法 ----------------

     换位：不做「其余卡片当场让位」那套预览，改成 PPT 那样在两条之间
     画一条红线。理由是让位预览会自己喂自己 —— 一边重排一边按当前位置
     算落点，指针不动也可能来回跳；而且卡片一动，你反而看不清会插到哪。

     放进夹子：整个夹子框变色，不给小徽标。徽标的问题是它太小、
     而且要挂在卡片里，同级条目也会被误挂上。 */

  const target = drag?.target ?? null
  const intoFolder = target?.kind === 'drop' ? target.folder : null
  const draggingId = drag?.id ?? null

  /** 红线画在哪 */
  const line = useMemo(() => {
    if (!drag || !target || target.kind !== 'reorder') return null
    const rest = rectsRef.current.filter((s) => s.id !== drag.id)
    if (rest.length === 0) return null
    const at = Math.max(0, Math.min(target.index, rest.length))

    /* 一列排下来 → 横线（插在上面 / 下面）
       多列网格 → 竖线（插在左边 / 右边）
       这两种不能搞反：单列时画竖线，读起来像「插到旁边」，
       而不是「插到上面那一格」。 */
    if (drag.isList) {
      const last = rest[rest.length - 1].rel
      const y =
        at < rest.length
          ? rest[at].rel.top - 2
          : last.top + last.height + 1
      return { horizontal: true, top: y, left: 0, length: undefined }
    }
    if (at < rest.length) {
      const r = rest[at].rel
      return { horizontal: false, left: r.left - 6, top: r.top, length: r.height }
    }
    const last = rest[rest.length - 1].rel
    return { horizontal: false, left: last.left + last.width + 4, top: last.top, length: last.height }
  }, [drag, target])

  return (
    <div
      ref={boardRef}
      data-dragging={drag ? 'true' : 'false'}
      /* 落点挂在 DOM 上：拖动这事没法靠读代码验证，得能当场看见它算成了什么 */
      data-drop-index={target?.kind === 'reorder' ? target.index : ''}
      data-drop-folder={intoFolder ?? ''}
      className="relative"
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      style={{
        /* 关掉文本选择：这是拖动词条板的前提。
           不加的话，在卡片名字上按下再移动会被判定成「选择文字」，
           拖动变成拖选、卡片不动。画布那边同一条。 */
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...(drag ? { touchAction: 'none' as const } : {}),
      }}
    >
      {dense ? (
        /* borderSpacing 给行之间留出真实的缝：那条缝不属于任何一行，
           所以「指针在夹子框里 = 放进」这条规则不会把换位的位置全吃掉。
           行的圆角与底色都交给 .ns-rows 那套样式（见 theme.css）。 */
        <table
          className="ns-rows w-full"
          style={{ borderCollapse: 'separate', borderSpacing: '0 3px' }}
        >
          <tbody>
            {items.map((item) => {
              const d = describe(item)
              const isDrag = item.id === draggingId
              const isInto = item.kind === 'folder' && item.id === intoFolder
              return (
                <tr
                  key={item.id}
                  data-slot=""
                  data-id={item.id}
                  data-kind={item.kind}
                  data-drag={isDrag ? 'true' : 'false'}
                  data-into={isInto ? 'true' : 'false'}
                  onPointerDown={(e) => onPointerDown(e, item)}
                  onClick={() => openItem(item)}
                  className="cursor-pointer transition-colors"
                  style={isDrag ? { opacity: 0.4 } : undefined}
                >
                  <td className="py-[7px] pr-3 align-top" style={{ width: 22 }}>
                    {item.kind === 'folder' ? (
                      <Folder size={12} weight="fill" style={{ color: 'var(--color-ink-soft)' }} />
                    ) : (
                      <span
                        aria-hidden
                        style={{
                          display: 'block',
                          width: 7,
                          height: 7,
                          marginTop: 4,
                          background: `var(${d.colorVar})`,
                        }}
                      />
                    )}
                  </td>
                  <td
                    className="py-[7px] pr-4 align-top text-[12.5px]"
                    style={{ width: 180 }}
                  >
                    <span className="flex items-center gap-2">
                      {item.kind === 'folder' ? item.folder.name : item.entity.name}
                    </span>
                  </td>
                  <td
                    className="py-[7px] pr-4 align-top text-[11.5px]"
                    style={{ color: 'var(--color-ink-soft)' }}
                  >
                    {item.kind === 'folder' ? (item.folder.desc ?? '') : d.summary}
                  </td>
                  <td
                    className="t-num py-[7px] pr-3 align-top text-right"
                    style={{ color: 'var(--color-ink-faint)', width: 70 }}
                  >
                    {d.meta?.join(' · ')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {items.map((item) => {
            const d = describe(item)
            const isDrag = item.id === draggingId
            const isInto = item.kind === 'folder' && item.id === intoFolder
            const folder = item.kind === 'folder'
            return (
              <div
                key={item.id}
                data-slot=""
                data-id={item.id}
                data-kind={item.kind}
                onPointerDown={(e) => onPointerDown(e, item)}
                onClick={() => openItem(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openItem(item)
                  }
                }}
                className={cx(
                  'ns-card panel flex cursor-pointer flex-col p-3.5 text-left transition-all',
                  !drag && 'anim-fade-up',
                )}
                data-folder={folder ? 'true' : 'false'}
                data-into={isInto ? 'true' : 'false'}
                style={{ opacity: isDrag ? 0.4 : 1 }}
              >
                <div className="flex items-start gap-2.5">
                  <span className="mt-[3px] flex-none" style={{ lineHeight: 0 }}>
                    {folder ? (
                      <FolderOpen size={14} weight="fill" style={{ color: 'var(--color-ink-soft)' }} />
                    ) : (
                      <span
                        aria-hidden
                        style={{
                          display: 'block',
                          width: 8,
                          height: 8,
                          marginTop: 3,
                          background: `var(${d.colorVar})`,
                        }}
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">
                      {folder ? item.folder.name : item.entity.name}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                        {d.sub}
                      </span>
                      {(d.meta ?? []).map((m) => (
                        <span key={m} className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                  {folder && (
                    <CaretRight size={12} style={{ color: 'var(--color-ink-faint)', marginTop: 4 }} />
                  )}
                </div>

                {(folder ? item.folder.desc : d.summary) && (
                  <p
                    className="mt-2.5 line-clamp-2 text-[12px] leading-[1.7]"
                    style={{ color: 'var(--color-ink-soft)' }}
                  >
                    {folder ? item.folder.desc : d.summary}
                  </p>
                )}

                <div className="mt-3 flex items-center gap-1.5">
                  {!folder &&
                    (d.tags ?? []).slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="chip"
                        style={{
                          color: 'var(--color-ink-faint)',
                          borderColor: 'var(--color-line-soft)',
                          background: 'transparent',
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  <span className="flex-1" />
                  {!folder && d.words ? (
                    <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                      {d.words} 字
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 插入位置：一条红线，像 PPT 里挪幻灯片那样。
          位置是从快照算的绝对坐标，拖动期间不会因为重排而漂。 */}
      {line && (
        <div
          data-drop-line={line.horizontal ? 'h' : 'v'}
          className="pointer-events-none absolute"
          style={
            line.horizontal
              ? {
                  left: 0,
                  right: 0,
                  top: line.top,
                  height: 2,
                  background: 'var(--color-accent)',
                }
              : {
                  left: line.left,
                  top: line.top,
                  width: 2,
                  height: line.length,
                  background: 'var(--color-accent)',
                }
          }
        />
      )}

      {/* 拖到夹子上不写字：整框变色本身就是信号。
          原本这里放了句提示，但那正是被嫌的那六个字的变体 ——
          目标区已经够明确，再压一行字只是噪音。 */}

      {/* 跟手的幽灵。pointer-events 关掉，免得它自己成了 e.target */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 px-2.5 py-1.5 text-[12px]"
          style={{
            left: drag.x + 12,
            top: drag.y + 12,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-accent)',
            color: 'var(--color-ink)',
            boxShadow: '0 4px 14px rgb(0 0 0 / 0.16)',
          }}
        >
          {drag.name}
        </div>
      )}
    </div>
  )
}
