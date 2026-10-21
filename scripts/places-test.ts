/* ============================================================
   发生地点的解析

   为什么值得单独测：这个字段在磁盘上只是一个字符串，但它可能装着
   三种完全不同的东西（地点条目 id / 地图区域 id / 自由文字）。
   解析一旦搞错，坏的不是某一屏，而是「事件去了哪」这件事本身 ——
   时间线的地点轨道、在场矩阵的行、条目的「发生地点」全都在读它。

   跑法：由 npm test 统一触发
   ============================================================ */

import { placeOptions, refForText, remapDeletedRegions, resolvePlace } from '../src/lib/places.ts'
import { relatedAt } from '../src/lib/index-builder.ts'
import type { Entity, Novel, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

function E(p: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'name'>): Entity {
  return { tags: [], links: [], body: '', ...p }
}

const project: Project = {
  id: 'p',
  title: '书',
  linkTypes: [],
  fieldSchemas: {},
  calendar: {
    name: '天和历',
    eras: [{ name: '天和', abbr: '天' }],
    eraOrder: ['天和'],
    months: [{ name: '霜月', days: 30 }],
  },
  folders: [],
  rootItems: [],
  maps: [
    {
      id: 'map1',
      name: '天下图',
      width: 1000,
      height: 700,
      pins: [],
      regions: [
        { id: 'rg_north', name: '北境', points: [] },
        { id: 'rg_south', name: '南境', points: [], entity: 'loc_nan' },
      ],
    },
    {
      id: 'map2',
      name: '北境详图',
      width: 1000,
      height: 700,
      pins: [],
      regions: [{ id: 'rg_north2', name: '北境', points: [] }],
    },
  ],
  createdAt: 0,
  updatedAt: 0,
}

const locNan = E({ id: 'loc_nan', type: 'location', name: '南境城' })
const locBei = E({ id: 'loc_bei', type: 'location', name: '北境城' })
const charLin = E({ id: 'c_lin', type: 'character', name: '林昭' })

const novel: Novel = {
  project,
  entities: [locNan, locBei, charLin],
  outline: [],
  terms: [],
}

console.log('\n[1] 一个字符串认三种东西')

{
  check('空值解析成空', resolvePlace(novel, undefined) === null)
  check('空字符串也当空', resolvePlace(novel, '') === null)

  const byEntity = resolvePlace(novel, 'loc_bei')
  check('地点条目 id 认得出来', byEntity?.kind === 'entity' && byEntity?.name === '北境城',
    JSON.stringify(byEntity))

  const byRegion = resolvePlace(novel, 'rg_north')
  check('没绑条目的区域用自己的名字', byRegion?.kind === 'region' && byRegion?.name === '北境',
    JSON.stringify(byRegion))
  check('区域记着自己挂在哪张图上', byRegion?.mapName === '天下图', String(byRegion?.mapName))

  const byText = resolvePlace(novel, '城南渡口')
  check('自由文字原样当地名', byText?.kind === 'text' && byText?.name === '城南渡口',
    JSON.stringify(byText))
}

console.log('\n[2] 区域绑了地点条目，就收敛到条目上')

{
  const bound = resolvePlace(novel, 'rg_south')
  check('绑了条目的区域解析成那个条目', bound?.kind === 'entity' && bound?.entityId === 'loc_nan',
    JSON.stringify(bound))
  check('名字用条目的名字，不用区域的名字', bound?.name === '南境城', String(bound?.name))
  check('和直接选条目得到同一个 key', bound?.key === resolvePlace(novel, 'loc_nan')?.key,
    `${bound?.key} vs ${resolvePlace(novel, 'loc_nan')?.key}`)
}

console.log('\n[3] 半坏的数据也不能显示成乱码 id')

{
  /* 区域被删掉、条目被删掉之后，at 里可能留着一个指不到的 id。
     这时要分清两种「解析不出来」： */
  const dangling = resolvePlace(novel, 'e_deadbeef')
  check('长得像 id 却对不上 → 标记为坏引用',
    dangling?.broken === true && dangling?.name === 'e_deadbeef', JSON.stringify(dangling))

  const weird = resolvePlace(novel, 'loc_已删除')
  check('不像 id 的原文仍然当地名', weird?.broken !== true && weird?.name === 'loc_已删除',
    JSON.stringify(weird))

  /* at 指到一个不是地点的条目上（手写文件里会发生） */
  const wrongType = resolvePlace(novel, 'c_lin')
  check('指到角色上时显示角色的名字', wrongType?.name === '林昭', JSON.stringify(wrongType))
  check('不会把它当成地点条目', wrongType?.kind === 'text', String(wrongType?.kind))
}

console.log('\n[4] 可选项清单')

{
  const opts = placeOptions(novel)
  const names = opts.map((o) => `${o.group}:${o.name}`)
  check('地点条目都在', names.includes('地点条目:北境城') && names.includes('地点条目:南境城'),
    names.join(' '))
  check('没绑条目的区域可选项里有', names.includes('地图区域:北境'), names.join(' '))
  check('绑了条目的区域不再单列（避免同一行出现两次）',
    !opts.some((o) => o.ref === 'rg_south'), names.join(' '))
  check('两张图上同名的区域都在，靠地图名区分',
    opts.filter((o) => o.name === '北境').length === 2, names.join(' '))
  check('多张图时才带地图名', opts.filter((o) => o.name === '北境').every((o) => Boolean(o.hint)),
    JSON.stringify(opts.filter((o) => o.name === '北境')))
  check('地点条目排在区域前面', opts[0].group === '地点条目', opts[0].group)
}

console.log('\n[5] 自己打的字能不能绑回已有地点')

{
  check('正好是地点条目名 → 绑条目', refForText(novel, '北境城') === 'loc_bei',
    String(refForText(novel, '北境城')))
  check('首尾空格不影响', refForText(novel, '  南境城  ') === 'loc_nan',
    String(refForText(novel, '  南境城  ')))
  check('同名的区域有两个 → 不猜，留成文字', refForText(novel, '北境') === undefined,
    String(refForText(novel, '北境')))
  check('认不出来的名字留成文字', refForText(novel, '城南渡口') === undefined)
  check('空串不绑', refForText(novel, '   ') === undefined)
}

console.log('\n[6] 「这个地点下有什么」也要认区域')

{
  /* 事件的发生地点选的是绑了条目的区域：查「南境城发生过什么」时必须查得到，
     否则条目页会说这里什么都没发生过，而时间线上明明有。 */
  const evByRegion = E({ id: 'ev1', type: 'event', name: '入城', at: 'rg_south' })
  const evByEntity = E({ id: 'ev2', type: 'event', name: '巡城', at: 'loc_nan' })
  const evElsewhere = E({ id: 'ev3', type: 'event', name: '别处', at: 'rg_north' })
  const n2: Novel = {
    ...novel,
    entities: [...novel.entities, evByRegion, evByEntity, evElsewhere],
  }
  const ids = relatedAt(n2, 'loc_nan').map((e) => e.id)
  check('区域上的事件算在这个地点名下', ids.includes('ev1'), ids.join(' '))
  check('直接选条目的也算', ids.includes('ev2'), ids.join(' '))
  check('别处的不会被算进来', !ids.includes('ev3'), ids.join(' '))
}

console.log('\n[7] 区域被删掉时，别把事件的地点弄丢')

{
  /* 删区域是个日常动作（画歪了重画）。指向它的发生地点不能变成
     「找不到这个地点（reg_1a2b3c）」—— 作者刚写的名字要留住。 */
  const nextMaps = [
    {
      id: 'map1',
      name: '天下图',
      width: 1000,
      height: 700,
      pins: [],
      // 只留下南境，北境那两个区域都被删了
      regions: [{ id: 'rg_south', name: '南境', points: [], entity: 'loc_nan' }],
    },
    { ...novel.project.maps[1], regions: [] },
  ]
  const atNorth = E({ id: 'ev_n', type: 'event', name: '雪原之战', at: 'rg_north' })
  const atSouth = E({ id: 'ev_s', type: 'event', name: '入城', at: 'rg_south' })
  const atText = E({ id: 'ev_t', type: 'event', name: '渡口', at: '城南渡口' })
  const n2: Novel = { ...novel, entities: [...novel.entities, atNorth, atSouth, atText] }

  const patched = remapDeletedRegions(n2, nextMaps)
  const byId = new Map((patched ?? n2.entities).map((e) => [e.id, e]))
  check('被删区域上的事件降级成自由文字，用的是区域名',
    byId.get('ev_n')?.at === '北境', String(byId.get('ev_n')?.at))
  check('没被删的区域不受影响', byId.get('ev_s')?.at === 'rg_south', String(byId.get('ev_s')?.at))
  check('本来就是文字的不受影响', byId.get('ev_t')?.at === '城南渡口', String(byId.get('ev_t')?.at))
  check('降级之后不会再被当成坏引用', (() => {
    const n3: Novel = { ...n2, entities: patched ?? n2.entities }
    return resolvePlace(n3, byId.get('ev_n')?.at)?.broken !== true
  })())

  check('没有区域被删时返回 null（不做无谓的重建）',
    remapDeletedRegions(n2, n2.project.maps) === null)
  check('整张地图删掉时也会被处理',
    remapDeletedRegions(n2, []) !== null)
}

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：地点条目、地图区域、自由文字三种发生地点都能正确解析。')
  process.exit(0)
}
console.log('结论：发生地点的解析不符合预期。')
process.exit(1)
