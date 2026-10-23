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

/**
 * 复制文本，返回「到底复制成功没有」。
 *
 * 为什么不能直接 `navigator.clipboard.writeText()` 就当成功了：
 * 这个 API 需要安全上下文 + 用户手势 + 没有被策略拦，任何一条不满足都会抛，
 * 而在桌面版的 WebView2 里它确实可能被拒。调用方拿这个布尔值来决定要不要
 * 显示「已复制」—— 让界面显示一件没发生的事，比不显示更糟。
 *
 * 兜底用 textarea + execCommand('copy')：这个老接口在 WebView2 里反而是通的。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 掉到下面的兜底
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // 不能用 display:none / visibility:hidden —— 那样选不中，复制不到
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const done = document.execCommand('copy')
    document.body.removeChild(ta)
    return done
  } catch {
    return false
  }
}
