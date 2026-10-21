/* ============================================================
   大纲管理：卷 → 章 → 场景

   三件事让这个视图有别于普通的树形列表：
   1. 剧情线筛选。一部小说的主线/支线/感情线是交织的，
      能单独看一条线索的完整走向，是核对节奏最快的方式。
   2. 角色出场统计。一眼看出哪个角色连续五章没出现。
   3. 剧情内时间显示。大纲的时间和大纲的顺序不一致时，
      通常说明结构出了问题，这里会直接暴露出来。
   ============================================================ */

import { useMemo, useState } from 'react'
import {
  CaretDown,
  CaretRight,
  DotsSixVertical,
  Plus,
  Target,
  Trash,
  UsersThree,
} from '@phosphor-icons/react'
import {
  useStore,
  updateOutlineNode,
  removeOutlineNode,
  insertOutlineNode,
  moveOutlineNode,
  newOutlineNode,
} from '../store/useNovel'
import type { OutlineKind, OutlineNode, OutlineStatus } from '../lib/types'
import { Empty, ConfirmButton } from '../components/ui'
import { cx } from '../lib/util'
import { formatDateShort } from '../lib/dates'

const KIND_LABEL: Record<OutlineKind, string> = {
  volume: '卷',
  chapter: '章',
  scene: '场景',
}

const STATUS_META: Record<OutlineStatus, { label: string; color: string }> = {
  idea: { label: '构想', color: 'var(--color-ink-faint)' },
  drafting: { label: '在写', color: 'var(--color-accent)' },
  done: { label: '完成', color: 'var(--color-ok)' },
}

/** 子节点应该是什么级别，由父节点决定，这样作者不用手动选 */
function childKindOf(kind: OutlineKind): OutlineKind | null {
  if (kind === 'volume') return 'chapter'
  if (kind === 'chapter') return 'scene'
  return null
}

