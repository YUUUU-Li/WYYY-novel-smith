/* ============================================================
   在场矩阵：谁在什么时候、什么地方

   目标里「同时显现出不同地点不同角色的生活」这句，光并排画出来
   只是好看。它真正的用处是发现两类问题：

     1. 两个人被安排在同一时间同一地点，但关系上不该见面
        （宿敌在同一座城里待了三年，剧情却从没交代过）
     2. 两个人被安排在同一时间同一地点，剧情却从没让他们相遇
        （错过的戏）

   所以这个模块不只输出矩阵，还输出「同处提示」。

   时间分桶的取舍：
   用「纪元 + 年」而不是月或日。理由——
   - 角色通常只有一个时间点（出生/登场），没有时间段。按日分桶
     会让每个人只出现在一格，矩阵几乎全空，没有并排意义。
   - 按年分桶能让「谁和谁在同一年待在同一地」这个事实浮出来，
     而这恰好就是上面两类问题的判定依据。
   - 事件的跨度（dateEnd）会展开成多个桶，所以战争、围城这类
     持续事件能正确覆盖它在场的每一年。
   ============================================================ */

import { dateToSortable } from './dates'
import { resolvePlace, type Place } from './places'
import type { Entity, Novel } from './types'

export interface PresenceBucket {
  /** 稳定键，用作 React key 和单元格定位 */
  key: string
  /** 显示用短标签，如「天·421」 */
  label: string
  /** 完整标签，如「天和 421 年」 */
  fullLabel: string
  /** 排序值 */
  sort: number
}

export interface PresenceCell {
  bucketKey: string
  /** 地点键（地点条目 / 地图区域 / 自由文字三者统一后的 key） */
  locationKey: string
  /** 该格里的角色 id，按名字排序 */
  characterIds: string[]
}

export interface CoPresence {
  locationKey: string
  locationName: string
  bucketKey: string
  bucketLabel: string
  /** 同处的角色 id */
  characterIds: string[]
  /** 他们之间已有的关系类型（去重），空数组表示剧情里没交代过 */
  linkTypes: string[]
  /**
   * 关系的「紧张度」。
   * hostile = 已有敌对类关系，同处却无交代，最值得检查
   * none    = 两人之间完全没有关系记录，属于「错过的戏」
   * other   = 有其它类型关系（同僚/亲属等），同处是合理的
   */
  tension: 'hostile' | 'none' | 'other'
}

export interface PresenceGrid {
  buckets: PresenceBucket[]
  /** 有位置信息的角色 */
  characters: Entity[]
  /** 作为行出现的地点，只保留真的有角色在的地方。
      可能是地点条目，也可能是地图区域或一句自由文字。 */
  places: Place[]
  cells: PresenceCell[]
  coPresence: CoPresence[]
  /** 角色总数里有多少因为没填所在地点而无法参与 */
  missingLocation: Entity[]
  /** 完全没有时间信息的角色 */
  missingTime: Entity[]
}

/* ---------------- 时间桶 ---------------- */

/** 从纪元名生成短标签：天和 → 天 */
function eraAbbr(novel: Novel, era: string | undefined): string {
  if (!era) return ''
  const hit = novel.project.calendar.eras.find((e) => e.name === era)
  return hit ? hit.abbr : era.slice(0, 1)
}

function bucketOf(novel: Novel, d: { era?: string; year: number }): PresenceBucket {
  const era = d.era ?? ''
  const abbr = eraAbbr(novel, d.era)
  const full = era ? `${era} ${d.year} 年` : `${d.year} 年`
  return {
    key: `${era}|${d.year}`,
    label: `${abbr}${abbr ? '·' : ''}${d.year}`,
    fullLabel: full,
    sort: dateToSortable({ era: d.era, year: d.year }, novel.project.calendar),
  }
}

/* ---------------- 主计算 ---------------- */

/**
 * 一个地点被处理成「角色在哪儿」的依据有三条，按可靠性排序：
 *   1. 角色自己的 at 字段（作者明确写的所在地）
 *   2. 角色参与过的事件的地点（事件发生在哪，参与者就在哪）
 *   3. 角色自己的 date 字段（决定它落在哪些时间桶）
 *
 * 注意第 1 条是「当前所在地」，没有时间维度。所以它的处理方式是：
 * 让这个角色在它出现过的每一个时间桶里都算在该地点。这是有意的
 * 近似 —— 作品的设定里「某某驻守某地」通常就是这个意思。
 * 如果将来要给角色加「时间段 + 地点」的历史，这个函数是唯一改动点。
 */
