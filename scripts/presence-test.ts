/* ============================================================
   在场矩阵与同处提示的行为测试

   这个功能的失败模式有两种，都会让它变成废功能：
   1. 漏报：宿敌同城三年却什么都没提示 —— 那它就没用了
   2. 误报：随便两个不相干的角色同在一地就报警 —— 那你会关掉它

   所以两组断言都要有。另外「同处」的判定必须能识别单向书写的关系
   （关系只写一边是常态），否则会漏掉一半情况。

   最后一节测的是「发生地点不必是一个地点条目」：区域和自由文字
   也必须能撑起矩阵的一行，否则选了个区域的作者会看到一张空表。

   跑法：由 npm test 统一触发
   ============================================================ */

import { buildPresenceGrid, summarizeTension } from '../src/lib/presence.ts'
import { castOf } from '../src/lib/index-builder.ts'
import type { Entity, Novel, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

const project: Project = {
  id: 'p',
  title: '书',
  linkTypes: [],
  fieldSchemas: {},
  calendar: {
    name: '天和历',
    eras: [
      { name: '昭元', abbr: '昭' },
      { name: '天和', abbr: '天' },
    ],
    eraOrder: ['昭元', '天和'],
    months: [{ name: '霜月', days: 30 }],
  },
  maps: [],
  folders: [],
  rootItems: [],
  createdAt: 0,
  updatedAt: 0,
}

function E(p: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'name'>): Entity {
  return { tags: [], links: [], body: '', ...p }
}

/* ============================================================
   场景：两个宿敌在同一个要塞待了三年，剧情从没交代
   ============================================================ */

const novel: Novel = {
  project,
  outline: [],
  terms: [],
  entities: [
    E({ id: 'loc_bj', type: 'location', name: '北境要塞' }),
    E({ id: 'loc_yj', type: 'location', name: '云京' }),
    E({
      id: 'c_lin',
      type: 'character',
      name: '林昭',
      at: 'loc_bj',
      date: { era: '天和', year: 421, month: '麦月', day: 2 },
      links: [{ to: 'c_su', type: '敌对', note: '十年旧账' }],
    }),
    E({
      id: 'c_su',
      type: 'character',
      name: '苏无咎',
      at: 'loc_bj',
      date: { era: '天和', year: 421, month: '麦月', day: 5 },
    }),
    E({
      id: 'c_shen',
      type: 'character',
      name: '沈雁',
      at: 'loc_bj',
      date: { era: '天和', year: 421, month: '麦月', day: 9 },
    }),
    E({
      id: 'c_yun',
      type: 'character',
      name: '云绮',
      at: 'loc_yj',
      date: { era: '天和', year: 421, month: '麦月', day: 21 },
    }),
  ],
}

/* ---------------- 1. 时间分桶 ---------------- */

console.log('\n[1] 时间分桶')

{
  const g = buildPresenceGrid(novel)
  check('按纪元+年分桶', g.buckets.length === 1, `${g.buckets.length} 个桶`)
  check('桶标签带纪元缩写', g.buckets[0]?.label === '天·421', g.buckets[0]?.label)
  check('桶有完整标签', g.buckets[0]?.fullLabel === '天和 421 年', g.buckets[0]?.fullLabel)
}

{
  const old = E({
    id: 'c_old',
    type: 'character',
    name: '旧人',
    at: 'loc_yj',
    date: { era: '昭元', year: 27 },
  })
  const g = buildPresenceGrid({ ...novel, entities: [...novel.entities, old] })
  check('跨纪元产生两个桶', g.buckets.length === 2, `${g.buckets.length}`)
  check('昭元排在前面', g.buckets[0]?.fullLabel === '昭元 27 年', g.buckets[0]?.fullLabel)
}

{
  /* 持续三年的事件必须把人算在每一年里，否则围城战只有第一年有人 */
  const siege = E({
    id: 'ev_siege',
    type: 'event',
    name: '围城',
    at: 'loc_bj',
    date: { era: '天和', year: 421 },
    dateEnd: { era: '天和', year: 423 },
  })
  const soldier = E({
    id: 'c_sol',
    type: 'character',
    name: '士兵',
    links: [{ to: 'ev_siege', type: '参与' }],
  })
  const g = buildPresenceGrid({ ...novel, entities: [...novel.entities, siege, soldier] })
  check('三年事件展开成三个桶', g.buckets.length === 3, `${g.buckets.length}`)
  const solCells = g.cells.filter((c) => c.characterIds.includes('c_sol'))
  check('参与者落在每个桶里', solCells.length === 3, `${solCells.length} 格`)
  check('参与者的地点来自事件发生地',
    solCells.every((c) => c.locationKey === 'e:loc_bj'),
    solCells.map((c) => c.locationKey).join(' '))
}

/* ---------------- 2. 矩阵铺开 ---------------- */

console.log('\n[2] 矩阵铺开')

{
  const g = buildPresenceGrid(novel)
  check('四个角色都参与', g.characters.length === 4, `${g.characters.length}`)
  check('只保留真的有角色的地点', g.places.length === 2, g.places.map((l) => l.name).join(' '))
  const cell = g.cells.find((c) => c.locationKey === 'e:loc_bj')
  check('北境要塞那一格有三人', cell?.characterIds.length === 3, String(cell?.characterIds.length))
  check('格内角色按名字排序',
    cell?.characterIds[0] === 'c_lin', cell?.characterIds.join(' '))
}

{
  const ghost = E({
    id: 'c_ghost',
    type: 'character',
    name: '幽灵',
    date: { era: '天和', year: 421 },
  })
  const g = buildPresenceGrid({ ...novel, entities: [...novel.entities, ghost] })
  check('缺地点的角色被单列', g.missingLocation.some((c) => c.id === 'c_ghost'),
    g.missingLocation.map((c) => c.name).join(' '))
  check('缺地点不会让它出现在矩阵里',
    !g.cells.some((c) => c.characterIds.includes('c_ghost')))
}

{
  const timeless = E({ id: 'c_notime', type: 'character', name: '无时者', at: 'loc_bj' })
  const g = buildPresenceGrid({ ...novel, entities: [...novel.entities, timeless] })
  check('缺时间的角色被单列', g.missingTime.some((c) => c.id === 'c_notime'),
    g.missingTime.map((c) => c.name).join(' '))
  check('缺时间不会让它出现在矩阵里',
    !g.cells.some((c) => c.characterIds.includes('c_notime')))
}

/* ---------------- 3. 同处提示（核心） ---------------- */

console.log('\n[3] 同处提示（核心）')

{
  const g = buildPresenceGrid(novel)
  check('检出同处', g.coPresence.length > 0, `${g.coPresence.length} 组`)
  const bj = g.coPresence.find((c) => c.locationKey === 'e:loc_bj')
  check('北境要塞那一组含三人', bj?.characterIds.length === 3, String(bj?.characterIds.length))
  check('识别出敌对关系', bj?.tension === 'hostile', bj?.tension)
  check('敌对关系类型被带出', bj?.linkTypes.includes('敌对') === true, bj?.linkTypes.join('/'))
}

{
  /* 关系只写一边是常态（林昭写了敌对，苏无咎什么都没写），
     所以双向都必须看，否则会漏掉一半。 */
  const bj = buildPresenceGrid(novel).coPresence.find((c) => c.locationKey === 'e:loc_bj')
  check('单向书写的关系也能识别（林昭→苏无咎）',
    bj?.tension === 'hostile' && bj.linkTypes.includes('敌对'), bj?.linkTypes.join('/'))
}

{
  const g = buildPresenceGrid(novel)
  check('单人地点不产生同处提示',
    !g.coPresence.some((c) => c.locationKey === 'e:loc_yj'),
    g.coPresence.map((c) => c.locationKey).join(' '))
}

{
  /* 完全没有关系记录的两个人同处一地 —— 属于「错过的戏」，要提示 */
  const a = E({
    id: 'x1',
    type: 'character',
    name: '甲',
    at: 'loc_x',
    date: { era: '天和', year: 1 },
  })
  const b = E({
    id: 'x2',
    type: 'character',
    name: '乙',
    at: 'loc_x',
    date: { era: '天和', year: 1 },
  })
  const locx = E({ id: 'loc_x', type: 'location', name: '某地' })
  const cp = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [locx, a, b],
  }).coPresence[0]
  check('无关系的同处归类为 none', cp?.tension === 'none', cp?.tension)
  check('无关系的同处不带关系类型', cp?.linkTypes.length === 0)
}

