/* ============================================================
   发生地点：把一个事件的「发生在哪」解析成人能读的东西

   存进去的仍然只是一个字符串（`Entity.at`），但它可以是三种东西：

     1. 地点条目的 id —— 最正规：跟着条目改名，条目删掉时会被清掉
     2. 地图区域的 id —— 你在「地图」页画了区域，不必先建一个地点条目
     3. 一段自由文字 —— 既没画区域也不想建条目时，直接写「城南渡口」

   为什么不做成 { kind, id } 这样的结构体：那会让磁盘格式跟着变，
   已经写出去的几百个 .md 全要迁移，而换来的只是省掉一次查表。
   一个字符串同样能唯一定位这三种里的任意一种 —— 解析放在读的时候做，
   写出去的文件一行都不用改。

   为什么区域要先看它绑没绑地点条目：地图上的区域可以绑一个地点条目
   （MapRegion.entity）。绑了就说明它们是同一个地方，选区域和选条目
   必须收敛到同一个结果，否则在场矩阵里会出现两行「北境城」。
   ============================================================ */

import type { Entity, Novel, WorldMap } from './types'

export type PlaceKind = 'entity' | 'region' | 'text'

export interface Place {
  kind: PlaceKind
  /** 稳定的分组键。同一个地方永远得到同一个 key */
  key: string
  name: string
  /** 地点条目 id（kind === 'entity' 时一定有） */
  entityId?: string
  /** 区域 id（kind === 'region' 时一定有） */
  regionId?: string
  /** 区域挂在哪张地图上，用来区分同名区域 */
  mapName?: string
  /**
   * 这个值长得像条目/区域的 id，却谁都对不上 —— 说明引用坏了
   * （手改文件、或者旧版本留下的）。界面上要如实说「找不到」，
   * 而不是把它当成一个叫「e_1k6hqlzd」的地名。
   */
  broken?: boolean
}

/**
 * 我们自己生成的 id 长什么样。
 *
 * 用途只有一个：区分「作者手写的地名」和「坏掉的引用」。
 * 后者不该在在场矩阵里变成一行虚构的地点，也不该被当成地名显示。
 * `e_` 是现在的条目 id，`loc_`/`char_` 这些是早期版本的前缀，还留在老文件里。
 */
const ID_SHAPE = /^(e|loc|char|character|location|event|faction|item|concept|reg|map|pin|out)_[a-z0-9]{3,}$/i

/**
 * 解析一个 `at` 值。
 *
 * 解析不出来的时候不返回 null，而是把原文当成地名 —— 宁可显示一个
 * 用户自己写的字，也不要因为数据半坏就在界面上抹掉这条信息。
 * 唯一的例外是「长得像 id 却对不上」：那不是地名，是坏引用，标成 broken。
 */
export function resolvePlace(novel: Novel, ref: string | undefined): Place | null {
  if (!ref) return null

  const entity = novel.entities.find((e) => e.id === ref)
  if (entity) {
    if (entity.type === 'location') {
      return { kind: 'entity', key: `e:${entity.id}`, name: entity.name, entityId: entity.id }
    }
    /* at 指到了一个非地点的条目上（手写的旧文件里可能这样）。
       当成文字处理，但至少要显示它现在的名字，而不是一串 id。 */
    return { kind: 'text', key: `t:${ref}`, name: entity.name }
  }

  for (const map of novel.project.maps) {
    const region = map.regions.find((r) => r.id === ref)
    if (!region) continue
    const bound = region.entity
      ? novel.entities.find((e) => e.id === region.entity && e.type === 'location')
      : undefined
    if (bound) {
      return { kind: 'entity', key: `e:${bound.id}`, name: bound.name, entityId: bound.id }
    }
    return {
      kind: 'region',
      key: `r:${region.id}`,
      name: region.name,
      regionId: region.id,
      mapName: map.name,
    }
  }

  if (ID_SHAPE.test(ref)) {
    return { kind: 'text', key: `t:${ref}`, name: ref, broken: true }
  }

  return { kind: 'text', key: `t:${ref}`, name: ref }
}

export interface PlaceOption {
  /** 写进 at 的值 */
  ref: string
  name: string
  /** 副标题：区域挂在哪张地图上 */
  hint?: string
  kind: PlaceKind
  group: '地点条目' | '地图区域'
}

/**
 * 可选项清单：地点条目 + 地图区域。
 *
 * 已经绑了地点条目的区域不再单列 —— 那份选择已经由条目代表，
 * 同一行出现两次只会让人怀疑自己选错了。
 */
export function placeOptions(novel: Novel): PlaceOption[] {
  const out: PlaceOption[] = []
  const maps = novel.project.maps

  for (const e of novel.entities) {
    if (e.type !== 'location') continue
    out.push({ ref: e.id, name: e.name, kind: 'entity', group: '地点条目' })
  }

  const multiMap = maps.filter((m) => m.regions.length > 0).length > 1
  for (const map of maps) {
    for (const region of map.regions) {
      if (region.entity && novel.entities.some((e) => e.id === region.entity)) continue
      out.push({
        ref: region.id,
        name: region.name,
        hint: multiMap ? map.name : undefined,
        kind: 'region',
        group: '地图区域',
      })
    }
  }

  const byName = (a: PlaceOption, b: PlaceOption) => a.name.localeCompare(b.name, 'zh-Hans-CN')
  return [
    ...out.filter((o) => o.group === '地点条目').sort(byName),
    ...out.filter((o) => o.group === '地图区域').sort(byName),
  ]
}

/**
 * 自己打的一段字，如果能唯一对上已有的地点或区域，就绑上去。
 *
 * 绑上去比留成文字好：之后改条目名、删区域，事件会跟着走，
 * 在场矩阵也能把它和同一个地方的其它事件算在一起。
 * 只在「恰好一个」的时候绑 —— 同名的有两个（比如两张地图上都有
 * 「北境」），就老老实实留成文字，不要替作者猜。
 */
export function refForText(novel: Novel, raw: string): string | undefined {
  const text = raw.trim()
  if (!text) return undefined

  const hitEntity = novel.entities.filter((e) => e.type === 'location' && e.name === text)
  if (hitEntity.length === 1) return hitEntity[0].id

  const hitRegion = placeOptions(novel).filter((o) => o.kind === 'region' && o.name === text)
  if (hitRegion.length === 1) return hitRegion[0].ref

  return undefined
}

/**
 * 地图上的区域被删掉之后，把指向它的「发生地点」改写成那个区域的名字。
 *
 * 不改的话，事件会指着一个不存在的 id —— 界面上会变成「找不到这个地点
 * （reg_1a2b3c）」。作者刚写的「北境行省」那几个字比这有用得多，
 * 所以留在原处，只是从「地图区域」降级成「自定义」。
 *
 * 返回新的 entities 数组；没有东西要改时返回 null（省掉一次无谓的重建）。
 */
export function remapDeletedRegions(novel: Novel, nextMaps: WorldMap[]): Entity[] | null {
  const before = new Map<string, string>()
  for (const m of novel.project.maps) for (const r of m.regions) before.set(r.id, r.name)

  const after = new Set<string>()
  for (const m of nextMaps) for (const r of m.regions) after.add(r.id)

  const gone = new Map<string, string>()
  for (const [id, name] of before) if (!after.has(id)) gone.set(id, name)
  if (gone.size === 0) return null

  let changed = false
  const entities = novel.entities.map((e) => {
    if (!e.at || !gone.has(e.at)) return e
    changed = true
    return { ...e, at: gone.get(e.at) }
  })
  return changed ? entities : null
}
