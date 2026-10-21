/* 通用小工具 */

/** 条件拼 className，避免引入 clsx 这种只为一个函数存在的依赖 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 把实体类型色转成可用的 CSS 值 */
export function entityColor(cssVar: string): string {
  return `var(${cssVar})`
}

/** 从 hex 生成带透明度的颜色，用于极淡的底色 */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 字数统计：中文按字算，英文按词算，混排时取合理近似 */
export function countWords(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  const latin = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9]+/g) ?? [])
    .length
  return cjk + latin
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null
  return (...args: A) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

/** 把线性值映射到区间 */
export function scale(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return (outMin + outMax) / 2
  return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin)
}
