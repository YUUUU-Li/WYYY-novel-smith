/* ============================================================
   设定管理

   三层结构：
   - 顶层 / 词条夹内部：一个可拖动的词条板（卡片网格 或 紧凑表格）
   - 进入某个词条夹：多一块「夹子自己的名字与简介」
   - 选中条目：直接变成完整编辑器

   刻意不做「列表 + 详情」的分栏，因为中间再切一栏会把编辑器挤窄，
   而设定正文恰恰是需要横向空间的东西。

   拖动与排序的关系：
   选「按名称 / 关系数 / 时间」时顺序是算出来的，拖动没有意义，
   所以一拖就自动切到「手动」—— 不这么做的话，松手瞬间会被重新排回去，
   看起来像「拖了没用」。
   ============================================================ */

import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  DotsSixVertical,
  FolderPlus,
  ListBullets,
  Plus,
  SquaresFour,
  Trash,
} from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { ENTITY_META, ENTITY_TYPES, type Entity, type EntityType } from '../lib/types'
import {
  ROOT,
  ancestorPath,
  countEntities,
  countOwnEntities,
  resolveContainer,
  type OrgItem,
} from '../lib/org'
import { EntityEditor } from '../components/EntityEditor'
import { SortableBoard } from '../components/SortableBoard'
import { ConfirmButton, Empty, TypeChip } from '../components/ui'
import { cx, countWords } from '../lib/util'
import { formatDateShort } from '../lib/dates'

type SortKey = 'manual' | 'name' | 'links' | 'time'

