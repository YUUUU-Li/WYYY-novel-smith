/* ============================================================
   在场矩阵

   行 = 地点，列 = 时间（纪元 + 年），格 = 当时当地有谁。

   这一栏的落点不是「好看」，是发现两类问题：
     · 宿敌在同一座城里待了三年，剧情却从没交代过
     · 两个人同处一地，剧情却从没让他们相遇（错过的戏）

   所以右侧的「同处提示」才是重点，矩阵本身只是证据。
   提示按紧张度排序：敌对最前，然后是完全没关系，最后是有合理关系的。
   ============================================================ */

import { useMemo, useState } from 'react'
import { ArrowRight, UsersThree, WarningCircle } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import {
  buildPresenceGrid,
  summarizeTension,
  type CoPresence,
  type PresenceGrid as Grid,
} from '../lib/presence'
import { Empty, TypeDot } from './ui'
import { cx } from '../lib/util'

/** 提示的视觉语言：敌对用琥珀（要你看），无关系用中性（只是信息） */
const TENSION_STYLE: Record<
  CoPresence['tension'],
  { label: string; color: string; tint: string }
> = {
  hostile: {
    label: '关系冲突',
    color: 'var(--color-warn)',
    tint: 'color-mix(in oklab, var(--color-warn) 9%, transparent)',
  },
  none: {
    label: '从未相遇',
    color: 'var(--color-ink-soft)',
    tint: 'color-mix(in oklab, var(--color-surface-2) 70%, transparent)',
  },
  other: {
    label: '同处合理',
    color: 'var(--color-ink-faint)',
    tint: 'transparent',
  },
}