export function OutlineView() {
  const novel = useStore((s) => s.novel)
  const setOutline = useStore((s) => s.setOutline)
  const select = useStore((s) => s.select)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [plotline, setPlotline] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const nodes = novel?.outline ?? []

  /* 全部剧情线标签，用于筛选 */
  const plotlines = useMemo(() => {
    const set = new Set<string>()
    const walk = (list: OutlineNode[]) => {
      for (const n of list) {
        for (const p of n.plotlines) set.add(p)
        walk(n.children)
      }
    }
    walk(nodes)
    return Array.from(set)
  }, [nodes])

  /* 统计 */
  const stats = useMemo(() => {
    let chapters = 0
    let scenes = 0
    let target = 0
    const castCount = new Map<string, number>()
    const walk = (list: OutlineNode[]) => {
      for (const n of list) {
        if (n.kind === 'chapter') chapters++
        if (n.kind === 'scene') scenes++
        if (n.kind === 'chapter') target += n.target ?? 0
        for (const c of n.cast) castCount.set(c, (castCount.get(c) ?? 0) + 1)
        walk(n.children)
      }
    }
    walk(nodes)
    return { chapters, scenes, target, castCount }
  }, [nodes])

  if (!novel) return null

  const allExpanded =
    expanded.size === 0 ||
    JSON.stringify(Array.from(expanded).sort()) ===
      JSON.stringify(collectIds(nodes).sort())

  const selectedNode = selected ? findNode(nodes, selected) : null

  /* 拖拽：把 A 移到 B 之前（同级） */
  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return
    // 不允许把节点拖进自己的子树，否则会形成环
    if (collectIds(findNode(nodes, dragId)?.children ?? []).includes(targetId)) return
    const moving = findNode(nodes, dragId)
    if (!moving) return

    // 从原位置摘除
    let next = removeOutlineNode(nodes, dragId)
    // 插到目标之前。若目标是顶层节点，直接插；否则插进目标的父级子列表。
    next = insertBefore(next, targetId, moving)
    setOutline(next)
    setDragId(null)
    setDropTarget(null)
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 主体 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具栏 */}
        <div
          className="flex-none flex flex-wrap items-center gap-2 px-5 py-3"
          style={{ borderBottom: '1px solid var(--color-line)' }}
        >
          <div className="t-micro">大纲</div>
          <div
            style={{ width: 1, height: 16, background: 'var(--color-line)' }}
            aria-hidden
          />
          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {nodes.length} 卷 · {stats.chapters} 章 · {stats.scenes} 场景
          </span>
          {stats.target > 0 && (
            <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
              目标 {stats.target.toLocaleString()} 字
            </span>
          )}

          <div className="flex-1" />

          {/* 剧情线筛选 */}
          {plotlines.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="t-micro" style={{ fontSize: 10 }}>
                剧情线
              </span>
              <button
                type="button"
                className={cx('btn', plotline === null ? 'btn-ghost' : 'btn-plain')}
                onClick={() => setPlotline(null)}
              >
                全部
              </button>
              {plotlines.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={cx('btn', plotline === p ? 'btn-ghost' : 'btn-plain')}
                  style={
                    plotline === p
                      ? { color: 'var(--color-accent)', borderColor: 'var(--color-line-strong)' }
                      : undefined
                  }
                  onClick={() => setPlotline(plotline === p ? null : p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className="btn btn-plain"
            onClick={() =>
              setExpanded(allExpanded ? new Set(['__none__']) : new Set(collectIds(nodes)))
            }
          >
            {allExpanded ? '折叠全部' : '展开全部'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const node = newOutlineNode('volume', `卷${nodes.length + 1}`)
              setOutline([...nodes, node])
              setSelected(node.id)
              setExpanded((s) => new Set(s).add(node.id))
            }}
          >
            <Plus size={12} />
            新建卷
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {nodes.length === 0 ? (
            <Empty
              title="大纲还是空的"
              hint="从「卷」开始搭骨架，再往里填章和场景。每层都可以写一句话梗概，并打上剧情线标签。"
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const node = newOutlineNode('volume', '卷一')
                    setOutline([node])
                    setExpanded(new Set([node.id]))
                    setSelected(node.id)
                  }}
                >
                  <Plus size={12} />
                  建第一卷
                </button>
              }
            />
          ) : (
            <div className="flex flex-col gap-1">
              {nodes.map((n) => (
                <NodeRow
                  key={n.id}
                  node={n}
                  depth={0}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  selected={selected}
                  setSelected={setSelected}
                  plotlineFilter={plotline}
                  dragId={dragId}
                  setDragId={setDragId}
                  dropTarget={dropTarget}
                  setDropTarget={setDropTarget}
                  onDrop={handleDrop}
                  onAddChild={(parent) => {
                    const kind = childKindOf(parent.kind)
                    if (!kind) return
                    const count = parent.children.length + 1
                    const node = newOutlineNode(
                      kind,
                      kind === 'chapter' ? `第${count}章` : `场景 ${count}`,
                    )
                    setOutline(insertOutlineNode(nodes, parent.id, node))
                    setExpanded((s) => new Set(s).add(parent.id))
                    setSelected(node.id)
                  }}
                  onDelete={(id) => {
                    setOutline(removeOutlineNode(nodes, id))
                    if (selected === id) setSelected(null)
                  }}
                  onPatch={(id, patch) => setOutline(updateOutlineNode(nodes, id, patch))}
                  onMove={(id, delta) => setOutline(moveOutlineNode(nodes, id, delta))}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右栏：选中节点的详情 */}
      <div
        className="flex-none min-h-0 overflow-y-auto px-4 py-4"
        style={{ width: 300, borderLeft: '1px solid var(--color-line)' }}
      >
        {!selectedNode ? (
          <div>
            <div className="t-micro mb-2">结构健康检查</div>
            <div className="flex flex-col gap-3">
              <Check
                ok={stats.chapters > 0}
                text={
                  stats.chapters > 0
                    ? `${stats.chapters} 章已分层`
                    : '还没有章。一卷里至少要有一章，否则大纲只有骨架没有肉。'
                }
              />
              <Check
                ok={stats.castCount.size > 0}
                text={
                  stats.castCount.size > 0
                    ? `${stats.castCount.size} 个角色被安排进了大纲`
                    : '还没有任何节点标注出场角色。标了之后才能查谁被冷落。'
                }
              />
              <Check
                ok={plotlines.length > 0}
                text={
                  plotlines.length > 0
                    ? `${plotlines.length} 条剧情线在跟踪中`
                    : '还没有剧情线标签。多线叙事时它能帮你单独看一条线的走向。'
                }
              />
            </div>

            {stats.castCount.size > 0 && (
              <div className="mt-6">
                <div className="t-micro mb-2">角色出场次数</div>
                <div className="flex flex-col gap-1">
                  {Array.from(stats.castCount.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([id, n]) => {
                      const e = novel.entities.find((x) => x.id === id)
                      return (
                        <div key={id} className="flex items-center gap-2 py-0.5">
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left text-[12px] hover:underline"
                            onClick={() => select(id)}
                          >
                            {e?.name ?? '（已删除的条目）'}
                          </button>
                          <span
                            className="t-num"
                            style={{ color: 'var(--color-ink-faint)' }}
                          >
                            {n}
                          </span>
                        </div>
                      )
                    })}
                </div>
                <p
                  className="mt-3 text-[11px] leading-relaxed"
                  style={{ color: 'var(--color-ink-faint)' }}
                >
                  次数明显偏低的角色，通常意味着他需要一场戏，或者需要被合并掉。
                </p>
              </div>
            )}
          </div>
        ) : (
          <NodeDetail
            node={selectedNode}
            novel={novel}
            onPatch={(patch) => setOutline(updateOutlineNode(nodes, selectedNode.id, patch))}
          />
        )}
      </div>
    </div>
  )
}

/* ---------------- 树行 ---------------- */

function NodeRow({
  node,
  depth,
  expanded,
  setExpanded,
  selected,
  setSelected,
  plotlineFilter,
  dragId,
  setDragId,
  dropTarget,
  setDropTarget,
  onDrop,
  onAddChild,
  onDelete,
  onPatch,
  onMove,
}: {
  node: OutlineNode
  depth: number
  expanded: Set<string>
  setExpanded: (fn: (s: Set<string>) => Set<string>) => void
  selected: string | null
  setSelected: (id: string) => void
  plotlineFilter: string | null
  dragId: string | null
  setDragId: (id: string | null) => void
  dropTarget: string | null
  setDropTarget: (id: string | null) => void
  onDrop: (targetId: string) => void
  onAddChild: (parent: OutlineNode) => void
  onDelete: (id: string) => void
  onPatch: (id: string, patch: Partial<OutlineNode>) => void
  onMove: (id: string, delta: number) => void
}) {
  const isOpen = expanded.has(node.id)
  const isSelected = selected === node.id
  const hasChildren = node.children.length > 0
  const dimmed = plotlineFilter !== null && !node.plotlines.includes(plotlineFilter)
  const childKind = childKindOf(node.kind)

  return (
    <div>
      <div
        draggable
        onDragStart={() => setDragId(node.id)}
        onDragEnd={() => {
          setDragId(null)
          setDropTarget(null)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDropTarget(node.id)
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault()
          onDrop(node.id)
        }}
        onClick={() => setSelected(node.id)}
        className="group flex items-start gap-2 rounded-[var(--radius-md)] px-2 py-1.5 transition-colors"
        style={{
          marginLeft: depth * 18,
          background: isSelected ? 'var(--color-surface-2)' : 'transparent',
          opacity: dimmed ? 0.32 : 1,
          borderTop:
            dropTarget === node.id && dragId && dragId !== node.id
              ? '2px solid var(--color-accent)'
              : '2px solid transparent',
          cursor: 'grab',
        }}
      >
        {/* 折叠箭头 */}
        <button
          type="button"
          className="mt-[3px] flex-none"
          style={{ color: 'var(--color-ink-faint)', width: 13 }}
          onClick={(e) => {
            e.stopPropagation()
            if (!hasChildren) return
            setExpanded((s) => {
              const next = new Set(s)
              if (next.has(node.id)) next.delete(node.id)
              else next.add(node.id)
              return next
            })
          }}
          aria-label={isOpen ? '折叠' : '展开'}
        >
          {hasChildren ? (
            isOpen ? (
              <CaretDown size={11} />
            ) : (
              <CaretRight size={11} />
            )
          ) : (
            <DotsSixVertical size={11} />
          )}
        </button>

        {/* 级别标记 */}
        <span
          className="mt-[3px] flex-none rounded-[var(--radius-sm)] px-1 text-[10px]"
          style={{
            color:
              node.kind === 'volume'
                ? 'var(--color-accent)'
                : 'var(--color-ink-faint)',
            border: '1px solid var(--color-line-soft)',
            minWidth: 22,
            textAlign: 'center',
          }}
        >
          {KIND_LABEL[node.kind]}
        </span>

        {/* 标题与梗概 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              style={{
                fontWeight: node.kind === 'volume' ? 600 : 400,
                color: 'var(--color-ink)',
              }}
              value={node.title}
              onChange={(e) => onPatch(node.id, { title: e.target.value })}
              onClick={(e) => e.stopPropagation()}
            />
            <span
              className="t-num flex-none"
              style={{ color: STATUS_META[node.status].color }}
            >
              {STATUS_META[node.status].label}
            </span>
            {node.target ? (
              <span
                className="t-num flex-none"
                style={{ color: 'var(--color-ink-faint)' }}
                title="字数目标"
              >
                <Target size={10} className="inline" /> {node.target}
              </span>
            ) : null}
            {node.date && (
              <span
                className="t-num flex-none"
                style={{ color: 'var(--color-ink-faint)' }}
                title="剧情内时间"
              >
                {formatDateShort(node.date, useStore.getState().novel!.project.calendar)}
              </span>
            )}
          </div>

          {node.summary && (
            <div
              className="mt-0.5 line-clamp-1 text-[11.5px]"
              style={{ color: 'var(--color-ink-soft)' }}
            >
              {node.summary}
            </div>
          )}

          {(node.plotlines.length > 0 || node.cast.length > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {node.plotlines.map((p) => (
                <span
                  key={p}
                  className="chip"
                  style={{
                    color: 'var(--color-accent)',
                    borderColor: 'color-mix(in oklab, var(--color-accent) 30%, transparent)',
                    background: 'transparent',
                  }}
                >
                  {p}
                </span>
              ))}
              {node.cast.length > 0 && (
                <span
                  className="t-num flex items-center gap-0.5"
                  style={{ color: 'var(--color-ink-faint)' }}
                >
                  <UsersThree size={10} />
                  {node.cast.length}
                </span>
              )}
            </div>
          )}
        </div>

        {/* 行内操作 */}
        <div className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            className="btn btn-plain"
            style={{ padding: 3 }}
            title="上移"
            onClick={(e) => {
              e.stopPropagation()
              onMove(node.id, -1)
            }}
          >
            <CaretDown size={10} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button
            type="button"
            className="btn btn-plain"
            style={{ padding: 3 }}
            title="下移"
            onClick={(e) => {
              e.stopPropagation()
              onMove(node.id, 1)
            }}
          >
            <CaretDown size={10} />
          </button>
          {childKind && (
            <button
              type="button"
              className="btn btn-plain"
              style={{ padding: 3 }}
              title={`在此新建${KIND_LABEL[childKind]}`}
              onClick={(e) => {
                e.stopPropagation()
                onAddChild(node)
              }}
            >
              <Plus size={11} />
            </button>
          )}
          <ConfirmButton
            confirmLabel="删除？"
            onConfirm={() => onDelete(node.id)}
          >
            <Trash size={11} />
          </ConfirmButton>
        </div>
      </div>

      {/* 子节点 */}
      {isOpen &&
        node.children.map((c) => (
          <NodeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            setExpanded={setExpanded}
            selected={selected}
            setSelected={setSelected}
            plotlineFilter={plotlineFilter}
            dragId={dragId}
            setDragId={setDragId}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            onDrop={onDrop}
            onAddChild={onAddChild}
            onDelete={onDelete}
            onPatch={onPatch}
            onMove={onMove}
          />
        ))}
    </div>
  )
}

/* ---------------- 节点详情 ---------------- */

function NodeDetail({
  node,
  novel,
  onPatch,
}: {
  node: OutlineNode
  novel: NonNullable<ReturnType<typeof useStore.getState>['novel']>
  onPatch: (patch: Partial<OutlineNode>) => void
}) {
  const characters = novel.entities.filter((e) => e.type === 'character')

  return (
    <div className="anim-fade-up">
      <div className="t-micro mb-2">{KIND_LABEL[node.kind]}详情</div>
      <div className="text-[14px] font-medium">{node.title}</div>

      <div className="mt-4">
        <label className="field-label">梗概</label>
        <textarea
          className="input resize-none"
          rows={4}
          value={node.summary}
          placeholder="这一章发生了什么，用两三句说清。"
          onChange={(e) => onPatch({ summary: e.target.value })}
        />
      </div>

      <div className="mt-4">
        <label className="field-label">状态</label>
        <div className="flex gap-1">
          {(Object.keys(STATUS_META) as OutlineStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              className={cx('btn', node.status === s ? 'btn-ghost' : 'btn-plain')}
              style={
                node.status === s
                  ? { color: STATUS_META[s].color, borderColor: 'var(--color-line-strong)' }
                  : undefined
              }
              onClick={() => onPatch({ status: s })}
            >
              {STATUS_META[s].label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <label className="field-label">字数目标</label>
        <input
          className="input t-num"
          type="number"
          value={node.target ?? ''}
          placeholder="例如 8000"
          onChange={(e) =>
            onPatch({ target: e.target.value ? Number(e.target.value) : undefined })
          }
        />
      </div>

      <div className="mt-4">
        <label className="field-label">剧情线</label>
        <NodePlotlines node={node} onPatch={onPatch} />
      </div>

      <div className="mt-4">
        <label className="field-label">出场角色</label>
        <div className="flex flex-col gap-1">
          {characters.map((c) => {
            const on = node.cast.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-hover)]"
                onClick={() =>
                  onPatch({
                    cast: on ? node.cast.filter((x) => x !== c.id) : [...node.cast, c.id],
                  })
                }
              >
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 'var(--radius-xs)',
                    border: on
                      ? '1px solid var(--color-accent)'
                      : '1px solid var(--color-line-strong)',
                    background: on ? 'var(--color-accent-wash)' : 'transparent',
                    display: 'grid',
                    placeItems: 'center',
                    color: 'var(--color-accent)',
                    fontSize: 9,
                    lineHeight: 1,
                  }}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="text-[12px]">{c.name}</span>
              </button>
            )
          })}
          {characters.length === 0 && (
            <p className="text-[11.5px]" style={{ color: 'var(--color-ink-faint)' }}>
              还没有角色条目。先去设定里建几个。
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function NodePlotlines({
  node,
  onPatch,
}: {
  node: OutlineNode
  onPatch: (patch: Partial<OutlineNode>) => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {node.plotlines.map((p) => (
        <span
          key={p}
          className="chip"
          style={{
            color: 'var(--color-accent)',
            borderColor: 'color-mix(in oklab, var(--color-accent) 30%, transparent)',
            background: 'transparent',
          }}
        >
          {p}
          <button
            type="button"
            onClick={() => onPatch({ plotlines: node.plotlines.filter((x) => x !== p) })}
            style={{ color: 'inherit' }}
            title="移除"
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="input"
        style={{ width: 100 }}
        value={draft}
        placeholder="新剧情线"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            onPatch({ plotlines: [...node.plotlines, draft.trim()] })
            setDraft('')
          }
        }}
      />
    </div>
  )
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-[5px] flex-none"
        style={{
          width: 6,
          height: 6,
          borderRadius: 'var(--radius-xs)',
          background: ok ? 'var(--color-ok)' : 'var(--color-line-strong)',
        }}
        aria-hidden
      />
      <span
        className="text-[11.5px] leading-relaxed"
        style={{ color: ok ? 'var(--color-ink-mid)' : 'var(--color-ink-soft)' }}
      >
        {text}
      </span>
    </div>
  )
}

/* ---------------- 纯函数 ---------------- */

function collectIds(nodes: OutlineNode[]): string[] {
  const out: string[] = []
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      out.push(n.id)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = findNode(n.children, id)
    if (hit) return hit
  }
  return null
}

/** 把节点插到目标节点之前，保持同级 */
function insertBefore(
  nodes: OutlineNode[],
  targetId: string,
  node: OutlineNode,
): OutlineNode[] {
  const idx = nodes.findIndex((n) => n.id === targetId)
  if (idx !== -1) {
    const next = [...nodes]
    next.splice(idx, 0, node)
    return next
  }
  return nodes.map((n) => ({ ...n, children: insertBefore(n.children, targetId, node) }))
}