{
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'loc_x', type: 'location', name: '某地' }),
      E({
        id: 'y1',
        type: 'character',
        name: '甲',
        at: 'loc_x',
        date: { era: '天和', year: 1 },
        links: [{ to: 'y2', type: '同僚' }],
      }),
      E({
        id: 'y2',
        type: 'character',
        name: '乙',
        at: 'loc_x',
        date: { era: '天和', year: 1 },
      }),
    ],
  })
  check('合理关系的同处归类为 other', g.coPresence[0]?.tension === 'other',
    g.coPresence[0]?.tension)
}

{
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'loc_x', type: 'location', name: '某地' }),
      E({ id: 'loc_y', type: 'location', name: '别处' }),
      E({ id: 'z1', type: 'character', name: '甲', at: 'loc_x', date: { era: '天和', year: 1 } }),
      E({ id: 'z2', type: 'character', name: '乙', at: 'loc_y', date: { era: '天和', year: 1 } }),
    ],
  })
  check('不同地点不产生同处提示', g.coPresence.length === 0, `${g.coPresence.length}`)
}

{
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'loc_x', type: 'location', name: '某地' }),
      E({ id: 'w1', type: 'character', name: '甲', at: 'loc_x', date: { era: '天和', year: 1 } }),
      E({ id: 'w2', type: 'character', name: '乙', at: 'loc_x', date: { era: '天和', year: 9 } }),
    ],
  })
  check('同一地点不同年份不产生同处提示', g.coPresence.length === 0, `${g.coPresence.length}`)
}