export function buildPresenceGrid(novel: Novel): PresenceGrid {
  const byId = new Map(novel.entities.map((e) => [e.id, e]))
  const characters = novel.entities.filter((e) => e.type === 'character')

  /* ---- 先收集候选时间桶 ---- */
  const bucketByKey = new Map<string, PresenceBucket>()
  const noteBucket = (b: PresenceBucket) => {
    if (!bucketByKey.has(b.key)) bucketByKey.set(b.key, b)
  }

  /* ---- 谁参加了哪个事件 ----
     关系是单向书写的：角色 → 事件（「林昭 参与 围城」），
     或者事件 → 角色（事件里选「参与角色」时写的就是这个方向）。
     两边都算 —— 作者写哪边，都得能算出来，否则「填了却没反应」。 */
  const eventsOfCharacter = new Map<string, Entity[]>()
  const addParticipation = (charId: string, ev: Entity) => {
    const list = eventsOfCharacter.get(charId)
    if (!list) eventsOfCharacter.set(charId, [ev])
    else if (!list.some((x) => x.id === ev.id)) list.push(ev)
  }
  for (const e of novel.entities) {
    if (e.type === 'character') {
      for (const l of e.links) {
        if (l.type !== '参与') continue
        const ev = byId.get(l.to)
        if (ev?.type === 'event') addParticipation(e.id, ev)
      }
    } else if (e.type === 'event') {
      for (const l of e.links) {
        if (l.type !== '参与') continue
        const c = byId.get(l.to)
        if (c?.type === 'character') addParticipation(c.id, e)
      }
    }
  }

  /** 某个角色参与过的事件，连它们的年份跨度一起列出来 */
  const participationOf = (c: Entity): Array<{ ev: Entity; years: number[] }> => {
    const out: Array<{ ev: Entity; years: number[] }> = []
    for (const ev of eventsOfCharacter.get(c.id) ?? []) {
      if (!ev.date) continue
      const start = ev.date
      const end = ev.dateEnd ?? ev.date
      // 跨度事件展开到每一年，围城战这种持续事件才能正确覆盖
      const span = Math.max(0, (end.year ?? start.year) - start.year)
      const years: number[] = []
      const era = start.era
      for (let i = 0; i <= Math.min(span, 60); i++) {
        const y = start.year + i
        years.push(y)
        noteBucket(bucketOf(novel, { era, year: y }))
      }
      out.push({ ev, years })
    }
    return out
  }

  for (const c of characters) {
    if (c.date) noteBucket(bucketOf(novel, c.date))
    participationOf(c)
  }

  /* ---- 时间桶排序 ---- */
  const buckets = Array.from(bucketByKey.values()).sort((a, b) => a.sort - b.sort)

  /* ---- 铺开单元格 ----
     两条规则：
       1. 参与了事件 → 事件那年在该事件的发生地。这是唯一会为角色
          「创造」时间桶的规则。
       2. 老文件里写了 at → 它出现过的每个桶都算在那个地点。界面上
          已经没有这一栏了，这里只为兼容手写的旧文件，且它只往已有
          桶里填格，不会创造桶。

     以前还有一条优先级最高的「驻留历史」规则。那一栏已经删掉了：
     角色的位置由「参与了哪个事件」推出来就够了，另外维护一份
     「什么时候住在哪」既容易过期，又会和事件里的说法打架。 */
  const cellMap = new Map<string, PresenceCell>()
  const usedPlaces = new Map<string, Place>()

  /** 能当成「一个地点」的才算；坏引用（id 对不上）一律当没填 */
  const placeOf = (ref: string | undefined): Place | null => {
    const p = resolvePlace(novel, ref)
    return p && !p.broken ? p : null
  }

  const put = (charId: string, place: Place, bucketKey: string) => {
    usedPlaces.set(place.key, place)
    const key = `${bucketKey}::${place.key}`
    const cell = cellMap.get(key)
    if (cell) {
      if (!cell.characterIds.includes(charId)) cell.characterIds.push(charId)
    } else {
      cellMap.set(key, { bucketKey, locationKey: place.key, characterIds: [charId] })
    }
  }

  for (const c of characters) {
    const parts = participationOf(c)

    /* 规则 1：事件那年在该事件的发生地。
       发生地点可能是地点条目、地图区域，或者一句自由文字 ——
       三种都算，不然「选了个区域」的事件会从这里凭空消失。
       坏掉的引用（id 对不上）不算：那会让矩阵凭空多出一行假地点。 */
    for (const { ev, years } of parts) {
      const place = placeOf(ev.at)
      if (!place) continue
      for (const y of years) {
        put(c.id, place, bucketOf(novel, { era: ev.date?.era, year: y }).key)
      }
    }

    /* 规则 2：旧行为 —— 用 at，近似到它出现过的每个桶 */
    const ownPlace = placeOf(c.at)
    if (ownPlace) {
      const own: string[] = []
      if (c.date) own.push(bucketOf(novel, c.date).key)
      for (const { years, ev } of parts) {
        for (const y of years) own.push(bucketOf(novel, { era: ev.date?.era, year: y }).key)
      }
      for (const bKey of own) put(c.id, ownPlace, bKey)
    }
  }

  // 单元格内的角色按名字排序，保证渲染稳定
  for (const cell of cellMap.values()) {
    cell.characterIds.sort((a, b) => {
      const na = byId.get(a)?.name ?? ''
      const nb = byId.get(b)?.name ?? ''
      return na.localeCompare(nb, 'zh-Hans-CN')
    })
  }

  /* 行 = 真的有角色在的地点，按「最早出现的桶」排序。
     这里不再只认地点条目：区域和自由文字同样能撑起一行，
     否则给事件选了区域的人会看到一个空矩阵。 */
  const places = Array.from(usedPlaces.values()).sort((a, b) => {
    const firstOf = (key: string) => {
      let best = Number.POSITIVE_INFINITY
      for (const bucket of buckets) {
        const cell = cellMap.get(`${bucket.key}::${key}`)
        if (cell && cell.characterIds.length > 0) {
          best = Math.min(best, bucket.sort)
        }
      }
      return best
    }
    const d = firstOf(a.key) - firstOf(b.key)
    return d !== 0 ? d : a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  /* ---- 同处提示 ---- */
  const hostileTypes = ['敌对', '宿敌', '仇敌', '世仇']
  const coPresence: CoPresence[] = []

  for (const cell of cellMap.values()) {
    if (cell.characterIds.length < 2) continue
    const place = usedPlaces.get(cell.locationKey)
    const bucket = bucketByKey.get(cell.bucketKey)
    if (!place || !bucket) continue

    // 收集这一格里所有两两之间的已有关系
    const types = new Set<string>()
    for (let i = 0; i < cell.characterIds.length; i++) {
      for (let j = i + 1; j < cell.characterIds.length; j++) {
        const a = byId.get(cell.characterIds[i])
        const b = byId.get(cell.characterIds[j])
        if (!a || !b) continue
        // 双向都看：关系只写一边是常态
        for (const l of a.links) if (l.to === b.id) types.add(l.type)
        for (const l of b.links) if (l.to === a.id) types.add(l.type)
      }
    }

    const hasHostile = Array.from(types).some((t) => hostileTypes.includes(t))
    const tension: CoPresence['tension'] =
      hasHostile ? 'hostile' : types.size === 0 ? 'none' : 'other'

    coPresence.push({
      locationKey: cell.locationKey,
      locationName: place.name,
      bucketKey: cell.bucketKey,
      bucketLabel: bucket.fullLabel,
      characterIds: [...cell.characterIds],
      linkTypes: Array.from(types).sort(),
      tension,
    })
  }

  // 最值得检查的排前面：先敌对，再无关系，再其它；然后按时间
  const tensionRank = { hostile: 0, none: 1, other: 2 }
  coPresence.sort((a, b) => {
    if (tensionRank[a.tension] !== tensionRank[b.tension]) {
      return tensionRank[a.tension] - tensionRank[b.tension]
    }
    const ba = bucketByKey.get(a.bucketKey)?.sort ?? 0
    const bb = bucketByKey.get(b.bucketKey)?.sort ?? 0
    if (ba !== bb) return ba - bb
    return a.locationName.localeCompare(b.locationName, 'zh-Hans-CN')
  })

  /** 真正出现在矩阵里的角色：至少占了一格 */
  const placedIds = new Set<string>()
  for (const cell of cellMap.values()) {
    for (const id of cell.characterIds) placedIds.add(id)
  }

  return {
    buckets,
    characters: characters.filter((c) => placedIds.has(c.id)),
    places,
    cells: Array.from(cellMap.values()),
    coPresence,
    /* 「没填地点」现在只剩一种情况：没有发生地点可循。
       角色的所在地点与驻留历史都已经从界面上删掉了，
       所以只看事件参与和老文件里的 at。 */
    /* 「没填地点」现在只剩一种情况：没有发生地点可循。
       角色的所在地点与驻留历史都已经从界面上删掉了，
       所以只看自己写的 at 和参与过的事件。 */
    missingLocation: characters.filter(
      (c) =>
        !placeOf(c.at) &&
        !(eventsOfCharacter.get(c.id) ?? []).some((ev) => placeOf(ev.at)),
    ),
    missingTime: characters.filter(
      (c) => !c.date && !(eventsOfCharacter.get(c.id) ?? []).some((ev) => ev.date),
    ),
  }
}

/** 取某一格，界面渲染时用 */
export function cellAt(
  grid: PresenceGrid,
  bucketKey: string,
  locationKey: string,
): PresenceCell | undefined {
  return grid.cells.find((c) => c.bucketKey === bucketKey && c.locationKey === locationKey)
}

/** 同一格里有几个以上角色才算「同处」，默认 2 */
export const CO_PRESENCE_THRESHOLD = 2

/** 供界面显示的一句话结论 */
export function summarizeTension(c: CoPresence, nameOf: (id: string) => string): string {
  const names = c.characterIds.map(nameOf).join('、')
  if (c.tension === 'hostile') {
    return `${names} 在${c.bucketLabel}同在${c.locationName}，但他们的关系是「${c.linkTypes.join('/')}」`
  }
  if (c.tension === 'none') {
    return `${names} 在${c.bucketLabel}同在${c.locationName}，但剧情里他们没有任何关系`
  }
  return `${names} 在${c.bucketLabel}同在${c.locationName}（${c.linkTypes.join('/')}）`
}
