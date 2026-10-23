/* ============================================================
   概览

   只保留三块，每块都回答一个具体问题：
     · 规模多大        —— 指标
     · 由什么组成      —— 各类型的条目数
     · 有什么要处理    —— 断链、孤立条目、缺时间

   刻意删掉的内容（原先这里还有）：大纲进度条、时间轴起点、
   六个快速跳转按钮、项目构成的比例条。理由：
   · 跳转顶栏已经有了，重复
   · 进度条和时间轴在各自视图里看更有意义，放这里只是装饰
   · 比例条提供的增量信息很少
   ============================================================ */

import { useMemo, useState } from 'react'
import { DownloadSimple, Plus, WarningCircle } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { ENTITY_META, ENTITY_TYPES, type EntityType } from '../lib/types'
import { isolatedEntities, projectStats } from '../lib/index-builder'
import { unresolvedLinks } from '../lib/wiki-links'
import { TypeDot } from '../components/ui'
import { copyText, countWords } from '../lib/util'
import { exportBundle } from '../lib/storage'

export function OverviewView() {
  const novel = useStore((s) => s.novel)
  const index = useStore((s) => s.index)
  const setView = useStore((s) => s.setView)
  const select = useStore((s) => s.select)
  const addEntity = useStore((s) => s.addEntity)
  const updateProject = useStore((s) => s.updateProject)

  const [exported, setExported] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const stats = useMemo(() => (novel ? projectStats(novel) : null), [novel])
  const isolated = useMemo(() => (novel ? isolatedEntities(novel) : []), [novel])
  /* 正文里 [[双括号]] 指向不存在的东西。以前这条检查躲在字典里，
     而且只认自造词 —— 它其实是断链，对所有条目都成立。 */
  const broken = useMemo(() => (novel ? unresolvedLinks(novel) : []), [novel])
  /* 术语表：并入设定之后的「概念」条目。只读、按读音/名字排 */
  const glossary = useMemo(() => {
    if (!novel) return []
    return novel.entities
      .filter((e) => e.type === 'concept')
      .sort(
        (a, b) =>
          (a.fields?.['读音'] ?? a.name).localeCompare(b.fields?.['读音'] ?? b.name, 'zh-Hans-CN'),
      )
  }, [novel])

  if (!novel || !index || !stats) return null

  const bodyWords = novel.entities.reduce((sum, e) => sum + countWords(e.body), 0)

  /* 一本空小说不显示指标表 —— 全是 0 的表格只有压力，没有信息 */
  if (novel.entities.length === 0) {
    return (
      <div className="h-full grid place-items-center px-8">
        <div className="w-full max-w-[420px] anim-fade-up">
          <h2 className="t-title" style={{ fontSize: 19 }}>
            从第一个条目开始
          </h2>
          <p
            className="mt-2 text-[12.5px] leading-relaxed"
            style={{ color: 'var(--color-ink-soft)' }}
          >
            先建几个角色和地点就够了。图谱、时间线、地图会随着你填的内容自己长出来。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {(['character', 'location', 'event'] as EntityType[]).map((t) => (
              <button
                key={t}
                type="button"
                className="btn btn-ghost"
                onClick={() => addEntity(t)}
              >
                <Plus size={12} />
                {ENTITY_META[t].label}
              </button>
            ))}
          </div>

          <div className="mt-10">
            <TitleField
              value={novel.project.title}
              onChange={(title) => updateProject({ title })}
            />
            <div className="mt-4">
              <label className="field-label">一句话</label>
              <textarea
                className="input resize-none"
                rows={2}
                value={novel.project.logline ?? ''}
                placeholder="这本书想讲什么。写给半年后的自己看。"
                onChange={(e) => updateProject({ logline: e.target.value })}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full px-7 py-7" style={{ maxWidth: 880 }}>
        {/* 页头：可编辑的标题与一句话，省掉一个「项目设置」界面 */}
        <div className="anim-fade-up flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <TitleField
              value={novel.project.title}
              onChange={(title) => updateProject({ title })}
            />
            <textarea
              className="input mt-2 resize-none"
              rows={2}
              value={novel.project.logline ?? ''}
              placeholder="一句话：这本书想讲什么"
              onChange={(e) => updateProject({ logline: e.target.value })}
            />
          </div>
          <button
            type="button"
            className="btn btn-plain flex-none"
            onClick={() => void exportBundle(novel).then(setExported)}
            title="导出成纯文本文件"
          >
            <DownloadSimple size={13} />
            导出
          </button>
        </div>

        {exported !== null && (
          <div
            className="mt-2 text-[11.5px]"
            style={{ color: 'var(--color-ok)' }}
          >
            已导出 {exported} 个文件
          </div>
        )}

        {/* 指标 */}
        <div
          className="mt-7 grid grid-cols-2 gap-x-6 gap-y-4 pt-5 md:grid-cols-4"
          style={{ borderTop: '1px solid var(--color-line)' }}
        >
          <Metric value={stats.entities} label="条目" />
          <Metric value={stats.links} label="关系" />
          <Metric value={stats.outlineNodes} label="大纲节点" />
          <Metric value={bodyWords.toLocaleString()} label="设定字数" />
        </div>

        {/* 构成 */}
        <section className="mt-8">
          <div className="t-micro mb-2.5">构成</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {ENTITY_TYPES.map((t) => {
              const n = stats.counts[t] ?? 0
              if (n === 0) return null
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setView('entities')}
                  className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1 py-0.5 transition-colors hover:bg-[var(--color-hover)]"
                >
                  <TypeDot type={t} size={7} />
                  <span className="text-[12.5px]" style={{ color: 'var(--color-ink-mid)' }}>
                    {ENTITY_META[t].plural}
                  </span>
                  <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                    {n}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        {/* 要处理的 */}
        <section className="mt-8">
          <div className="t-micro mb-2.5">要处理的</div>
          <div className="flex flex-col gap-2">
            <Issue
              ok={index.dangling.length === 0}
              text={
                index.dangling.length === 0
                  ? '没有断掉的关系'
                  : `${index.dangling.length} 条关系指向了已删除的条目`
              }
              action={
                index.dangling.length > 0
                  ? { label: '去处理', run: () => setView('entities') }
                  : undefined
              }
            />
            <Issue
              ok={isolated.length === 0}
              text={
                isolated.length === 0
                  ? '每个条目都至少有一条关系'
                  : `${isolated.length} 个条目还没有和任何东西产生关系`
              }
              action={
                isolated.length > 0
                  ? { label: '看是哪些', run: () => select(isolated[0].id) }
                  : undefined
              }
            />
            <Issue
              ok={broken.length === 0}
              text={
                broken.length === 0
                  ? '正文里的 [[双括号]] 都指向真实条目'
                  : `${broken.length} 个 [[双括号]] 指向不存在的条目`
              }
            />
          </div>

          {/* 断链：一处一处列出来，当场就能建成条目（默认建成概念） */}
          {broken.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {broken.slice(0, 12).map((b) => (
                <div key={b.name} className="flex items-center gap-2">
                  <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                    ×{b.count}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    <span className="t-num">[[{b.name}]]</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-plain flex-none"
                    style={{ padding: '1px 6px' }}
                    onClick={() => addEntity('concept', b.name)}
                    title="用这个词建一个条目，链接立刻就能跳了"
                  >
                    建成条目
                  </button>
                </div>
              ))}
              {broken.length > 12 && (
                <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                  还有 {broken.length - 12} 个
                </span>
              )}
            </div>
          )}

          {/* 孤立条目单独列出来，点一下就能跳过去补关系 */}
          {isolated.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {isolated.slice(0, 12).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => select(e.id)}
                  className="chip"
                  style={{
                    color: 'var(--color-ink-soft)',
                    borderColor: 'var(--color-line)',
                    background: 'transparent',
                  }}
                >
                  <TypeDot type={e.type} size={5} />
                  {e.name}
                </button>
              ))}
              {isolated.length > 12 && (
                <span
                  className="t-num self-center"
                  style={{ color: 'var(--color-ink-faint)' }}
                >
                  还有 {isolated.length - 12} 个
                </span>
              )}
            </div>
          )}
        </section>

        {/* 术语表：并入设定之后的「概念」条目。
            只读、按读音排 —— 它是「读者会卡住的那些词」的一张视图，
            不是一个存词的地方。数据只有一份：概念条目。 */}
        {glossary.length > 0 && (
          <section className="mt-8" data-glossary="1">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="t-micro">术语表</span>
              <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                {glossary.length}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                className="btn btn-plain"
                onClick={() => {
                  const text = glossary
                    .map((e) => {
                      const pron = e.fields?.['读音'] ?? ''
                      const gloss = e.fields?.['直译'] ?? ''
                      const def = (e.summary ?? '').trim() || (e.body ?? '').split('\n')[0] || ''
                      const head = `- **${e.name}**${pron ? `（${pron}）` : ''}`
                      return `${head}${gloss ? ` · ${gloss}` : ''}${def ? ` —— ${def}` : ''}`
                    })
                    .join('\n')
                  /* 必须等复制真成功再说「已复制」。
                     以前是无条件置 true：WebView2 里剪贴板被拒时，
                     界面照样显示「已复制」，作者粘出来却是空的。 */
                  void copyText(text).then((done) => {
                    if (!done) return
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1600)
                  })
                }}
                title="把这张表复制成 Markdown（可以直接贴给读者）"
              >
                {copied ? '已复制' : '复制成 Markdown'}
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {glossary.map((e) => {
                const pron = e.fields?.['读音'] ?? ''
                const gloss = e.fields?.['直译'] ?? ''
                return (
                  <button
                    key={e.id}
                    type="button"
                    className="flex items-baseline gap-2 text-left"
                    onClick={() => select(e.id)}
                    title="打开这个词"
                  >
                    <TypeDot type="concept" size={5} />
                    <span className="flex-none text-[12.5px] font-medium">{e.name}</span>
                    {(pron || gloss) && (
                      <span className="t-num flex-none" style={{ color: 'var(--color-ink-faint)' }}>
                        {[pron, gloss].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    {(e.summary ?? '') && (
                      <span
                        className="min-w-0 flex-1 truncate text-[11.5px]"
                        style={{ color: 'var(--color-ink-soft)' }}
                      >
                        {e.summary}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/** 就地可编辑的标题：点上去就能改，不需要单独的「项目设置」界面 */
function TitleField({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <input
      className="w-full bg-transparent p-0 outline-none"
      style={{ fontSize: 24, fontWeight: 600, color: 'var(--color-ink)' }}
      value={value}
      placeholder="未命名"
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="t-num" style={{ fontSize: 20, lineHeight: 1.1 }}>
        {value}
      </div>
      <div className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
        {label}
      </div>
    </div>
  )
}

function Issue({
  ok,
  text,
  action,
}: {
  ok: boolean
  text: string
  action?: { label: string; run: () => void }
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-none" aria-hidden>
        {ok ? (
          <span
            style={{
              display: 'block',
              width: 6,
              height: 6,
              borderRadius: 'var(--radius-xs)',
              background: 'var(--color-ok)',
            }}
          />
        ) : (
          <WarningCircle size={12} style={{ color: 'var(--color-warn)' }} />
        )}
      </span>
      <span
        className="min-w-0 flex-1 text-[12.5px]"
        style={{ color: ok ? 'var(--color-ink-soft)' : 'var(--color-ink)' }}
      >
        {text}
      </span>
      {action && (
        <button type="button" className="btn btn-plain flex-none" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )
}