/* ---------------- 4. 排序与文案 ---------------- */

console.log('\n[4] 排序与文案')

{
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'loc_x', type: 'location', name: '某地' }),
      E({
        id: 'h1',
        type: 'character',
        name: '仇甲',
        at: 'loc_x',
        date: { era: '天和', year: 1 },
        links: [{ to: 'h2', type: '敌对' }],
      }),
      E({ id: 'h2', type: 'character', name: '仇乙', at: 'loc_x', date: { era: '天和', year: 1 } }),
      E({
        id: 'f1',
        type: 'character',
        name: '友甲',
        at: 'loc_x',
        date: { era: '天和', year: 1 },
        links: [{ to: 'f2', type: '同僚' }],
      }),
      E({ id: 'f2', type: 'character', name: '友乙', at: 'loc_x', date: { era: '天和', year: 1 } }),
    ],
  })
  check('敌对的排在合理关系前面', g.coPresence[0]?.tension === 'hostile',
    g.coPresence.map((c) => c.tension).join(' '))
}

{
  const bj = buildPresenceGrid(novel).coPresence.find((c) => c.locationKey === 'e:loc_bj')
  /* bj 一定存在，上面已经断言过；这里只是为了拿到文案 */
  const nameOf = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id
  const text = summarizeTension(bj!, nameOf)
  check('文案包含人名与地点', text.includes('林昭') && text.includes('北境要塞'), text)
  check('文案点明关系冲突', text.includes('敌对'), text)
}

/* ---------------- 5. 边界情况 ---------------- */

console.log('\n[5] 边界情况')

{
  const g = buildPresenceGrid({ project, outline: [], terms: [], entities: [] })
  check('空小说不崩溃', g.buckets.length === 0 && g.cells.length === 0)
  check('空小说的同处提示为空', g.coPresence.length === 0)
}

