/* ============================================================
   一张手工摆的时间线

   为什么是竖的：
   时间从上往下走，「同一时期不同地方在发生什么」才读得出来 ——
   横着排的时候，同期的事被挤在一条细缝里，越往后越看不清。

   为什么行不能拖、只有横坐标能拖：
   行是**事实**（这件事发生在哪一年哪一月），要改它只能去改事件的时间；
   横坐标是**判断**（这件事画在左边还是右边），只有它需要人来做。
   两者都做成可拖的，就会出现「第 3 行的事件」和它的 date 对不上的状态。
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarBlank, MapPin, Plus, Trash, UsersThree, X } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import {
  BOARD_MAX_WIDTH,
  BOARD_MIN_WIDTH,
  BOARD_WIDTH_STEP,
  addGuide,
  addToBoard,
  boardLayout,
  boardSpan,
  clamp01,
  clampBoardWidth,
  dateRowKey,
  freeXOnRow,
  moveOnBoard,
  newBoard,
  removeFromBoard,
  removeGuide,
  setBoardWidth,
  updateGuide,
} from '../lib/boards'
import type { TimelineBoard } from '../lib/types'
import { formatDate, formatDateShort, formatRowDate } from '../lib/dates'
import { castOf } from '../lib/index-builder'
import { resolvePlace } from '../lib/places'
import { TypeDot } from '../components/ui'
import { cx } from '../lib/util'

/** 一行的高度。滚轮一次走过几行，节奏感就来自它 */
const ROW_H = 46
/** 一格的大小 */
const CELL_W = 138
const CELL_H = 28
/** 左边那条时间刻度的宽度。够放下「E1·421·一·1」这种紧凑日期 */
const GUTTER = 118

/* ============================================================
   一张板
   ============================================================ */