export function EntitiesView() {
  const novel = useStore((s) => s.novel)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const addEntity = useStore((s) => s.addEntity)
  const addFolder = useStore((s) => s.addFolder)
  const updateFolder = useStore((s) => s.updateFolder)
  const removeFolder = useStore((s) => s.removeFolder)
  const moveOrgItem = useStore((s) => s.moveOrgItem)

  const [filter, setFilter] = useState<EntityType | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('manual')
  const [dense, setDense] = useState(false)
  /** 当前进到哪个词条夹里；ROOT = 顶层 */
  const [container, setContainer] = useState<string>(ROOT)
  /** 拖动中：让面包屑也变成放得进去的目标 */
  const [dragging, setDragging] = useState(false)

  const project = novel?.project

  /* 容器可能被删掉（删夹子后站在里面），退回能站的地方 */
  const safeContainer =
    container !== ROOT && !project?.folders.some((f) => f.id === container) ? ROOT : container

  const items = useMemo(() => {
    if (!novel) return []
    const all = resolveContainer(novel.project, novel, safeContainer)
    const keep = (i: OrgItem) =>
      i.kind === 'folder' || filter === 'all' || i.entity.type === filter

    /* 手动顺序：**原样**用存下来的顺序，一个字都不许重排。
       拖动算出来的落点 index 是相对屏幕上这一列算的，
       界面底下压着的又是同一份数组 —— 只要这里偷偷把夹子提到前面、
       或者换个排法，index 就会落到别人身上，
       表现就是「拖到第 2 位却插进第 3 位」。 */
    if (sort === 'manual') return all.filter(keep)

    // 其它排序是算出来的，把夹子提到前面归类，条目按选定的规则排
    const folders = all.filter((i) => i.kind === 'folder')
    let entities = all.filter((i) => i.kind === 'entity' && keep(i))
    if (sort === 'name') {
      entities = [...entities].sort((a, b) =>
        a.kind === 'entity' && b.kind === 'entity'
          ? a.entity.name.localeCompare(b.entity.name, 'zh-Hans-CN')
          : 0,
      )
    } else if (sort === 'links') {
      entities = [...entities].sort((a, b) =>
        a.kind === 'entity' && b.kind === 'entity'
          ? b.entity.links.length - a.entity.links.length
          : 0,
      )
    } else if (sort === 'time') {
      const v = (e: { date?: { year: number; monthIndex?: number } }) =>
        e.date ? e.date.year * 1000 + (e.date.monthIndex ?? 0) * 32 : Infinity
      entities = [...entities].sort((a, b) =>
        a.kind === 'entity' && b.kind === 'entity' ? v(a.entity) - v(b.entity) : 0,
      )
    }
    return [...folders, ...entities]
  }, [novel, safeContainer, filter, sort])

  /** 当前这一层直接装着的条目 / 词条夹 —— 筛选器与「显示 N 条」数的都是这些 */
  const containerEntities = useMemo(
    () =>
      !novel
        ? []
        : resolveContainer(novel.project, novel, safeContainer)
            .filter((i) => i.kind === 'entity')
            .map((i) => i.entity),
    [novel, safeContainer],
  )
  const containerFolders = items.filter((i) => i.kind === 'folder').length

  if (!novel || !project) return null

  const insideFolder = safeContainer !== ROOT
  const current = insideFolder ? project.folders.find((f) => f.id === safeContainer) : undefined

  /* 选中条目 = 编辑模式 */
  if (selectedId && novel.entities.some((e) => e.id === selectedId)) {
    return (
      <div className="h-full flex flex-col">
        <ListHeader
          entities={containerEntities}
          folders={containerFolders}
          filter={filter}
          setFilter={setFilter}
          sort={sort}
          setSort={setSort}
          dense={dense}
          setDense={setDense}
          current={current}
          onBack={() => select(null)}
          onNewFolder={() => {
            const f = addFolder('新词条夹', safeContainer)
            setContainer(f.id)
          }}
          onNewEntity={() => addEntity(filter === 'all' ? 'character' : filter, undefined, safeContainer)}
          showBack
        />
        <div className="flex-1 min-h-0">
          <EntityEditor entityId={selectedId} />
        </div>
      </div>
    )
  }

  const describe = (item: OrgItem) => {
    if (item.kind === 'folder') {
      const total = countEntities(project, novel, item.id)
      const own = countOwnEntities(project, novel, item.id)
      return {
        sub: '词条夹',
        /* 夹子显示的是继承后的总数。里面还有夹子时把「自己有多少」也写出来，
           否则「为什么是 7 不是 4」这个问题在界面上答不出来。 */
        meta: [total > own ? `${total} 条（自己 ${own}）` : `${total} 条`],
        summary: item.folder.desc,
      }
    }
    const e = item.entity
    const meta: string[] = []
    if (e.date) meta.push(formatDateShort(e.date, project.calendar))
    if (e.links.length > 0) meta.push(`${e.links.length} 边`)
    return {
      sub: ENTITY_META[e.type].label,
      summary: e.summary,
      tags: e.tags,
      meta,
      words: e.body.trim() ? countWords(e.body) : 0,
      colorVar: ENTITY_META[e.type].cssVar,
    }
  }

  return (
    <div className="h-full flex flex-col">
      <ListHeader
        entities={containerEntities}
        folders={containerFolders}
        filter={filter}
        setFilter={setFilter}
        sort={sort}
        setSort={setSort}
        dense={dense}
        setDense={setDense}
        current={current}
        onNewFolder={() => {
          const f = addFolder('新词条夹', safeContainer)
          setContainer(f.id)
        }}
        onNewEntity={() => addEntity(filter === 'all' ? 'character' : filter, undefined, safeContainer)}
      />

      {/* 面包屑。**必须常驻**，不能只在拖动时出现 ——
          它一出现就会把下面的整块列表往下推，而拖动时的落点判定用的是
          「拖动开始那一刻」的位置快照。列表在手指底下自己挪了 30 多像素，
          结果就是红线画错地方、东西落错格。
          高度写死，里面内容再怎么变都不影响下面的布局。 */}
      <div
        className="flex-none flex flex-nowrap items-center gap-1 px-5 text-[12px]"
        style={{
          height: 34,
          overflow: 'hidden',
          borderBottom: '1px solid var(--color-line-soft)',
        }}
      >
        <Crumb
          label="全部"
          active={!insideFolder}
          droppable={dragging && insideFolder}
          dropId={ROOT}
          onClick={() => setContainer(ROOT)}
        />
        {insideFolder &&
          ancestorPath(project, safeContainer).map((id) => (
            <span key={id} className="flex items-center gap-1">
              <span style={{ color: 'var(--color-ink-faint)' }}>/</span>
              <Crumb
                label={project.folders.find((f) => f.id === id)?.name ?? '?'}
                active={false}
                droppable={dragging && id !== safeContainer}
                dropId={id}
                onClick={() => setContainer(id)}
              />
            </span>
          ))}
        {insideFolder && (
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span style={{ color: 'var(--color-ink-faint)' }}>/</span>
            <span style={{ color: 'var(--color-ink)' }}>{current?.name}</span>
          </span>
        )}
        {dragging && insideFolder && (
          <span className="ml-2 whitespace-nowrap" style={{ color: 'var(--color-accent)' }}>
            拖到上面任一级 = 放进那里
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
        {/* 夹子自己的名字与简介。只有进到夹子里才出现 */}
        {current && (
          <div
            className="panel mb-4 p-4"
            style={{ background: 'var(--color-surface-2)' }}
            data-folder-head="1"
          >
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 bg-transparent text-[17px] font-semibold outline-none"
                style={{ color: 'var(--color-ink)' }}
                value={current.name}
                placeholder="词条夹的名字"
                data-no-drag
                onChange={(e) => updateFolder(current.id, { name: e.target.value })}
              />
              <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
                {countEntities(project, novel, current.id)} 条
                {countEntities(project, novel, current.id) >
                  countOwnEntities(project, novel, current.id) && (
                  <>（自己 {countOwnEntities(project, novel, current.id)}）</>
                )}
              </span>
              <ConfirmButton
                confirmLabel="解散这个夹子？里面的东西会留在这一层"
                onConfirm={() => {
                  removeFolder(current.id)
                  setContainer(ROOT)
                }}
              >
                <Trash size={12} />
              </ConfirmButton>
            </div>
            <textarea
              className="input mt-2.5 resize-y"
              style={{ fontSize: 12, minHeight: 46 }}
              rows={2}
              placeholder="这个夹子是干什么的？（剧透、阵营、时间线、待整理……）"
              value={current.desc ?? ''}
              data-no-drag
              onChange={(e) => updateFolder(current.id, { desc: e.target.value })}
            />
          </div>
        )}

        {items.length === 0 ? (
          <Empty
            title={
              insideFolder
                ? '这个夹子还是空的'
                : filter === 'all'
                  ? '这个世界观还没有条目'
                  : `还没有${ENTITY_META[filter as EntityType].label}`
            }
            hint="先建几个角色和地点。之后图谱、时间线、地图都会从这些条目里自己长出来。也可以先建个词条夹，把条目分门别类。"
            action={
              <div className="flex flex-wrap justify-center gap-1.5">
                {(['character', 'location', 'event'] as EntityType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => addEntity(t, undefined, safeContainer)}
                  >
                    <Plus size={12} />
                    新建{ENTITY_META[t].label}
                  </button>
                ))}
              </div>
            }
          />
        ) : (
          <SortableBoard
            containerId={safeContainer}
            items={items}
            dense={dense}
            describe={describe}
            onOpen={(item) => {
              if (item.kind === 'folder') setContainer(item.id)
              else select(item.entity.id)
            }}
            onMove={(id, to, index, visible) => {
              // 算出来的顺序覆盖不了手写顺序，所以一拖就切到手动
              if (sort !== 'manual') setSort('manual')
              // 说明搬的是「当前这一层里的那一份」：同一个条目可能还摆在别的夹子里
              moveOrgItem(id, to, index, visible, safeContainer)
            }}
            onDragChange={setDragging}
          />
        )}
      </div>
    </div>
  )
}