{
  /* 手改文件或旧版本留下的坏 id：长得像我们生成的 id，却谁都对不上。
     这种不能变成矩阵里一行「虚构的地点」，要算成「没有地点」。
     注意别和「作者自己写的名字」混了 —— 那种是合法地点，见第 6 节。 */
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'b1', type: 'character', name: '坏引用', at: 'e_deadbeef', date: { era: '天和', year: 1 } }),
    ],
  })
  check('指向不存在的地点不崩溃', g.cells.length === 0, `${g.cells.length}`)
  check('坏引用被归入缺地点', g.missingLocation.some((c) => c.id === 'b1'))
}

{
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'ev_noloc', type: 'event', name: '无地点事件', date: { era: '天和', year: 1 } }),
      E({ id: 'p1', type: 'character', name: '参与者', links: [{ to: 'ev_noloc', type: '参与' }] }),
    ],
  })
  check('事件无地点时参与者归入缺地点', g.missingLocation.some((c) => c.id === 'p1'),
    g.missingLocation.map((c) => c.name).join(' '))
}

{
  const g = buildPresenceGrid({
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'loc_x', type: 'location', name: '某地' }),
      E({ id: 'ev1', type: 'event', name: '事件', at: 'loc_x', date: { era: '天和', year: 1 } }),
      E({ id: 'p2', type: 'character', name: '仅盟友', links: [{ to: 'ev1', type: '盟友' }] }),
    ],
  })
  check('非「参与」关系不传递事件地点', g.missingLocation.some((c) => c.id === 'p2'),
    g.missingLocation.map((c) => c.name).join(' '))
}

{
  // 一个角色既有自己的所在地，又参与了别处的事件 → 两个地点都要出现
  const loca = E({ id: 'loc_a', type: 'location', name: '甲的驻地' })
  const locb = E({ id: 'loc_b', type: 'location', name: '乙的事件地' })
  const ev = E({
    id: 'ev2', type: 'event', name: '远征', at: 'loc_b', date: { era: '天和', year: 1 },
  })
  const hero = E({
    id: 'hero',
    type: 'character',
    name: '主角',
    at: 'loc_a',
    date: { era: '天和', year: 1 },
    links: [{ to: 'ev2', type: '参与' }],
  })
  const g = buildPresenceGrid({ project, outline: [], terms: [], entities: [loca, locb, ev, hero] })
  const heroCells = g.cells.filter((c) => c.characterIds.includes('hero'))
  check('同时出现在驻地与远征地', heroCells.length === 2, `${heroCells.length} 格`)
  check('两个地点都成为矩阵行', g.places.length === 2, g.places.map((l) => l.name).join(' '))
}

/* ---------------- 6. 发生地点不必是地点条目 ---------------- */

console.log('\n[6] 发生地点不必是地点条目')

