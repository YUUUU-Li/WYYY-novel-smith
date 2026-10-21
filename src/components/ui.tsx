/* ============================================================
   公共零件
   每个零件都实现了完整状态：正常 / 空 / 加载。没有只做「成功态」。
   ============================================================ */

import { useEffect, useState, type ReactNode } from 'react'
import { ENTITY_META, type EntityType } from '../lib/types'
import { cx } from '../lib/util'

/* ---------- 实体色点：全应用统一的类型标识 ---------- */
export function TypeDot({
  type,
  size = 7,
}: {
  type: EntityType
  size?: number
}) {
  const meta = ENTITY_META[type]
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-xs)',
        background: `var(${meta.cssVar})`,
        flex: 'none',
        display: 'inline-block',
      }}
    />
  )
}

/* ---------- 类型徽标 ---------- */
export function TypeChip({
  type,
  count,
}: {
  type: EntityType
  count?: number
}) {
  const meta = ENTITY_META[type]
  return (
    <span
      className="chip"
      style={{
        color: `var(${meta.cssVar})`,
        borderColor: `color-mix(in oklab, var(${meta.cssVar}) 34%, transparent)`,
        background: `color-mix(in oklab, var(${meta.cssVar}) 10%, transparent)`,
      }}
    >
      {meta.label}
      {count !== undefined && <span className="t-num opacity-70">{count}</span>}
    </span>
  )
}

/* ---------- 区块标题：用线分层，不用卡片堆叠 ---------- */
export function SectionLabel({
  children,
  right,
}: {
  children: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-2.5">
      <div className="t-micro">{children}</div>
      {right}
    </div>
  )
}

/* ---------- 空状态：好好写，不要一句「暂无数据」 ---------- */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6 anim-fade-up">
      <div
        className="mb-4"
        style={{
          width: 34,
          height: 34,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-line)',
          background: 'var(--color-surface)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 'var(--radius-xs)',
            border: '1.5px dashed var(--color-ink-faint)',
          }}
        />
      </div>
      <div className="text-[13.5px] font-medium text-[var(--color-ink)]">{title}</div>
      {hint && (
        <div className="mt-1.5 max-w-[38ch] text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
          {hint}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/* ---------- 骨架屏：形状必须与最终内容一致 ---------- */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} />
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="px-3 py-3 flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <Skeleton className="w-[7px] h-[7px] rounded-[2px]" />
          <Skeleton
            className="h-[11px]"
            // 宽度刻意不等长，避免看起来像进度条
            {...{ style: { width: `${58 + ((i * 37) % 38)}%` } }}
          />
        </div>
      ))}
    </div>
  )
}

/* ---------- 统计数字：用等宽字，数字才对齐 ---------- */
export function Stat({
  value,
  label,
  accent,
}: {
  value: ReactNode
  label: string
  accent?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="t-num"
        style={{ fontSize: 19, lineHeight: 1.1, color: accent ?? 'var(--color-ink)' }}
      >
        {value}
      </div>
      <div className="text-[11px] text-[var(--color-ink-soft)]">{label}</div>
    </div>
  )
}

/* ---------- 危险操作的二次确认 ----------
   就地变成确认态，不弹模态框。3 秒不操作自动退回，
   避免一个「已武装」的删除按钮留在界面上。 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = '确认删除',
}: {
  onConfirm: () => void
  children: ReactNode
  confirmLabel?: string
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <button
      type="button"
      className="btn btn-danger"
      aria-live="polite"
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