export function PresenceMatrix() {
  const novel = useStore((s) => s.novel)
  const select = useStore((s) => s.select)
  const [hideOther, setHideOther] = useState(true)

  const grid = useMemo(() => (novel ? buildPresenceGrid(novel) : null), [novel])

  if (!novel || !grid) return null

  const nameOf = (id: string) => grid.characters.find((c) => c.id === id)?.name
    ?? novel.entities.find((e) => e.id === id)?.name
    ?? id

  /* 没有可排的内容时，不要显示一张空表，直接告诉作者缺什么 */
  if (grid.characters.length === 0 || grid.buckets.length === 0 || grid.places.length === 0) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <Empty
          title="还排不出在场矩阵"
          hint="这个视图需要三样东西：角色的「所在地点」、以及时间。地点可以来自角色自己的所在地，也可以来自它参与过的事件。"
        />
        <div className="mx-auto max-w-[520px] px-6 pb-10">
          <div className="t-micro mb-3">还缺什么</div>
          <div className="flex flex-col gap-2.5">
            <Missing
              ok={grid.missingLocation.length === 0}
              text={
                grid.missingLocation.length === 0
                  ? '所有角色都有地点信息'
                  : `${grid.missingLocation.length} 个角色没有地点：${grid.missingLocation
                      .map((c) => c.name)
                      .slice(0, 5)
                      .join('、')}`
              }
            />
            <Missing
              ok={grid.missingTime.length === 0}
              text={
                grid.missingTime.length === 0
                  ? '所有角色都有时间信息'
                  : `${grid.missingTime.length} 个角色没有时间：${grid.missingTime
                      .map((c) => c.name)
                      .slice(0, 5)
                      .join('、')}`
              }
            />
          </div>
        </div>
      </div>
    )
  }

  const visible = hideOther
    ? grid.coPresence.filter((c) => c.tension !== 'other')
    : grid.coPresence

  return (
    <div className="flex h-full min-h-0">
      {/* ---------------- 矩阵 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-none px-5 pt-4 pb-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="t-micro">
              {grid.characters.length} 个角色 · {grid.places.length} 个地点 · {grid.buckets.length} 个时段
            </span>
            <span
              className="text-[11px]"
              style={{ color: 'var(--color-ink-faint)' }}
            >
              纵向是地点，横向是时间（按纪元+年分组）。用来看谁在什么时候、什么地方。
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <table
            className="border-separate"
            style={{ borderSpacing: 0, minWidth: '100%' }}
          >
            <thead>
              <tr>
                {/* 地点列头：横向滚动时钉住 */}
                <th
                  className="sticky left-0 z-20 text-left"
                  style={{
                    background: 'var(--color-base)',
                    borderBottom: '1px solid var(--color-line)',
                    padding: '6px 12px 6px 0',
                    minWidth: 120,
                  }}
                >
                  <span className="t-micro">地点</span>
                </th>
                {grid.buckets.map((b) => (
                  <th
                    key={b.key}
                    title={b.fullLabel}
                    style={{
                      borderBottom: '1px solid var(--color-line)',
                      padding: '6px 4px',
                      minWidth: 54,
                    }}
                  >
                    <span
                      className="t-num"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {b.label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.places.map((loc) => (
                <tr key={loc.key}>
                  <th
                    className="sticky left-0 z-10 text-left align-middle"
                    style={{
                      background: 'var(--color-base)',
                      borderBottom: '1px solid var(--color-line-soft)',
                      padding: '7px 12px 7px 0',
                    }}
                  >
                    {/* 只有真的对应一个地点条目时才点得开；
                        地图区域和自由文字没有自己的页面，别装作有。 */}
                    {loc.entityId ? (
                      <button
                        type="button"
                        onClick={() => select(loc.entityId!)}
                        className="flex items-center gap-2 text-left hover:underline"
                      >
                        <TypeDot type="location" size={7} />
                        <span className="text-[12.5px] whitespace-nowrap">{loc.name}</span>
                      </button>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: 7,
                            height: 7,
                            borderRadius: 'var(--radius-xs)',
                            border: '1px solid var(--color-line-strong)',
                          }}
                        />
                        <span
                          className="text-[12.5px] whitespace-nowrap"
                          title={loc.kind === 'region' ? `地图区域${loc.mapName ? `（${loc.mapName}）` : ''}` : '自己写的发生地点'}
                        >
                          {loc.name}
                        </span>
                      </span>
                    )}
                  </th>
                  {grid.buckets.map((b) => {
                    const cell = grid.cells.find(
                      (c) => c.bucketKey === b.key && c.locationKey === loc.key,
                    )
                    const ids = cell?.characterIds ?? []
                    const tension = tensionOf(grid, loc.key, b.key)
                    return (
                      <td
                        key={b.key}
                        style={{
                          borderBottom: '1px solid var(--color-line-soft)',
                          padding: '5px 4px',
                          textAlign: 'center',
                          background:
                            ids.length > 1 ? TENSION_STYLE[tension].tint : 'transparent',
                        }}
                      >
                        {ids.length === 0 ? (
                          // 空而淡的点：让「这里没人」是可见的信息，而不是一片空白
                          <span
                            aria-hidden
                            style={{
                              display: 'inline-block',
                              width: 4,
                              height: 4,
                              borderRadius: 'var(--radius-xs)',
                              background: 'var(--color-line)',
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => select(ids[0])}
                            title={`${b.fullLabel} · ${loc.name}：${ids
                              .map(nameOf)
                              .join('、')}`}
                            className="inline-flex flex-wrap items-center justify-center gap-[3px]"
                            style={{ maxWidth: 48 }}
                          >
                            {ids.map((id) => {
                              const ch = novel.entities.find((e) => e.id === id)
                              if (!ch) return null
                              return (
                                <span
                                  key={id}
                                  style={{
                                    width: 9,
                                    height: 9,
                                    borderRadius: 'var(--radius-xs)',
                                    background: `var(${
                                      ch.type === 'character'
                                        ? '--color-e-character'
                                        : '--color-e-item'
                                    })`,
                                    border:
                                      ids.length > 1 && tension === 'hostile'
                                        ? '1.5px solid var(--color-warn)'
                                        : '1.5px solid var(--color-base)',
                                  }}
                                />
                              )
                            })}
                          </button>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- 同处提示 ---------------- */}
      <aside
        className="flex-none min-h-0 overflow-y-auto px-4 py-4"
        style={{ width: 300, borderLeft: '1px solid var(--color-line)' }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UsersThree size={12} style={{ color: 'var(--color-ink-faint)' }} />
            <span className="t-micro">同处提示 · {visible.length}</span>
          </div>
          <button
            type="button"
            className={cx('btn', hideOther ? 'btn-ghost' : 'btn-plain')}
            style={hideOther ? { color: 'var(--color-accent)' } : undefined}
            aria-pressed={hideOther}
            onClick={() => setHideOther((v) => !v)}
            title="隐藏那些关系上本来就该同处的情况"
          >
            只看值得看
          </button>
        </div>

        {visible.length === 0 ? (
          <p
            className="mt-3 text-[11.5px] leading-relaxed"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            {grid.coPresence.length === 0
              ? '没有两个角色被安排在同一时间同一地点。要么他们的时间线还没填全，要么他们确实各在各处。'
              : `${grid.coPresence.length} 组同处都符合已有的关系设定，没有需要检查的。`}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2.5">
            {visible.map((cp) => {
              const style = TENSION_STYLE[cp.tension]
              return (
                <div
                  key={`${cp.bucketKey}-${cp.locationKey}`}
                  className="rounded-[var(--radius-md)] px-3 py-2.5"
                  style={{
                    background: style.tint,
                    border: `1px solid ${
                      cp.tension === 'hostile'
                        ? 'color-mix(in oklab, var(--color-warn) 28%, transparent)'
                        : 'var(--color-line-soft)'
                    }`,
                  }}
                >
                  <div className="flex items-center gap-2">
                    {cp.tension === 'hostile' && (
                      <WarningCircle
                        size={12}
                        className="flex-none"
                        style={{ color: style.color }}
                      />
                    )}
                    <span
                      className="text-[11px] font-medium"
                      style={{ color: style.color }}
                    >
                      {style.label}
                    </span>
                    <span
                      className="t-num flex-1 text-right"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {cp.bucketLabel}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => select(cp.characterIds[0])}
                    className="mt-1.5 flex items-center gap-1.5 text-left"
                  >
                    <span className="text-[12.5px]">
                      {cp.characterIds.map((id) => nameOf(id)).join('、')}
                    </span>
                    <ArrowRight
                      size={11}
                      style={{ color: 'var(--color-ink-faint)' }}
                    />
                  </button>

                  <div
                    className="mt-0.5 text-[11px]"
                    style={{ color: 'var(--color-ink-soft)' }}
                  >
                    同在{' '}
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() =>
                        select(
                          novel.entities.find((e) => e.name === cp.locationName)?.id ?? '',
                        )
                      }
                    >
                      {cp.locationName}
                    </button>
                    {cp.linkTypes.length > 0 && (
                      <span style={{ color: 'var(--color-ink-faint)' }}>
                        {' '}
                        · 已有关系：{cp.linkTypes.join('、')}
                      </span>
                    )}
                    {cp.linkTypes.length === 0 && (
                      <span style={{ color: 'var(--color-ink-faint)' }}>
                        {' '}
                        · 彼此没有任何关系记录
                      </span>
                    )}
                  </div>

                  <div
                    className="mt-1.5 text-[11px] leading-relaxed"
                    style={{ color: 'var(--color-ink-faint)' }}
                  >
                    {cp.tension === 'hostile'
                      ? '他们被安排在了同一时间同一地点，但关系是敌对的。要么这是一场还没写的戏，要么其中一个人的地点填错了。'
                      : '他们同在此时此地，但剧情里从没交代过。这可能是一场被漏掉的好戏。'}
                  </div>
                </div>
              )
            })}

            {/* 用一句话把整组提示说清楚，方便作者直接对照 */}
            {visible.length > 0 && (
              <div
                className="mt-1 pt-3 text-[11px] leading-relaxed"
                style={{
                  borderTop: '1px solid var(--color-line-soft)',
                  color: 'var(--color-ink-faint)',
                }}
              >
                {summarizeTension(visible[0], nameOf)}
              </div>
            )}
          </div>
        )}

        {/* 缺信息的角色也要露出来，否则作者不会去补 */}
        {(grid.missingLocation.length > 0 || grid.missingTime.length > 0) && (
          <div
            className="mt-5 pt-4"
            style={{ borderTop: '1px solid var(--color-line-soft)' }}
          >
            <div className="t-micro mb-2">没进矩阵的角色</div>
            {grid.missingLocation.length > 0 && (
              <p
                className="text-[11px] leading-relaxed"
                style={{ color: 'var(--color-ink-soft)' }}
              >
                <span style={{ color: 'var(--color-ink-faint)' }}>没填地点：</span>
                {grid.missingLocation.map((c) => c.name).join('、')}
              </p>
            )}
            {grid.missingTime.length > 0 && (
              <p
                className="mt-1.5 text-[11px] leading-relaxed"
                style={{ color: 'var(--color-ink-soft)' }}
              >
                <span style={{ color: 'var(--color-ink-faint)' }}>没填时间：</span>
                {grid.missingTime.map((c) => c.name).join('、')}
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}

/** 找出某一格的紧张度；只有一格、或没有同处时返回 other */
function tensionOf(
  grid: Grid,
  locationKey: string,
  bucketKey: string,
): CoPresence['tension'] {
  const hit = grid.coPresence.find(
    (c) => c.locationKey === locationKey && c.bucketKey === bucketKey,
  )
  return hit ? hit.tension : 'other'
}

function Missing({ ok, text }: { ok: boolean; text: string }) {
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
        style={{ color: ok ? 'var(--color-ink-faint)' : 'var(--color-ink-mid)' }}
      >
        {text}
      </span>
    </div>
  )
}