{
  /* 界面上最容易踩空的地方：作者在地图上画了区域、或者干脆当场写了个地名，
     事件的发生地点就得认。只认地点条目的话，这些事件会在矩阵里凭空消失 ——
     看起来就是「填了但没反应」。 */
  const withMap: Project = {
    ...project,
    maps: [
      {
        id: 'map1',
        name: '天下图',
        width: 1000,
        height: 700,
        pins: [],
        regions: [{ id: 'rg_north', name: '北境', points: [] }],
      },
    ],
  }
  const regionEvent = E({
    id: 'ev_r', type: 'event', name: '雪原之战', at: 'rg_north', date: { era: '天和', year: 3 },
  })
  const textEvent = E({
    id: 'ev_t', type: 'event', name: '渡口相遇', at: '城南渡口', date: { era: '天和', year: 3 },
  })
  const hero: Entity = {
    ...E({ id: 'h1', type: 'character', name: '主角' }),
    links: [{ to: 'ev_r', type: '参与' }],
  }
  const mate: Entity = {
    ...E({ id: 'h2', type: 'character', name: '同伴' }),
    links: [{ to: 'ev_t', type: '参与' }],
  }

  const g = buildPresenceGrid({
    project: withMap,
    outline: [],
    terms: [],
    entities: [hero, mate, regionEvent, textEvent],
  })

  check('区域当发生地点的事件也进矩阵',
    g.places.some((p) => p.name === '北境'), g.places.map((p) => p.name).join(' '))
  check('自定义地名也进矩阵',
    g.places.some((p) => p.name === '城南渡口'), g.places.map((p) => p.name).join(' '))
  check('区域那一行是 region 类型（不是条目）',
    g.places.find((p) => p.name === '北境')?.kind === 'region')
  check('两个角色都被排进去了', g.characters.length === 2, `${g.characters.length} 个`)
  check('区域里的角色没有被算成「没有地点」',
    g.missingLocation.length === 0, g.missingLocation.map((c) => c.name).join(' '))

  /* 区域绑了地点条目之后，选区域和选条目必须收敛成同一行，不能出现两行「北境」 */
  const gb = buildPresenceGrid({
    project: {
      ...project,
      maps: [
        {
          id: 'map1',
          name: '天下图',
          width: 1000,
          height: 700,
          pins: [],
          regions: [{ id: 'rg_north', name: '北境', entity: 'loc_n', points: [] }],
        },
      ],
    },
    outline: [],
    terms: [],
    entities: [
      E({ id: 'loc_n', type: 'location', name: '北境城' }),
      E({ id: 'ev_a', type: 'event', name: '入城', at: 'rg_north', date: { era: '天和', year: 4 } }),
      E({ id: 'ev_b', type: 'event', name: '巡城', at: 'loc_n', date: { era: '天和', year: 4 } }),
      {
        ...E({ id: 'hb', type: 'character', name: '主角' }),
        links: [{ to: 'ev_a', type: '参与' }, { to: 'ev_b', type: '参与' }],
      },
    ],
  })
  check('绑了地点条目的区域与条目合成一行', gb.places.length === 1,
    gb.places.map((p) => p.name).join(' '))
  check('那一行用的是条目名', gb.places[0]?.name === '北境城', String(gb.places[0]?.name))
  check('两个事件落进同一格', gb.cells.length === 1, `${gb.cells.length} 格`)
}

/* ---------------- 7. 参与关系写在哪一边都算 ---------------- */

console.log('\n[7] 参与关系写在哪一边都算')

{
  /* 关系是单向书写的，两个方向都是作者真实会写的：
       角色 → 事件（在角色页写「参与 围城」）
       事件 → 角色（在事件里选「参与角色」—— 界面上现在只会写这个方向）
     只认一边的话，另一种写法会表现为「填了，但矩阵/时间线上没反应」。 */
  const loc = E({ id: 'loc_z', type: 'location', name: '要塞' })
  const ev = E({
    id: 'ev_z', type: 'event', name: '围城', at: 'loc_z', date: { era: '天和', year: 10 },
  })
  const fromEvent: Entity = {
    ...E({ id: 'c_a', type: 'character', name: '甲' }),
    // 事件侧写的关系（新的「参与角色」栏就写这个）
    at: undefined,
  }
  const evWithCast: Entity = {
    ...ev,
    links: [{ to: 'c_a', type: '参与' }],
  }

  const g1 = buildPresenceGrid({
    project, outline: [], terms: [], entities: [loc, evWithCast, fromEvent],
  })
  check('事件 → 角色的「参与」也进矩阵', g1.cells.length === 1, `${g1.cells.length} 格`)
  check('这样写的角色不算「没有地点」', g1.missingLocation.length === 0,
    g1.missingLocation.map((c) => c.name).join(' '))
  check('这样写的角色不算「没有时间」', g1.missingTime.length === 0,
    g1.missingTime.map((c) => c.name).join(' '))

  const fromCharacter: Entity = {
    ...E({ id: 'c_b', type: 'character', name: '乙' }),
    links: [{ to: 'ev_z', type: '参与' }],
  }
  const g2 = buildPresenceGrid({
    project, outline: [], terms: [], entities: [loc, ev, fromCharacter],
  })
  check('角色 → 事件的「参与」老写法照样管用', g2.cells.length === 1, `${g2.cells.length} 格`)

  /* 两边同时写同一个人，不能出现两格 */
  const both: Entity = {
    ...E({ id: 'c_c', type: 'character', name: '丙' }),
    links: [{ to: 'ev_z', type: '参与' }],
  }
  const evBoth: Entity = { ...ev, links: [{ to: 'c_c', type: '参与' }] }
  const g3 = buildPresenceGrid({
    project, outline: [], terms: [], entities: [loc, evBoth, both],
  })
  check('两边都写了同一个人，只算一格', g3.cells.length === 1, `${g3.cells.length} 格`)

  /* 别的类型的关系不算参与 */
  const wrongType: Entity = {
    ...E({ id: 'c_d', type: 'character', name: '丁' }),
    links: [{ to: 'ev_z', type: '盟友' }],
  }
  const g4 = buildPresenceGrid({
    project, outline: [], terms: [], entities: [loc, ev, wrongType],
  })
  check('「盟友」不会被当成参与', g4.cells.length === 0, `${g4.cells.length} 格`)
}