export function BoardView({ board, onBack }: { board: TimelineBoard; onBack: () => void }) {
  const novel = useStore((s) => s.novel)
  const setBoards = useStore((s) => s.setBoards)
  const select = useStore((s) => s.select)

  const laneRef = useRef<HTMLDivElement | null>(null)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const [areaW, setAreaW] = useState(900)
  const [drag, setDrag] = useState<{ id: string; x: number; offCenter: number } | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** 悬停浮层：记的是屏幕坐标（fixed 定位），所以滚动、缩放都不影响它 */
  const [tip, setTip] = useState<{ id: string; x: number; y: number; below: boolean } | null>(null)
  const [overBoard, setOverBoard] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [guideDrag, setGuideDrag] = useState<string | null>(null)
  const [columnHint, setColumnHint] = useState(false)

  /* 可视宽度：板宽是「几屏」，所以要量出来才换算得成像素 */
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const apply = () => setAreaW(el.clientWidth)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cal = novel?.project.calendar

  const layout = useMemo(
    () =>
      novel && cal
        ? boardLayout(novel, board, cal)
        : { rows: [], undated: [], missing: 0 },
    [novel, board, cal],
  )

  const patchBoard = useCallback(
    (next: TimelineBoard) => {
      if (!novel) return
      setBoards(novel.project.boards.map((b) => (b.id === next.id ? next : b)))
    },
    [novel, setBoards],
  )

  const boardWidth = clampBoardWidth(board.width)
  /* 板宽存的是「几屏」，量出可视宽度才换算成像素：×1 正好一屏（不出横向滚动条），
     ×2 就是两屏宽 —— 同一时间的事再多也摆得开。 */
  const laneW = Math.max(320, Math.round((areaW - GUTTER) * boardWidth))

  /* 悬停浮层要显示的东西，和自动排好那张图完全同一套算法 ——
     两处各算一遍迟早会显示成两样。 */
  const tipEntity = tip ? novel?.entities.find((e) => e.id === tip.id) : undefined
  const tipInfo = useMemo(
    () =>
      novel && tipEntity
        ? { loc: resolvePlace(novel, tipEntity.at), parts: castOf(novel, tipEntity.id) }
        : null,
    [novel, tipEntity],
  )

  /** 浮层跟着格子走：屏幕坐标 + fixed，滚动和缩放都不用重算 */
  const openTip = (id: string, el: HTMLElement) => {
    // 拖的时候别一直弹浮层挡着格子
    if (drag) return
    const r = el.getBoundingClientRect()
    // 靠近顶上的行没有地方往上翻，就翻到下面
    const below = r.top < 200
    setTip({
      id,
      x: Math.max(8, Math.min(r.left, window.innerWidth - 318)),
      y: below ? r.bottom + 8 : r.top - 8,
      below,
    })
  }

  /** 屏幕坐标 → 相对事件区的归一化横坐标 */
  const laneX = (clientX: number) => {
    const r = laneRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return 0.5
    return clamp01((clientX - r.left) / r.width)
  }

  /* ---------------- 从左边拖一格进来 ---------------- */

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOverBoard(false)
    if (!novel) return
    const id = e.dataTransfer.getData('text/plain')
    const entity = novel.entities.find((x) => x.id === id)
    if (!entity || entity.type !== 'event') return
    if (board.items.some((i) => i.entity === id)) {
      setHint(`「${entity.name}」已经在这张时间线上了`)
      return
    }

    /* 行由它自己的时间决定，落点的纵坐标不参与 —— 拖到哪儿都不会
       改变「这件事发生在什么时候」。落点只用它的横坐标。 */
    const row = entity.date
      ? layout.rows.find((r) => r.key === dateRowKey(entity.date!))
      : undefined
    const r = laneRef.current?.getBoundingClientRect()
    const x = row && r && r.width > 0
      // 这一行已经有格子了：往右让开一个位置，别叠在一起
      ? freeXOnRow(row.items, CELL_W / r.width)
      : laneX(e.clientX)

    patchBoard(addToBoard(board, id, x))
    setHint(
      entity.date
        ? `「${entity.name}」排到了 ${formatDateShort(entity.date, cal!)} 那一行`
        : `「${entity.name}」还没有时间，先收在上面的「未定时间」里 —— 给它填个年份，它自己会落下来`,
    )
  }

  /* ---------------- 左右拖一格 ---------------- */

  const startCellDrag = (e: React.PointerEvent, id: string) => {
    const cell = e.currentTarget as HTMLElement
    const lane = laneRef.current?.getBoundingClientRect()
    if (!lane || lane.width === 0) return
    e.stopPropagation()
    cell.setPointerCapture(e.pointerId)
    setTip(null)
    const r = cell.getBoundingClientRect()
    // 抓住哪儿就从哪儿拖：记下指针偏离格子中心的量，别让它「跳到指针上」
    setDrag({
      id,
      x: clamp01((r.left + r.width / 2 - lane.left) / lane.width),
      offCenter: (e.clientX - (r.left + r.width / 2)) / lane.width,
    })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const lane = laneRef.current?.getBoundingClientRect()
    if (!lane || lane.width === 0) return
    const half = CELL_W / 2 / lane.width
    const raw = (e.clientX - lane.left) / lane.width - drag.offCenter
    setDrag({ ...drag, x: Math.max(half, Math.min(1 - half, raw)) })
  }

  const endCellDrag = () => {
    if (!drag) return
    patchBoard(moveOnBoard(board, drag.id, drag.x))
    setDrag(null)
  }

  /* ---------------- 拖竖线 ----------------
     竖线的把手在下面的横条里，不在滚动容器内，所以用 window 上的监听，
     免得指针一离开那条把手就丢掉。 */

  useEffect(() => {
    if (!guideDrag) return
    const move = (e: PointerEvent) => {
      const r = laneRef.current?.getBoundingClientRect()
      if (!r || r.width === 0) return
      const x = clamp01((e.clientX - r.left) / r.width)
      setBoards(
        useStore.getState().novel?.project.boards.map((b) =>
          b.id === board.id ? updateGuide(b, guideDrag, { x }) : b,
        ) ?? [],
      )
    }
    const up = () => setGuideDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [guideDrag, board.id, setBoards])

  if (!novel || !cal) return null

  const events = novel.entities.filter((e) => e.type === 'event')
  const placed = new Set(board.items.map((i) => i.entity))
  const unplaced = events.filter((e) => !placed.has(e.id))
  const cellCount = layout.rows.reduce((n, r) => n + r.items.length, 0)

  return (
    <div className="flex h-full min-h-0">
      {/* ---------------- 左：所有事件，拖进来 ---------------- */}
      <aside
        className="flex min-h-0 flex-none flex-col"
        style={{ width: 216, borderRight: '1px solid var(--color-line)' }}
      >
        <div className="flex flex-none items-baseline gap-2 px-3 pt-3 pb-1.5">
          <span className="t-micro">事件</span>
          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {unplaced.length}
          </span>
        </div>
        <div
          className="flex-none px-3 pb-2 text-[11px] leading-relaxed"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          把事件拖到右边。它会自己排到对应的时间行上
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {unplaced.length === 0 ? (
            <div
              className="px-2 py-6 text-center text-[11.5px] leading-relaxed"
              style={{ color: 'var(--color-ink-faint)' }}
            >
              {events.length === 0
                ? '还没有事件条目。先去「设定」建几个。'
                : '所有事件都已经在这张时间线上了。'}
            </div>
          ) : (
            <ul>
              {unplaced.map((e) => (
                <li key={e.id}>
                  <div
                    draggable
                    data-drag-event={e.id}
                    onDragStart={(ev) => {
                      ev.dataTransfer.setData('text/plain', e.id)
                      ev.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => select(e.id)}
                    title={e.date ? '拖到右边' : '还没有时间，拖过去会先落在「未定时间」'}
                    className="flex cursor-grab items-center gap-2 px-2 py-1.5"
                  >
                    <TypeDot type="event" size={6} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.name}</span>
                    {/* 和左边刻度用同一套写法：加上「年」才看得出来这是时间，
                        光写「前293」容易被读成年份编号 */}
                    <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
                      {e.date ? formatRowDate(e.date, cal).head : '无时'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* ---------------- 右：时间线板 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
          style={{ borderBottom: '1px solid var(--color-line)' }}
        >
          <button type="button" className="btn btn-plain flex-none" onClick={onBack} title="回到时间线列表">
            <ArrowLeft size={13} />
          </button>
          {/* 名字就在这儿改：点进去直接改，不用再翻到别的地方 */}
          <input
            className="min-w-0 bg-transparent p-0 text-[13.5px] font-semibold outline-none"
            style={{ color: 'var(--color-ink)', width: 180 }}
            value={board.name}
            placeholder="给这张时间线起个名字"
            onChange={(e) => patchBoard({ ...board, name: e.target.value })}
            title="点一下就能改名字"
          />
          <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
            {layout.rows.length} 个时间 · {cellCount} 格
            {layout.undated.length > 0 ? ` · ${layout.undated.length} 个还没时间` : ''}
          </span>
          {hint && (
            <span className="text-[11.5px]" style={{ color: 'var(--color-ink-soft)' }}>
              {hint}
            </span>
          )}
          <span className="flex-1" />
          <div className="flex flex-none items-center gap-0.5" title="板宽：一屏摆不下的时候放宽，右边会出现横向滚动条">
            <button
              type="button"
              className="btn btn-plain"
              style={{ padding: '2px 6px' }}
              disabled={boardWidth <= BOARD_MIN_WIDTH}
              onClick={() => patchBoard(setBoardWidth(board, boardWidth - BOARD_WIDTH_STEP))}
              title="收窄"
            >
              −
            </button>
            <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
              板宽 ×{Number.isInteger(boardWidth) ? boardWidth : boardWidth.toFixed(1)}
            </span>
            <button
              type="button"
              className="btn btn-plain"
              style={{ padding: '2px 6px' }}
              disabled={boardWidth >= BOARD_MAX_WIDTH}
              onClick={() => patchBoard(setBoardWidth(board, boardWidth + BOARD_WIDTH_STEP))}
              title="放宽：同一时间的事情一多，一屏就摆不下了"
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="btn btn-plain"
            onClick={() => {
              // 只在第一次加列时解释一遍 —— 这一条光看「列 1」两个字没人猜得出
              setColumnHint(board.guides.length === 0)
              patchBoard(addGuide(board, `列 ${board.guides.length + 1}`, 0.5))
            }}
            title="多一条竖线当参照：给它起个名字（齐国、宋国、某个战场都行），把同一列的事对齐"
          >
            <Plus size={11} />
            加一列
          </button>
        </div>

        {/* 头一次用列的时候解释一句。这个功能光看「列 1」两个字没人猜得出 */}
        {columnHint && board.guides.length > 0 && (
          <div
            className="flex flex-none items-start gap-2 px-3 py-2 text-[11.5px] leading-relaxed"
            style={{
              background: 'color-mix(in oklab, var(--color-accent) 6%, transparent)',
              borderBottom: '1px solid var(--color-line-soft)',
              color: 'var(--color-ink-soft)',
            }}
          >
            <span className="flex-1">
              列 = 一条竖着的参照线，用来把同一类事对齐（比如「齐国的事都靠左」）。
              名字在上面的条里改，按住左边那个小把手能左右挪它 ——
              <b style={{ color: 'var(--color-ink)' }}>它不会锁住格子</b>，格子照样随便摆。
            </span>
            <button type="button" className="btn btn-plain flex-none" onClick={() => setColumnHint(false)}>
              知道了
            </button>
          </div>
        )}

        {/* 未定时间不跟着横向滚动：它不是画布上的位置，是「还没进场」的等候区 */}
        {layout.undated.length > 0 && (
          <div
            className="flex flex-none flex-wrap items-center gap-2 px-3 py-2"
            style={{ borderBottom: '1px dashed var(--color-line)' }}
          >
            <span className="t-micro flex-none" style={{ color: 'var(--color-warn)' }}>
              未定时间
            </span>
            {layout.undated.map(({ entity }) => (
              <button
                key={entity.id}
                type="button"
                className="chip"
                onClick={() => select(entity.id)}
                title="给它填个时间，它自己会落到对应那一行"
              >
                {entity.name}
              </button>
            ))}
          </div>
        )}

        <div
          ref={areaRef}
          data-board-area="1"
          className="relative min-h-0 flex-1 overflow-auto"
          style={{ background: 'var(--color-base)' }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setOverBoard(true)
          }}
          onDragLeave={() => setOverBoard(false)}
          onDrop={onDrop}
          onPointerMove={onPointerMove}
          onPointerUp={endCellDrag}
          onPointerCancel={endCellDrag}
          // 滚动之后浮层还钉在原地就成了「飘着的旧信息」，直接收掉
          onScroll={() => setTip(null)}
        >
          {board.items.length === 0 ? (
            <div className="grid h-full place-items-center px-6">
              <div
                className="max-w-[420px] px-5 py-4 text-center"
                style={{
                  border: '1px dashed var(--color-line-strong)',
                  background: 'color-mix(in oklab, var(--color-base) 85%, transparent)',
                }}
              >
                <div className="text-[13px] font-semibold">把左边的事件拖进来</div>
                <div
                  className="mt-1 text-[11.5px] leading-relaxed"
                  style={{ color: 'var(--color-ink-faint)' }}
                >
                  放进来之后它会自己排到对应的时间行上。左右位置随你摆 ——
                  同一行里一左一右，就是「同一时间、两个地方」。
                </div>
              </div>
            </div>
          ) : (
            <div style={{ width: GUTTER + laneW }}>
              {/* 列名条：贴在顶上，和下面的竖线同一个横坐标。
                  以前名字放在底部的横条里，看着和板子没关系 —— 这里才是
                  「一列」该有表头的地方。 */}
              {board.guides.length > 0 && (
                <div
                  className="sticky top-0 z-10"
                  style={{
                    marginLeft: GUTTER,
                    width: laneW,
                    background: 'var(--color-base)',
                    borderBottom: '1px solid var(--color-line)',
                  }}
                >
                  <div className="relative" style={{ height: 32 }}>
                    {board.guides.map((g) => (
                      <div
                        key={g.id}
                        data-guide={g.id}
                        className="absolute flex items-center gap-1"
                        style={{ left: `${g.x * 100}%`, transform: 'translateX(-50%)', top: 4 }}
                      >
                        <span
                          className="flex-none cursor-col-resize select-none"
                          style={{ color: guideDrag === g.id ? 'var(--color-accent)' : 'var(--color-line-strong)', fontSize: 11 }}
                          onPointerDown={(e) => {
                            e.preventDefault()
                            setGuideDrag(g.id)
                          }}
                          title="按住左右拖动这条竖线"
                        >
                          ⠿
                        </span>
                        <input
                          className="input"
                          style={{ width: 84, fontSize: 11, padding: '2px 5px' }}
                          value={g.name}
                          placeholder="这一列是什么"
                          title="这一列是什么？齐国、宋国、某个战场都行"
                          onChange={(e) => patchBoard(updateGuide(board, g.id, { name: e.target.value }))}
                        />
                        <button
                          type="button"
                          className="btn btn-plain flex-none"
                          style={{ padding: 1 }}
                          onClick={() => patchBoard(removeGuide(board, g.id))}
                          title="删掉这条竖线（不会动任何事件）"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-start">
                {/* 左边的刻度：横向滚动时粘在左边。
                    它是这张图唯一的坐标轴，滚到右边也丢不得。 */}
                <div
                  data-gutter="1"
                  className="sticky left-0 z-20 flex-none"
                  style={{ width: GUTTER, background: 'var(--color-base)' }}
                >
                  {layout.rows.map((r, i) => (
                    <div
                      key={r.key}
                      style={{
                        height: ROW_H,
                        borderTop: '1px solid var(--color-line-soft)',
                        background:
                          i % 2 === 0
                            ? 'transparent'
                            : 'color-mix(in oklab, var(--color-surface) 45%, transparent)',
                      }}
                    >
                      {/* 上：到年（大一点、用正文色，这是这一行的身份）。
                          下：到月日。光靠一行 11px 的灰字太容易看漏 ——
                          左边的刻度是这张图唯一的坐标，得站得住。 */}
                      <div
                        data-row-label={r.key}
                        style={{
                          marginLeft: 14,
                          width: GUTTER - 22,
                          paddingTop: 5,
                          paddingLeft: 7,
                          borderLeft: '2px solid var(--color-line-strong)',
                        }}
                      >
                        <div
                          className="t-num truncate"
                          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-ink)', lineHeight: 1.25 }}
                        >
                          {r.head}
                        </div>
                        {r.tail && (
                          <div
                            className="t-num truncate"
                            style={{ fontSize: 10.5, color: 'var(--color-ink-faint)', lineHeight: 1.3 }}
                          >
                            {r.tail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div
                  ref={laneRef}
                  data-lane="1"
                  className="relative flex-none"
                  style={{ width: laneW, height: layout.rows.length * ROW_H }}
                >
                  {layout.rows.map((r, i) => (
                    <div
                      key={r.key}
                      data-row={r.key}
                      className="absolute left-0 right-0"
                      style={{
                        top: i * ROW_H,
                        height: ROW_H,
                        borderTop: '1px solid var(--color-line-soft)',
                        background:
                          i % 2 === 0
                            ? 'transparent'
                            : 'color-mix(in oklab, var(--color-surface) 45%, transparent)',
                      }}
                    />
                  ))}

                  {/* 竖线：作者自己定义「列」是什么意思 */}
                  {board.guides.map((g) => (
                    <div
                      key={g.id}
                      className="absolute top-0 bottom-0"
                      style={{ left: `${g.x * 100}%`, width: 1, background: 'color-mix(in oklab, var(--color-accent) 26%, transparent)' }}
                    />
                  ))}

                  {layout.rows.map((r, i) =>
                    r.items.map(({ entity, x }) => {
                      const dragging = drag?.id === entity.id
                      const px = dragging ? drag!.x : x
                      return (
                        <div
                          key={entity.id}
                          data-cell={entity.id}
                          onPointerDown={(e) => startCellDrag(e, entity.id)}
                          onPointerEnter={(e) => {
                            setHoverId(entity.id)
                            openTip(entity.id, e.currentTarget)
                          }}
                          onPointerLeave={() => {
                            setHoverId((v) => (v === entity.id ? null : v))
                            setTip((v) => (v?.id === entity.id ? null : v))
                          }}
                          className={cx(
                            'absolute flex items-center gap-1.5',
                            dragging ? 'cursor-grabbing' : 'cursor-grab',
                          )}
                          style={{
                            top: i * ROW_H + (ROW_H - CELL_H) / 2,
                            // 两头都不许探出画布：x=0 和 x=1 是「贴到边上」，不是「半个在外面」
                            left: `min(calc(100% - ${CELL_W}px), max(0px, calc(${px * 100}% - ${CELL_W / 2}px)))`,
                            width: CELL_W,
                            height: CELL_H,
                            padding: '0 6px 0 8px',
                            borderRadius: 'var(--radius-sm)',
                            border: `1px solid ${
                              dragging || hoverId === entity.id
                                ? 'var(--color-accent)'
                                : 'var(--color-line)'
                            }`,
                            background: 'var(--color-surface)',
                            zIndex: dragging ? 40 : 1,
                            boxShadow: dragging ? '0 6px 18px rgb(0 0 0 / 0.18)' : 'none',
                            // 拖的时候别让浏览器把它当成「选中文字」
                            userSelect: 'none',
                            WebkitUserSelect: 'none',
                          }}
                        >
                          <TypeDot type="event" size={5} />
                          <span className="min-w-0 flex-1 truncate text-[12px]">{entity.name}</span>
                          <button
                            type="button"
                            onPointerDown={(ev) => ev.stopPropagation()}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              patchBoard(removeFromBoard(board, entity.id))
                            }}
                            title="从这张时间线上拿掉（条目本身不动）"
                            className="flex-none"
                            style={{ color: 'var(--color-ink-faint)' }}
                          >
                            <X size={10} />
                          </button>
                        </div>
                      )
                    }),
                  )}
                </div>
              </div>
            </div>
          )}

          {overBoard && (
            <div
              className="pointer-events-none absolute inset-0"
              style={{ outline: '2px dashed var(--color-accent)', outlineOffset: -6 }}
            />
          )}
        </div>
      </div>

      {/* ---------------- 悬停浮层：时间 / 地点 / 参与角色 ----------------
          和「全部事件」那张自动排好的图用同一套取值，两处不会说法不一。
          用 fixed 定位，所以横向、纵向怎么滚都不会漂。 */}
      {tip && tipEntity && (
        <div
          data-board-tip="1"
          style={{
            position: 'fixed',
            left: tip.x,
            top: tip.y,
            transform: tip.below ? 'none' : 'translateY(-100%)',
            zIndex: 60,
            width: 302,
            pointerEvents: 'none',
            padding: '10px 12px 9px',
            background: 'var(--color-overlay)',
            border: '1px solid var(--color-line-strong)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-raise)',
          }}
        >
          <div className="flex items-center gap-2">
            <TypeDot type="event" size={8} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {tipEntity.name}
            </span>
          </div>

          <div className="mt-2 flex items-start gap-1.5">
            <CalendarBlank
              size={12}
              style={{ flex: 'none', marginTop: 2, color: 'var(--color-ink-faint)' }}
            />
            <span className="t-num" style={{ color: 'var(--color-ink-mid)' }}>
              {formatDate(tipEntity.date, cal)}
              {tipEntity.dateEnd ? ` → ${formatDate(tipEntity.dateEnd, cal)}` : ''}
            </span>
          </div>

          <div className="mt-1 flex items-start gap-1.5">
            <MapPin
              size={12}
              style={{ flex: 'none', marginTop: 2, color: 'var(--color-ink-faint)' }}
            />
            <span
              className="text-[12px]"
              style={{ color: tipInfo?.loc ? 'var(--color-ink-mid)' : 'var(--color-ink-faint)' }}
            >
              {tipInfo?.loc ? tipInfo.loc.name : '未定地点'}
            </span>
          </div>

          <div className="mt-1 flex items-start gap-1.5">
            <UsersThree
              size={12}
              style={{ flex: 'none', marginTop: 2, color: 'var(--color-ink-faint)' }}
            />
            {tipInfo && tipInfo.parts.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {tipInfo.parts.slice(0, 6).map((p) => (
                  <span key={p.id} className="flex items-center gap-1">
                    <TypeDot type={p.type} size={5} />
                    <span className="text-[12px]" style={{ color: 'var(--color-ink-mid)' }}>
                      {p.name}
                    </span>
                  </span>
                ))}
                {tipInfo.parts.length > 6 && (
                  <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                    +{tipInfo.parts.length - 6}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[12px]" style={{ color: 'var(--color-ink-faint)' }}>
                还没有参与角色
              </span>
            )}
          </div>

          {tipEntity.fields?.['后果'] && (
            <p className="t-prose mt-2 line-clamp-4 text-[12.5px]">{tipEntity.fields['后果']}</p>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================================================
   列表：先选一张，再进去摆
   ============================================================ */

export function BoardList({
  onOpen,
  onOpenDerived,
}: {
  onOpen: (id: string) => void
  onOpenDerived: () => void
}) {
  const novel = useStore((s) => s.novel)
  const setBoards = useStore((s) => s.setBoards)
  const [confirm, setConfirm] = useState<string | null>(null)

  if (!novel) return null
  const cal = novel.project.calendar
  const boards = novel.project.boards

  const create = () => {
    const board = newBoard(`时间线 ${boards.length + 1}`)
    setBoards([...boards, board])
    onOpen(board.id)
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-[720px]">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[17px] font-semibold">时间线</h2>
          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {boards.length} 张
          </span>
          <span className="flex-1" />
          <button type="button" className="btn btn-primary" onClick={create}>
            <Plus size={12} />
            新建时间线
          </button>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--color-ink-soft)' }}>
          一张时间线是你自己摆的一张图：放哪些事件、谁和谁对齐，都由你决定。
        </p>

        <div className="mt-5 flex flex-col gap-2">
          {boards.map((b) => {
            const span = boardSpan(novel, b, cal)
            return (
              <div key={b.id} data-board={b.id} className="ns-card panel flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpen(b.id)}
                >
                  <div className="truncate text-[13.5px] font-medium">{b.name}</div>
                  <div
                    className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11.5px]"
                    style={{ color: 'var(--color-ink-faint)' }}
                  >
                    <span className="t-num">
                      {span.dated === 0
                        ? '还没有排上时间的事件'
                        : `${span.from} → ${span.to}`}
                    </span>
                    <span className="t-num">{span.count} 个事件</span>
                    {b.guides.length > 0 && <span className="t-num">{b.guides.length} 列</span>}
                  </div>
                </button>
                {confirm === b.id ? (
                  <span className="flex flex-none items-center gap-1.5">
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        setBoards(boards.filter((x) => x.id !== b.id))
                        setConfirm(null)
                      }}
                    >
                      删掉这张
                    </button>
                    <button type="button" className="btn btn-plain" onClick={() => setConfirm(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-plain flex-none"
                    onClick={() => setConfirm(b.id)}
                    title="删掉这张时间线（事件本身不动）"
                    style={{ padding: 4 }}
                  >
                    <Trash size={12} />
                  </button>
                )}
              </div>
            )
          })}

          {boards.length === 0 && (
            <div
              className="px-4 py-8 text-center text-[12px] leading-relaxed"
              style={{ color: 'var(--color-ink-soft)' }}
            >
              还没有时间线。点右上角「新建时间线」，然后从左边把事件拖进去 ——
              它会按发生时间自己排好。
            </div>
          )}
        </div>

        <div className="mt-8 pt-4" style={{ borderTop: '1px solid var(--color-line-soft)' }}>
          <div className="t-micro mb-2">不用摆的</div>
          <button type="button" className="btn btn-ghost" onClick={onOpenDerived}>
            <CalendarBlank size={12} />
            全部事件：自动排好的事件轴 / 轨道 / 在场
          </button>
          <p
            className="mt-2 text-[11.5px] leading-relaxed"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            这三种是算出来的：所有带时间的事件按先后铺开，不用你摆。
            要「挑一部分、摆成一张图」的时候，用上面那些时间线。
          </p>
        </div>
      </div>
    </div>
  )
}
