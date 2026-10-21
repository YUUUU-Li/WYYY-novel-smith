/* ============================================================
   内容比对：判断「磁盘上的版本」和「内存里的版本」是不是真的不同

   抽成独立模块的原因：这是外部改动检测里最容易出错的一环，
   而它又是纯函数，可以脱离浏览器直接测。
   （检测链路的其余部分依赖 File System Access API，测不了。）

   为什么不能直接 JSON.stringify 比：
   1. 对象键顺序取决于构造顺序，而磁盘读回来的对象键顺序和内存里
      未必一致 —— 那会被误判成「被改过」，每次轮询都弹提示
   2. 实体的 file 字段是「来源路径」，不是内容。文件名改了它就会变，
      但不代表作者改过任何东西
   3. links 数组的顺序没有语义，重排不算改动

   这三个误报源任何一条漏掉，这个功能就会从「有用」变成「关不掉」。
   ============================================================ */

import type { Entity, Novel, NovelDate } from './types'

/**
 * 日期的规范化。
 * 不能直接把对象丢给 JSON.stringify：键的书写顺序会影响结果，
 * 而磁盘读回来的顺序和内存里的未必一致，那样就成了误报源。
 * 所以把键按固定顺序重新组装一遍。
 */
function canonDate(d: NovelDate | undefined): string {
  if (!d) return 'null'
  return JSON.stringify([
    d.era ?? '',
    d.year,
    d.month ?? '',
    d.monthIndex ?? null,
    d.day ?? null,
    d.order ?? null,
  ])
}

/** 实体的规范化形态：键顺序无关、忽略来源路径、links 排序后比较 */
export function canonEntity(e: Entity): string {
  return JSON.stringify([
    e.id,
    e.type,
    e.name,
    [...e.tags].sort(),
    e.summary ?? '',
    e.status ?? '',
    [...e.links]
      .sort((a, b) => (a.to + a.type < b.to + b.type ? -1 : 1))
      .map((l) => [l.to, l.type, l.note ?? '', l.weight ?? 0]),
    canonDate(e.date),
    canonDate(e.dateEnd),
    e.at ?? '',
    // 自定义字段：键顺序也无关
    Object.keys(e.fields ?? {})
      .sort()
      .map((k) => [k, e.fields?.[k] ?? '']),
    e.body,
  ])
}

/** 整份小说的规范化序列化 */
export function comparable(n: Novel): string {
  return JSON.stringify({
    p: n.project,
    e: n.entities.map(canonEntity).sort(),
    o: n.outline,
    t: n.terms,
  })
}

/** 两份小说在内容上是否等价 */
export function sameContent(a: Novel, b: Novel): boolean {
  return comparable(a) === comparable(b)
}

/**
 * 数一数有多少条目的内容真的不同。
 * 用于给用户一个有信息量的提示，而不是干巴巴一句「有变化」。
 */
export function countChanged(a: Novel, b: Novel): number {
  const map = new Map(b.entities.map((e) => [e.id, canonEntity(e)]))
  let n = 0
  for (const e of a.entities) {
    const other = map.get(e.id)
    if (other === undefined || other !== canonEntity(e)) n++
  }
  // 磁盘侧新增的条目也算变化；已删除的由上面的循环覆盖
  const mine = new Set(a.entities.map((e) => e.id))
  for (const e of b.entities) if (!mine.has(e.id)) n++
  return n
}

/** 列出磁盘版本相对内存版本的具体差异，供提示文案使用 */
export function describeDiff(memory: Novel, disk: Novel): string[] {
  const bits: string[] = []
  if (memory.entities.length !== disk.entities.length) {
    bits.push(`条目 ${memory.entities.length} → ${disk.entities.length}`)
  }
  const changed = countChanged(memory, disk)
  if (changed > 0) bits.push(`${changed} 个条目内容不同`)
  if (memory.project.title !== disk.project.title) {
    bits.push(`标题「${memory.project.title}」→「${disk.project.title}」`)
  }
  return bits
}