/* ============================================================
   8. 一场事件里都有谁：浮层、时间线、图谱共用这一个答案
   ============================================================ */

console.log('\n[8] 事件的参与角色（castOf）')

{
  /* 悬停浮层要写「相关角色」。它以前在这一处、那一处各算一遍，
     于是同一个事件在两个界面上给出不同的名单 —— 现在只有这一份。 */
  const loc = E({ id: 'loc_q', type: 'location', name: '渡口' })
  const plain = E({ id: 'ev_q', type: 'event', name: '夜渡', at: 'loc_q' })
  const a = E({ id: 'c_1', type: 'character', name: '甲' })
  const b = E({ id: 'c_2', type: 'character', name: '乙' })

  const fromEvent: Entity = { ...plain, links: [{ to: 'c_1', type: '参与' }] }
  const fromChar: Entity = { ...b, links: [{ to: 'ev_q', type: '参与' }] }

  const one = castOf({ project, outline: [], terms: [], entities: [loc, fromEvent, a] }, 'ev_q')
  check('写在事件那边也算', one.length === 1 && one[0].id === 'c_1', one.map((e) => e.name).join(' '))

  const two = castOf({ project, outline: [], terms: [], entities: [loc, plain, a, fromChar] }, 'ev_q')
  check('写在角色那边也算', two.length === 1 && two[0].id === 'c_2', two.map((e) => e.name).join(' '))

  const both: Entity = { ...fromChar, links: [{ to: 'ev_q', type: '参与' }] }
  const dup = castOf(
    { project, outline: [], terms: [], entities: [loc, fromEvent, a, both] },
    'ev_q',
  )
  check('两边都写同一个人不会出现两次', dup.length === 2 && new Set(dup.map((e) => e.id)).size === 2,
    dup.map((e) => e.name).join(' '))

  const placeAsCast: Entity = { ...plain, links: [{ to: 'c_1', type: '参与' }, { to: 'loc_q', type: '参与' }] }
  const onlyChars = castOf({ project, outline: [], terms: [], entities: [loc, placeAsCast, a] }, 'ev_q')
  check('非角色的「参与」不算参与角色', onlyChars.length === 1 && onlyChars[0].id === 'c_1',
    onlyChars.map((e) => e.name).join(' '))

  const none = castOf({ project, outline: [], terms: [], entities: [loc, plain, a] }, 'ev_q')
  check('没人参与时是空名单（浮层会写「还没有参与角色」）', none.length === 0)

  const missing = castOf({ project, outline: [], terms: [], entities: [loc, plain] }, 'ev_nope')
  check('事件已经不存在时不崩、返回空名单', Array.isArray(missing) && missing.length === 0)
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：在场矩阵能正确铺开，同处提示不漏报也不误报。')
  process.exit(0)
}
console.log('结论：在场矩阵或同处提示不符合预期。')
process.exit(1)