/* ---------------- 面包屑的一级 ---------------- */

function Crumb({
  label,
  active,
  droppable,
  dropId,
  onClick,
}: {
  label: string
  active: boolean
  droppable: boolean
  dropId: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...(droppable ? { 'data-drop-into': dropId } : {})}
      className="btn btn-plain"
      style={{
        padding: '1px 6px',
        color: active ? 'var(--color-ink)' : 'var(--color-ink-soft)',
        ...(droppable
          ? {
              borderColor: 'var(--color-accent)',
              borderStyle: 'dashed',
              color: 'var(--color-accent)',
            }
          : {}),
      }}
    >
      {label}
    </button>
  )
}

/* ---------------- 页头 ---------------- */

function ListHeader({
  entities,
  folders,
  filter,
  setFilter,
  sort,
  setSort,
  dense,
  setDense,
  current,
  onNewFolder,
  onNewEntity,
  onBack,
  showBack,
}: {
  /** 当前这一层**直接**装着的条目。筛选数的是这些，不是整本书 */
  entities: Entity[]
  /** 当前这一层直接装着的词条夹个数（词条夹不算词条，所以分开数） */
  folders: number
  filter: EntityType | 'all'
  setFilter: (f: EntityType | 'all') => void
  sort: SortKey
  setSort: (s: SortKey) => void
  dense: boolean
  setDense: (d: boolean) => void
  current?: { name: string }
  onNewFolder: () => void
  onNewEntity: () => void
  onBack?: () => void
  showBack?: boolean
}) {
  const total = entities.length

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of entities) c[e.type] = (c[e.type] ?? 0) + 1
    return c
  }, [entities])

  /** 类型筛选之后还剩几条 —— 「显示 N 条」数的是它 */
  const shown = filter === 'all' ? total : (counts[filter] ?? 0)

  return (
    <div
      className="flex-none px-5 py-3"
      style={{ borderBottom: '1px solid var(--color-line)' }}
    >
      <div className="flex items-center gap-3">
        {showBack && (
          <button type="button" className="btn btn-plain" onClick={onBack}>
            <ArrowLeft size={12} />
            返回索引
          </button>
        )}

        {/* 类型筛选 */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cx('btn', filter === 'all' ? 'btn-ghost' : 'btn-plain')}
          >
            全部
            <span className="t-num opacity-60">{total}</span>
          </button>
          {ENTITY_TYPES.filter((t) => (counts[t] ?? 0) > 0).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilter(t)}
              className={cx('btn', filter === t ? 'btn-ghost' : 'btn-plain')}
              style={
                filter === t
                  ? {
                      color: `var(${ENTITY_META[t].cssVar})`,
                      borderColor: `color-mix(in oklab, var(${ENTITY_META[t].cssVar}) 38%, transparent)`,
                    }
                  : undefined
              }
            >
              <span
                aria-hidden
                style={{
                  display: 'block',
                  width: 6,
                  height: 6,
                  background: `var(${ENTITY_META[t].cssVar})`,
                }}
              />
              {ENTITY_META[t].plural}
              <span className="t-num opacity-60">{counts[t]}</span>
            </button>
          ))}
        </div>

        <select
          className="input flex-none"
          style={{ width: 110, flex: 'none' }}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          title="排序方式。拖动会自动切到「手动顺序」"
        >
          <option value="manual">手动顺序</option>
          <option value="name">按名称</option>
          <option value="links">按关系数</option>
          <option value="time">按时间</option>
        </select>
        <button
          type="button"
          className="btn btn-plain flex-none"
          onClick={() => setDense(!dense)}
          title={dense ? '切换为卡片视图' : '切换为紧凑列表'}
        >
          {dense ? <SquaresFour size={14} /> : <ListBullets size={14} />}
        </button>

        {/* 右上角：新建词条夹 + 新建条目 */}
        <button type="button" className="btn btn-ghost flex-none" onClick={onNewFolder}>
          <FolderPlus size={13} />
          新建词条夹
        </button>
        <button type="button" className="btn btn-ghost flex-none" onClick={onNewEntity}>
          <Plus size={12} />
          新建词条
        </button>
      </div>

      {!showBack && (
        <div
          className="mt-2 flex items-center gap-1.5 text-[11px]"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          <DotsSixVertical size={11} />
          {current ? `「${current.name}」里 · ` : ''}
          显示 {shown} 条
          {folders > 0 ? `，另有 ${folders} 个词条夹` : ''}
          。按住卡片拖动：拖到两条之间的红线处插入；拖到词条夹上整框变色，松手就收进去。
        </div>
      )}

      {showBack && filter !== 'all' && (
        <div className="mt-2">
          <TypeChip type={filter} count={shown} />
        </div>
      )}
    </div>
  )
}
