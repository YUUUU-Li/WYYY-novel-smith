/* ============================================================
   实体编辑器：设定管理的核心交互面
   
   布局：左栏元数据（结构化） + 右栏正文（自由书写）。
   这个分工是刻意的，结构化字段负责「能被程序算」的部分
   （时间线排序、图谱连线、地图定位），正文负责「只有人能读」
   的部分。作者不需要先填表再写作，两边随时可以只写一边。
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import { refreshJumps, wikilinkJump } from '../lib/cm-jump'
import { Plus, Trash, X } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { ENTITY_META, ENTITY_TYPES, type Entity, type EntityLink, type NovelDate, type Project } from '../lib/types'
import { placeOptions, refForText, resolvePlace } from '../lib/places'
import { ROOT, containersOf } from '../lib/org'
import { countWords, cx } from '../lib/util'
import { TypeDot, SectionLabel, ConfirmButton } from './ui'
import { CalendarPicker } from './CalendarPicker'
import { formatDate, hasEraPicker, isCommonEra } from '../lib/dates'

export function EntityEditor({ entityId }: { entityId: string }) {
  const novel = useStore((s) => s.novel)
  const index = useStore((s) => s.index)
  const updateEntity = useStore((s) => s.updateEntity)
  const select = useStore((s) => s.select)

  const entity = novel?.entities.find((e) => e.id === entityId)
  const [showFields, setShowFields] = useState(true)

  /* 正文容器的实测高度。CodeMirror 只认确定的像素高度，
     所以这里量出来再传给它 —— 见正文区那里的注释。 */
  const bodyBoxRef = useRef<HTMLDivElement | null>(null)
  const [bodyBoxH, setBodyBoxH] = useState(0)

  /* ---------------- 正文里的 [[双括号跳转] ----------------
     索引每次编辑都会重建对象，所以扩展不能依赖它 ——
     否则每敲一个字都要重配一次 CodeMirror。这里用 ref 兜住，
     扩展只建一次，resolve 永远读到最新的 index。 */
  const indexRef = useRef(index)
  indexRef.current = index
  const cmRef = useRef<EditorView | null>(null)

  const jumpExtensions = useMemo(
    () =>
      wikilinkJump({
        resolve: (name) => {
          const idx = indexRef.current
          if (!idx) return null
          const lower = name.toLowerCase()
          for (const e of idx.byId.values()) {
            if (e.name.toLowerCase() === lower) return e.id
          }
          return null
        },
        // 从 store 直接取，避免闭包捕获旧的 select
        onJump: (id) => useStore.getState().select(id),
      }),
    [],
  )

  const cmExtensions = useMemo(
    () => [markdown(), EditorView.lineWrapping, ...jumpExtensions],
    [jumpExtensions],
  )

  /* 索引变了（比如刚新建了被指向的条目）就让装饰重算：
     一个灰虚线待办应该立刻变成朱砂链接，不用等你再敲一个字。 */
  useEffect(() => {
    cmRef.current?.dispatch({ effects: refreshJumps.of(null) })
  }, [index])

  useEffect(() => {
    const el = bodyBoxRef.current
    if (!el) return
    const apply = () => setBodyBoxH(Math.max(0, Math.round(el.clientHeight)))
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [entityId])

  if (!novel || !index || !entity) return null

  const meta = ENTITY_META[entity.type]
  const patch = (p: Partial<Entity>) => updateEntity(entity.id, p)

  const fieldSchema = novel.project.fieldSchemas[entity.type] ?? []

  return (
    <div className="flex h-full min-h-0">
      {/* ---------------- 左栏：结构化元数据 ---------------- */}
      <div
        className="flex-none min-h-0 overflow-y-auto px-5 py-5"
        style={{ width: 320, borderRight: '1px solid var(--color-line)' }}
      >
        {/* 身份 */}
        <div className="flex items-start gap-2.5">
          <span
            className="mt-1 flex-none"
            aria-hidden
          >
            <TypeDot type={entity.type} size={10} />
          </span>
          <div className="min-w-0 flex-1">
            <input
              className="w-full bg-transparent p-0 text-[19px] font-semibold outline-none"
              style={{ color: 'var(--color-ink)' }}
              value={entity.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="名称"
            />
          </div>
        </div>

        {/* 类型切换 */}
        <div className="mt-4">
          <SectionLabel>类型</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {ENTITY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => patch({ type: t })}
                className={cx('btn', entity.type === t ? 'btn-ghost' : 'btn-plain')}
                style={
                  entity.type === t
                    ? {
                        color: `var(${ENTITY_META[t].cssVar})`,
                        borderColor: `color-mix(in oklab, var(${ENTITY_META[t].cssVar}) 40%, transparent)`,
                      }
                    : undefined
                }
              >
                <TypeDot type={t} size={6} />
                {ENTITY_META[t].label}
              </button>
            ))}
          </div>
        </div>

        {/* 一句话摘要 */}
        <div className="mt-5">
          <SectionLabel>一句话</SectionLabel>
          <textarea
            className="input resize-none"
            rows={3}
            value={entity.summary ?? ''}
            placeholder="用一句话说清这个条目是什么。图谱和列表里会用到它。别名、别称也可以写在这里。"
            onChange={(e) => patch({ summary: e.target.value })}
          />
        </div>

        {/* 摆放：这个条目在哪些词条夹里露头。
            「齐国伐宋」既是齐国的事也是宋国的事 —— 放两份位置，数据只有一份。 */}
        <div className="mt-5">
          <SectionLabel>摆放</SectionLabel>
          <PlacementPicker entityId={entity.id} />
        </div>

        {/* 标签 */}
        <div className="mt-5">
          <SectionLabel>标签</SectionLabel>
          <TokenInput
            values={entity.tags}
            placeholder="回车添加，如：主角"
            onChange={(tags) => patch({ tags })}
          />
          {/* 已有标签一键复用，避免同义标签泛滥 */}
          <ExistingTags
            current={entity.tags}
            onPick={(t) => patch({ tags: [...entity.tags, t] })}
          />
        </div>

        {/* 时间与地点 */}
        <div className="mt-5">
          <SectionLabel>世界内时间</SectionLabel>
          <DateInput
            value={entity.date}
            calendarName={novel.project.calendar.name}
            onChange={(date) => patch({ date })}
          />
          {entity.type === 'event' && (
            <div className="mt-2">
              <label className="field-label">结束时间（可选，用于画出跨度）</label>
              <DateInput
                value={entity.dateEnd}
                calendarName={novel.project.calendar.name}
                onChange={(dateEnd) => patch({ dateEnd })}
              />
            </div>
          )}

          {/* 纪时方法是「世界内时间」的下一层，不是和它并列的条目 ——
              它决定上面那些字段怎么被理解，所以贴在时间字段里面。 */}
          <CalendarPicker />
        </div>

        {/* 发生地点：只有事件用。角色的「所在地点」这一栏已经删掉了 ——
            角色的位置由「参与了哪个事件」推出来，不用单独维护。 */}
        {entity.type === 'event' && (
          <div className="mt-4">
            <SectionLabel>发生地点</SectionLabel>
            <PlacePicker value={entity.at} onChange={(at) => patch({ at })} />
          </div>
        )}

        {/* 参与角色：只有事件用。
            在场上矩阵、时间线的人物图标、手绘图谱的连线都吃这一条。
            以前只能绕到「关系」里手打一个「参与」关系类型，没人找得到。 */}
        {entity.type === 'event' && (
          <div className="mt-4">
            <SectionLabel>参与角色</SectionLabel>
            <CastPicker entity={entity} onChange={(links) => patch({ links })} />
          </div>
        )}

        {/* 自定义字段 */}
        {fieldSchema.length > 0 && (
          <div className="mt-5">
            <SectionLabel
              right={
                <button
                  type="button"
                  className="btn btn-plain"
                  onClick={() => setShowFields((v) => !v)}
                >
                  {showFields ? '收起' : '展开'}
                </button>
              }
            >
              {meta.label}字段
            </SectionLabel>
            {showFields && (
              <div className="flex flex-col gap-3">
                {fieldSchema.map((f) => (
                  <div key={f.key}>
                    <label className="field-label">{f.label}</label>
                    <textarea
                      className="input resize-none"
                      rows={2}
                      value={entity.fields?.[f.key] ?? ''}
                      onChange={(e) =>
                        patch({ fields: { ...entity.fields, [f.key]: e.target.value } })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 危险区 */}
        <div
          className="mt-7 flex items-center justify-between pt-4"
          style={{ borderTop: '1px solid var(--color-line-soft)' }}
        >
          <span className="t-micro">操作</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn-plain"
              onClick={() => select(null)}
            >
              关闭
            </button>
            <DeleteEntity id={entity.id} name={entity.name} />
          </div>
        </div>
      </div>

      {/* ---------------- 右栏：正文 ----------------
          关系那一块先拿掉了：它把「指向别人 / 被别人指向」两串清单摆在
          正文上面，占掉半屏，而真正每天都在用的是正文。
          关系仍然存在（手绘图谱连线、事件里的参与角色都会写它），
          只是不再从条目页里手动编辑。 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 正文 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex-none flex items-center justify-between px-6 py-2.5"
            style={{ borderBottom: '1px solid var(--color-line-soft)' }}
          >
            <div className="flex items-center gap-3">
              <span className="t-micro">正文</span>
              <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                {countWords(entity.body)} 字
                          </span>
            </div>
            <span
              className="text-[11px]"
              style={{ color: 'var(--color-ink-faint)' }}
            >
              写 <span className="t-num">[[名字]]</span> 可以跳到别的条目
            </span>
          </div>
          {/* 正文编辑器撑满剩余空间。
              这里不用 height="100%"：实测下来百分比高度穿不过
              CodeMirror 的主题系统，编辑器会收缩到内容高度，
              滚动条永远不出现。改成实测容器像素高度再传下去 ——
              那会变成行内样式，优先级最高，不受任何主题覆盖。 */}
          <div ref={bodyBoxRef} className="ns-editor relative min-h-0 flex-1">
            {bodyBoxH > 0 && (
              <CodeMirror
                key={entity.id}
                value={entity.body}
                height={`${bodyBoxH}px`}
                extensions={cmExtensions}
                onCreateEditor={(view) => {
                  cmRef.current = view
                }}
                onChange={(v) => patch({ body: v })}
                placeholder="外貌、能力、来历、秘密……想到什么写什么。"
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                  bracketMatching: false,
                  autocompletion: false,
                  searchKeymap: false,
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   子零件
    ============================================================ */


function DeleteEntity({ id, name }: { id: string; name: string }) {
  const deleteEntity = useStore((s) => s.deleteEntity)
  return (
    <ConfirmButton
      confirmLabel={`删除「${name}」？`}
      onConfirm={() => deleteEntity(id)}
    >
      <Trash size={12} />
      删除
    </ConfirmButton>
  )
}

/** 标签输入：回车确认，退格删除最后一个 */
function TokenInput({
  values,
  placeholder,
  onChange,
}: {
  values: string[]
  placeholder?: string
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span
          key={v}
          className="chip"
          style={{
            color: 'var(--color-ink-mid)',
            borderColor: 'var(--color-line)',
            background: 'var(--color-surface-2)',
          }}
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            style={{ color: 'var(--color-ink-faint)' }}
            title="移除"
          >
            <X size={9} />
          </button>
        </span>
      ))}
      <input
        className="input"
        style={{ width: 110, flex: '1 0 90px' }}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

function ExistingTags({
  current,
  onPick,
}: {
  current: string[]
  onPick: (t: string) => void
}) {
  const novel = useStore((s) => s.novel)
  const all = useMemo(() => {
    const set = new Set<string>()
    for (const e of novel?.entities ?? []) for (const t of e.tags) set.add(t)
    return Array.from(set).filter((t) => !current.includes(t)).slice(0, 8)
  }, [novel, current])

  if (all.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="t-micro" style={{ fontSize: 10 }}>
        已有
      </span>
      {all.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onPick(t)}
          className="chip"
          style={{
            color: 'var(--color-ink-faint)',
            borderColor: 'var(--color-line-soft)',
            background: 'transparent',
          }}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

/**
 * 世界内日期输入。
 *
 * 用独立输入而不是原生日期控件：世界内的历法是虚构的或历史性的，
 * 原生日期控件在这里毫无意义。
 *
 * 「纪元」这一栏是否出现，取决于当前历法的纪时方法：
 *  · 虚构年号 / 王号纪年 → 需要选纪元
 *  · 公元纪年（公元前 287 年）→ 不需要，符号由年份负责
 */
function DateInput({
  value,
  calendarName,
  onChange,
}: {
  value?: NovelDate
  calendarName: string
  onChange: (v?: NovelDate) => void
}) {
  const novel = useStore((s) => s.novel)
  const cal = novel?.project.calendar
  const showEra = cal ? hasEraPicker(cal) : false
  const commonEra = cal ? isCommonEra(cal) : false

  if (!value) {
    return (
      <button
        type="button"
        className="btn btn-ghost w-full justify-center"
        onClick={() =>
          onChange({
            era: showEra ? cal?.eras[0]?.name : undefined,
            year: commonEra ? 1 : 1,
            monthIndex: 0,
            day: 1,
          })
        }
      >
        <Plus size={12} />
        设定时间
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {/* 纪元：只在需要时出现 */}
        {showEra && (
          <select
            className="input"
            style={{ flex: '0 0 92px' }}
            value={value.era ?? ''}
            onChange={(e) => onChange({ ...value, era: e.target.value || undefined })}
          >
            <option value="">无纪元</option>
            {cal?.eras.map((era) => (
              <option key={era.name} value={era.name}>
                {era.name}
              </option>
            ))}
          </select>
        )}
        <input
          className="input t-num"
          style={{ flex: '0 0 74px' }}
          type="number"
          value={value.year}
          onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}
          title={commonEra ? '年份。公元前请填负数（如 -287）' : '年'}
          placeholder={commonEra ? '如 -287' : '年'}
        />
        <select
          className="input"
          style={{ flex: '1 1 auto' }}
          value={value.monthIndex ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              monthIndex: e.target.value === '' ? undefined : Number(e.target.value),
              month: undefined,
            })
          }
          title="不知道是几月就留「未知」"
        >
          {/* 「月份」读起来像标签，不像一个可选项；而且不选它的时候
              真实含义是「不知道」。 */}
          <option value="">未知</option>
          {cal?.months.map((m, i) => (
            <option key={m.name} value={i}>
              {m.name}
            </option>
          ))}
        </select>
        <input
          className="input t-num"
          style={{ flex: '0 0 56px' }}
          type="number"
          value={value.day ?? ''}
          placeholder="日"
          onChange={(e) =>
            onChange({ ...value, day: e.target.value === '' ? undefined : Number(e.target.value) })
          }
        />
        <button
          type="button"
          className="btn btn-plain flex-none"
          onClick={() => onChange(undefined)}
          title="清除时间"
        >
          <X size={12} />
        </button>
      </div>
      {/* 显示成什么样 + 一句话说明当前纪时方法。
          让作者在这里就能确认「我填的是公元前还是虚构年号」。 */}
      <div
        className="flex items-center justify-between gap-2 text-[10.5px]"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        <span>历法：{calendarName}</span>
        <span className="t-num" title={commonEra ? '公元前请填负数' : undefined}>
          {cal ? formatDate(value, cal) : ''}
        </span>
      </div>
    </div>
  )
}

/* ============================================================
   摆放：这个条目在哪些词条夹里露头

   为什么不是「克隆出一份新的」：克隆就意味着两份数据，两份就会不同步 ——
   改了一边另一边还是旧的，搜索和图谱里还会冒出两个同名条目。
   作者真正想要的是「同一件事，在两个夹子里都看得见」，那正好就是数据结构
   本来就支持的：entries 里存的是 id，同一个 id 可以出现在好几个容器的清单里。
   内容只有一份，所以「永远同步」不是一个功能，而是没有第二份可以不同步。
   ============================================================ */

function PlacementPicker({ entityId }: { entityId: string }) {
  const novel = useStore((s) => s.novel)
  const project = novel?.project
  const placeOrgItem = useStore((s) => s.placeOrgItem)
  const unplaceOrgItem = useStore((s) => s.unplaceOrgItem)
  const [open, setOpen] = useState(false)

  if (!project) return null

  const here = containersOf(project, entityId)
  const nameOf = (id: string) =>
    id === ROOT
      ? '顶层'
      : (project.folders.find((f) => f.id === id)?.name ?? '（已删除的夹子）')

  /* 层级用缩进表示：夹子可能是夹子的子，光看名字分不清两个「人物」 */
  const options: Array<{ id: string; label: string; depth: number }> = [
    { id: ROOT, label: '顶层', depth: 0 },
  ]
  const walk = (container: string, depth: number) => {
    for (const f of project.folders) {
      if (!rawItemsOf(project, container).includes(f.id)) continue
      options.push({ id: f.id, label: f.name, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(ROOT, 1)

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="input flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
          title="同一个条目可以摆在好几个夹子里；内容只有一份"
        >
          <span className="min-w-0 flex-1 truncate">
            {here.length === 0 ? (
              <span style={{ color: 'var(--color-ink-faint)' }}>还没归到任何夹子里</span>
            ) : (
              here.map(nameOf).join('、')
            )}
          </span>
          <span className="t-micro flex-none">
            {here.length > 1 ? `${here.length} 处` : open ? '收起' : '再放一份'}
          </span>
        </button>
      </div>

      {open && (
        <div
          className="mt-1.5 flex max-h-[190px] flex-col overflow-y-auto"
          style={{
            border: '1px solid var(--color-line)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface)',
          }}
        >
          {options.map((o) => {
            const on = here.includes(o.id)
            return (
              <button
                key={o.id}
                type="button"
                data-placement={o.id}
                data-on={on ? 'true' : 'false'}
                aria-pressed={on}
                onClick={() => (on ? unplaceOrgItem(entityId, o.id) : placeOrgItem(entityId, o.id))}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-hover)]"
                style={{ paddingLeft: 10 + o.depth * 12 }}
              >
                <span
                  className="flex-none"
                  style={{ width: 10, color: 'var(--color-accent)' }}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {on && (
                  <span className="t-micro flex-none" style={{ color: 'var(--color-ink-faint)' }}>
                    点一下移走
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function rawItemsOf(project: Project, container: string): string[] {
  return container === ROOT
    ? project.rootItems
    : (project.folders.find((f) => f.id === container)?.items ?? [])
}

/* ============================================================
   参与角色：谁在这场戏里

   写进去的是**一条「参与」关系**（事件 → 角色），不是另一个平行字段 ——
   在场矩阵、时间线、手绘图谱读的都是关系，多一份副本只会有两处会打架。

   「自定义」在这里的含义和发生地点不同：地点可以是一句话，
   人不行 —— 没建过条目的名字在矩阵里没有位置，也没有自己的页面。
   所以没见过的名字会**当场建成角色条目**再连上。
   ============================================================ */

const CAST_TYPE = '参与'

function CastPicker({
  entity,
  onChange,
}: {
  entity: Entity
  onChange: (links: EntityLink[]) => void
}) {
  const novel = useStore((s) => s.novel)
  const select = useStore((s) => s.select)
  const addCast = useStore((s) => s.addCast)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!novel) return null

  /** 已经在这件事里的角色（去重：同一个人连了两条只显示一次） */
  const cast: Entity[] = []
  for (const l of entity.links) {
    if (l.type !== CAST_TYPE) continue
    const target = novel.entities.find((e) => e.id === l.to)
    if (target && target.type === 'character' && !cast.some((c) => c.id === target.id)) {
      cast.push(target)
    }
  }

  const close = () => {
    setOpen(false)
    setTyped('')
  }

  const add = (id: string) => {
    if (entity.links.some((l) => l.to === id && l.type === CAST_TYPE)) return
    onChange([...entity.links, { to: id, type: CAST_TYPE }])
  }

  const remove = (id: string) => {
    onChange(entity.links.filter((l) => !(l.to === id && l.type === CAST_TYPE)))
  }

  const others = novel.entities.filter(
    (e) => e.type === 'character' && !cast.some((c) => c.id === e.id),
  )
  const kw = typed.trim()
  const matched = kw
    ? others.filter((e) => e.name.toLowerCase().includes(kw.toLowerCase()))
    : others
  const exact = kw !== '' && novel.entities.some((e) => e.type === 'character' && e.name === kw)

  return (
    <div>
      {cast.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {cast.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[12px]"
              style={{
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-line)',
                background: 'var(--color-surface)',
              }}
            >
              <button
                type="button"
                className="hover:underline"
                onClick={() => select(c.id)}
                title="打开这个角色"
              >
                {c.name}
              </button>
              <button
                type="button"
                onClick={() => remove(c.id)}
                title="从这场戏里移除"
                style={{ color: 'var(--color-ink-faint)' }}
                className="hover:text-[var(--color-danger)]"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {!open ? (
        <button type="button" className="btn btn-plain" onClick={() => setOpen(true)}>
          <Plus size={11} />
          {cast.length === 0 ? '添加参与角色' : '再加一个'}
        </button>
      ) : (
        <div>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              className="input min-w-0 flex-1"
              value={typed}
              placeholder="搜角色；没有就新建一个"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!kw) return
                  if (matched.length === 1) {
                    add(matched[0].id)
                    close()
                  } else if (!exact) {
                    const created = addCast(entity.id, kw)
                    if (created) close()
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                }
              }}
            />
            <button type="button" className="btn btn-plain flex-none" onClick={close}>
              取消
            </button>
          </div>

          <div
            className="mt-1.5 flex max-h-[150px] flex-col overflow-y-auto"
            style={{
              border: '1px solid var(--color-line)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-surface)',
            }}
          >
            {matched.slice(0, 30).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  add(c.id)
                  close()
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-hover)]"
              >
                <TypeDot type="character" size={6} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </button>
            ))}

            {kw !== '' && !exact && (
              <button
                type="button"
                onClick={() => {
                  const created = addCast(entity.id, kw)
                  if (created) close()
                }}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--color-hover)]"
                style={{
                  borderTop: matched.length > 0 ? '1px solid var(--color-line-soft)' : undefined,
                }}
              >
                <Plus size={11} style={{ color: 'var(--color-accent)' }} />
                <span className="min-w-0 flex-1 truncate">
                  新建角色「<span style={{ color: 'var(--color-accent)' }}>{kw}</span>」并加入
                </span>
              </button>
            )}

            {matched.length === 0 && kw === '' && (
              <div
                className="px-2.5 py-3 text-[11.5px] leading-relaxed"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                还没有角色条目，也还没有别人没被安排进来。
                直接在上面写个名字，会当场建成角色。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================================================
   发生地点：既是「选一个」，也是「写一个」

   为什么不用 <select>（这里原来是 select）：一件事件的发生地点有三种
   来源 —— 地点条目、地图上画的区域、以及作者当场写的一句地名。
   select 塞不下第三种，也表达不了「一个都还没有」这种状态 ——
   以前下拉里只剩「未指定」一项，点开什么都没有，看着就像坏了。

   列表就地展开，不做浮层：这一栏在可滚动的编辑器里，浮层会被裁掉，
   而且弹出层和这个界面整体安静的调子也不合。
   ============================================================ */

function PlacePicker({
  value,
  onChange,
}: {
  value?: string
  onChange: (v?: string) => void
}) {
  const novel = useStore((s) => s.novel)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const current = novel ? resolvePlace(novel, value) : null
  const options = useMemo(() => (novel ? placeOptions(novel) : []), [novel])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!novel) return null

  const close = () => {
    setOpen(false)
    setTyped('')
  }

  if (!open) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="input flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(true)}
          title="选一个已有的地点，或者自己写一个"
        >
          {current?.broken ? (
            /* 引用坏了（条目或区域被删掉、文件被手改过）。
               不能装成「未指定」—— 那就等于悄悄丢了一条信息。 */
            <span
              className="min-w-0 flex-1 truncate"
              style={{ color: 'var(--color-warn)' }}
              title={`找不到这个地点：${current.name}`}
            >
              找不到这个地点（{current.name}）
            </span>
          ) : current ? (
            <>
              <span className="min-w-0 flex-1 truncate">{current.name}</span>
              <span className="t-micro flex-none">
                {current.kind === 'entity'
                  ? '地点条目'
                  : current.kind === 'region'
                    ? '地图区域'
                    : '自定义'}
              </span>
            </>
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              style={{ color: 'var(--color-ink-faint)' }}
            >
              未指定 · 点这里选一个，或自己写
            </span>
          )}
        </button>
        {(current || value) && (
          <button
            type="button"
            className="btn btn-plain flex-none"
            onClick={() => onChange(undefined)}
            title="清空发生地点"
          >
            <X size={12} />
          </button>
        )}
      </div>
    )
  }

  const kw = typed.trim()
  const matched = kw
    ? options.filter((o) => o.name.toLowerCase().includes(kw.toLowerCase()))
    : options
  /** 打进去的字已经正好等于某一项（那一项会在列表里，不用再给「自定义」） */
  const exact = kw !== '' && matched.some((o) => o.name === kw)
  const isCurrent = (ref: string) =>
    current !== null && resolvePlace(novel, ref)?.key === current.key

  const pick = (ref: string) => {
    onChange(ref)
    close()
  }

  /* 回车 = 用你打的这行字。正好撞上已有地点名就绑上去（这样之后改条目名、
     或在矩阵里和同一个地方的其它事件算在一起，都还认得出它），否则存成文字。 */
  const commitTyped = () => {
    if (!kw) return
    pick(refForText(novel, kw) ?? kw)
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          className="input min-w-0 flex-1"
          value={typed}
          placeholder="搜地名；没有就自己写一个"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitTyped()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <button type="button" className="btn btn-plain flex-none" onClick={close}>
          取消
        </button>
      </div>

      <div
        className="mt-1.5 flex max-h-[190px] flex-col overflow-y-auto"
        style={{
          border: '1px solid var(--color-line)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface)',
        }}
      >
        {(['地点条目', '地图区域'] as const).map((group) => {
          const list = matched.filter((o) => o.group === group)
          if (list.length === 0) return null
          return (
            <div key={group}>
              <div className="t-micro px-2.5 pb-1 pt-2" style={{ color: 'var(--color-ink-faint)' }}>
                {group}
              </div>
              {list.map((o) => (
                <button
                  key={o.ref}
                  type="button"
                  onClick={() => pick(o.ref)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-hover)]"
                  style={{ background: isCurrent(o.ref) ? 'var(--color-accent-wash)' : undefined }}
                >
                  <span
                    aria-hidden
                    className="flex-none"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 'var(--radius-xs)',
                      background: o.kind === 'entity' ? 'var(--color-ink-soft)' : 'transparent',
                      border: o.kind === 'entity' ? 'none' : '1px solid var(--color-line-strong)',
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {o.hint && (
                    <span
                      className="t-micro flex-none"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {o.hint}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )
        })}

        {kw !== '' && !exact && (
          <button
            type="button"
            onClick={commitTyped}
            className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[12.5px] transition-colors hover:bg-[var(--color-hover)]"
            style={{
              borderTop: matched.length > 0 ? '1px solid var(--color-line-soft)' : undefined,
            }}
          >
            <span className="min-w-0 flex-1 truncate">
              把「<span style={{ color: 'var(--color-accent)' }}>{kw}</span>」当作地名
            </span>
            <span className="t-micro flex-none" style={{ color: 'var(--color-ink-faint)' }}>
              自定义
            </span>
          </button>
        )}

        {matched.length === 0 && kw === '' && (
          <div
            className="px-2.5 py-3 text-[11.5px] leading-relaxed"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            还没有地点条目，也还没在地图上画过区域。直接在上面写一个地名就行 ——
            以后建了条目或画了区域，可以再回来换。
          </div>
        )}
      </div>
    </div>
  )
}
