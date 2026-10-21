/* ============================================================
   左侧导轨：搜索 + 按类型分组的实体列表
   
   它是「持续在场的索引」。无论你在图谱、时间线还是地图，
   这一栏都让你能立刻跳到任何条目，不用先切回设定视图。
   ============================================================ */

import { useMemo } from 'react'
import { MagnifyingGlass, Plus, SidebarSimple, X } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { ENTITY_META, ENTITY_TYPES, type EntityType } from '../lib/types'
import { entitiesOfType } from '../lib/index-builder'
import { TypeDot } from './ui'
import { cx } from '../lib/util'

export function Rail() {
  const novel = useStore((s) => s.novel)
  const index = useStore((s) => s.index)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const addEntity = useStore((s) => s.addEntity)
  const query = useStore((s) => s.searchQuery)
  const setSearch = useStore((s) => s.setSearch)
  const collapsed = useStore((s) => s.railCollapsed)
  const toggleRail = useStore((s) => s.toggleRail)

  const grouped = useMemo(() => {
    if (!novel) return [] as Array<{ type: EntityType; items: ReturnType<typeof entitiesOfType> }>
    if (query.trim() && index) {
      // 搜索时跨类型平铺，因为此时作者关心的是「那个东西在哪」而不是分类
      return [{ type: 'character' as EntityType, items: index.search(query) }]
    }
    return ENTITY_TYPES.map((t) => ({ type: t, items: entitiesOfType(novel, t) })).filter(
      (g) => g.items.length > 0,
    )
  }, [novel, index, query])

  if (!novel) return null

  if (collapsed) {
    return (
      <div
        className="flex-none flex flex-col items-center gap-2 py-3"
        style={{
          width: 44,
          borderRight: '1px solid var(--color-line)',
          background: 'var(--color-surface)',
        }}
      >
        <button
          type="button"
          className="btn btn-plain"
          onClick={toggleRail}
          title="展开列表"
        >
          <SidebarSimple size={16} />
        </button>
        <div
          style={{ width: 18, height: 1, background: 'var(--color-line)' }}
          aria-hidden
        />
        {ENTITY_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className="btn btn-plain"
            title={ENTITY_META[t].label}
            onClick={() => toggleRail()}
          >
            <TypeDot type={t} size={8} />
          </button>
        ))}
      </div>
    )
  }

  const searching = query.trim().length > 0
  const totalShown = grouped.reduce((n, g) => n + g.items.length, 0)

  return (
    <aside
      className="flex-none flex flex-col min-h-0"
      style={{
        width: 252,
        borderRight: '1px solid var(--color-line)',
        background: 'var(--color-surface)',
      }}
    >
      {/* 搜索 + 收起按钮。
          收起按钮放在这里（上方），和收起态那个「展开」按钮同一个位置 ——
          以前它在底部的状态条里，于是「展开在上、收起在下」，
          点的时候手要跑到另一头去。 */}
      <div className="flex flex-none items-center gap-1.5 px-3 pt-3 pb-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
            style={{ color: 'var(--color-ink-faint)' }}
          />
          <input
            className="input"
            style={{ paddingLeft: 28, paddingRight: query ? 26 : 10 }}
            placeholder="搜索名字、标签"
            value={query}
            onChange={(e) => setSearch(e.target.value)}
          />
          {query && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 hover:bg-[var(--color-surface-3)]"
              style={{ color: 'var(--color-ink-faint)' }}
              title="清除"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn btn-plain flex-none"
          onClick={toggleRail}
          title="收起列表"
        >
          <SidebarSimple size={14} />
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {searching && (
          <div className="px-1.5 pt-1 pb-2">
            <span className="t-micro">
              {totalShown > 0 ? `${totalShown} 条匹配` : '没有匹配'}
            </span>
          </div>
        )}

        {totalShown === 0 && searching && (
          <div
            className="px-2 py-6 text-center text-[12px] leading-relaxed"
            style={{ color: 'var(--color-ink-soft)' }}
          >
            没有找到相关条目。
            <br />
            换个词试试，或者直接新建一个。
          </div>
        )}

        {grouped.map((g) => (
          <div key={g.type} className="mb-3">
            {!searching && (
              <div className="flex items-center gap-1.5 px-1.5 py-1.5">
                <TypeDot type={g.type} />
                <span
                  className="text-[11px] font-medium"
                  style={{ color: 'var(--color-ink-soft)' }}
                >
                  {ENTITY_META[g.type].plural}
                </span>
                <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
                  {g.items.length}
                </span>
              </div>
            )}

            <ul className="flex flex-col gap-px">
              {g.items.map((e) => {
                const active = selectedId === e.id
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => select(e.id)}
                      className={cx(
                        'group/row flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-[5px] text-left transition-colors',
                      )}
                      style={{
                        background: active ? 'var(--color-surface-3)' : 'transparent',
                        color: active ? 'var(--color-ink)' : 'var(--color-ink-mid)',
                      }}
                      onMouseEnter={(ev) => {
                        if (!active)
                          ev.currentTarget.style.background =
                            'color-mix(in oklab, var(--color-surface-2) 70%, transparent)'
                      }}
                      onMouseLeave={(ev) => {
                        if (!active) ev.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <TypeDot type={e.type} size={6} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">
                        {e.name}
                      </span>
                      {/* 链接数：让作者一眼看出哪些条目还是孤岛 */}
                      {e.links.length > 0 && (
                        <span
                          className="t-num flex-none"
                          style={{ color: 'var(--color-ink-faint)' }}
                        >
                          {e.links.length}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        {totalShown === 0 && !searching && (
          <div
            className="px-2 py-8 text-center text-[12px] leading-relaxed"
            style={{ color: 'var(--color-ink-soft)' }}
          >
            这个世界观还是空的。
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {(['character', 'location', 'event'] as EntityType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => addEntity(t)}
                >
                  <Plus size={11} />
                  {ENTITY_META[t].label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部只留条目总数。收起按钮已经挪到上面去了 ——
          上下两个位置放同一个开关，手会跑错。 */}
      <div
        className="flex-none px-3 py-2"
        style={{ borderTop: '1px solid var(--color-line)' }}
      >
        <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
          {novel.entities.length} 条
        </span>
      </div>
    </aside>
  )
}
