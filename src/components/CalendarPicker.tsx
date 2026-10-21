/* ============================================================
   纪时方法选择

   为什么要把这个做成一个可切换的东西：
   同一个故事可以有几种都合理的纪时方法 ——
     ·「公元前 287 年 正月十三」现代读者最好懂
     ·「秦昭襄王二十年」更贴当时人的说法
     ·「天和 421 年 霜月」完全虚构的纪元
   数据形状完全一样，差别只在怎么显示、有哪些可选值。
   所以这本质上是一个「显示规则 + 词表」的切换，不是数据迁移。

   ---------- 切换时对已有时间做了什么 ----------

   这是必须说清楚的地方。切换历法时：
     · 保留年份数字 —— 它是唯一可能仍然有意义的字段
     · 清掉纪元 —— 旧纪元名在新历法里不存在，留着只会显示出怪东西
     · 清掉月份 —— 月名对不上（「霜月」在农历里没有对应）

   代价是已有时间会退化成年份。所以按钮上直说了这一点，
   并且要求二次确认 —— 不能让作者在不知情的情况下被改掉几十条数据。
   ============================================================ */

import { useState } from 'react'
import { ArrowsClockwise, CaretDown, CaretRight, WarningCircle } from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import { CALENDAR_PRESETS } from '../lib/calendars'
import { formatYear } from '../lib/dates'

export function CalendarPicker() {
  const novel = useStore((s) => s.novel)
  const applyCalendar = useStore((s) => s.applyCalendar)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)

  if (!novel) return null
  const cal = novel.project.calendar

  /** 有多少条时间会因为切换而丢掉月份 */
  const datedCount = novel.entities.filter((e) => e.date || e.dateEnd).length

  const doSwitch = (id: string) => {
    const preset = CALENDAR_PRESETS.find((p) => p.id === id)
    if (!preset) return
    applyCalendar(preset.build())
    setPending(null)
    setOpen(false)
  }

  return (
    /* 视觉上明确是「世界内时间」的下一层：
       左边一道竖线把它挂到上一级，文字比并列的字段小一号、颜色也淡一档。
       不加这道线的话，它会看起来和「所在地点」同一个层级。 */
    <div
      className="mt-3 pl-3"
      style={{ borderLeft: '1px solid var(--color-line)' }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
        title="纪时方法：决定上面的时间怎么读、有哪些可选值"
      >
        {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
        <span
          className="text-[11px] font-medium tracking-wide"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          纪时方法
        </span>
        <span className="flex-1" />
        {/* 当前用的历法。用强调色让它比普通标签显眼一点 */}
        <span className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
          {cal.name}
        </span>
      </button>

      {/* 当前怎么显示。让作者一眼确认自己填的时间会被读成什么 */}
      <div
        className="t-num mt-1 pl-[18px]"
        style={{ color: 'var(--color-ink-faint)', fontSize: 10.5 }}
        title="当前纪时方法的显示效果"
      >
        {formatYear(cal.yearDisplay === 'ce' ? -287 : 421, cal)}
        {cal.months[0] ? ` ${cal.months[0].name}` : ''}
      </div>

      {open && (
        <div className="anim-fade-up mt-2.5 flex flex-col gap-1.5">
          {CALENDAR_PRESETS.map((p) => {
            const active = cal.name === p.build().name
            return (
              <div key={p.id}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => {
                    if (active) return
                    setPending(pending === p.id ? null : p.id)
                  }}
                  aria-pressed={active}
                  style={{
                    padding: '6px 9px',
                    border: '1px solid',
                    borderColor: active ? 'var(--color-accent)' : 'var(--color-line-soft)',
                    background: active ? 'var(--color-accent-wash)' : 'transparent',
                    cursor: active ? 'default' : 'pointer',
                  }}
                >
                  <span
                    className="block text-[11.5px] font-semibold"
                    style={{ color: active ? 'var(--color-accent)' : 'var(--color-ink-mid)' }}
                  >
                    {p.label}
                  </span>
                  <span
                    className="mt-0.5 block text-[10.5px] leading-snug"
                    style={{ color: 'var(--color-ink-faint)' }}
                  >
                    {p.hint}
                  </span>
                </button>

                {/* 二次确认：说清代价，别让作者不知情地被改数据 */}
                {pending === p.id && (
                  <div
                    className="anim-fade-up mt-1.5 px-2.5 py-2"
                    style={{
                      border: '1px solid color-mix(in oklab, var(--color-warn) 34%, transparent)',
                      background: 'color-mix(in oklab, var(--color-warn) 8%, transparent)',
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <WarningCircle
                        size={13}
                        className="mt-[2px] flex-none"
                        style={{ color: 'var(--color-warn)' }}
                      />
                      <div>
                        <div className="text-[11.5px] font-semibold">
                          已填的时间会退化成只剩年份
                        </div>
                        <div
                          className="mt-0.5 text-[11px] leading-relaxed"
                          style={{ color: 'var(--color-ink-soft)' }}
                        >
                          {datedCount > 0
                            ? `纪元名和月名在新纪时法里对不上，所以会清掉；年份数字保留。会有 ${datedCount} 个条目受影响，可以撤销（按 Ctrl+Z 无法撤销，请先导出备份）。`
                            : '目前还没有条目填过时间，切换没有任何代价。'}
                        </div>
                        <div className="mt-2 flex items-center gap-1.5">
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => doSwitch(p.id)}
                          >
                            <ArrowsClockwise size={12} />
                            切换
                          </button>
                          <button
                            type="button"
                            className="btn btn-plain"
                            onClick={() => setPending(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
