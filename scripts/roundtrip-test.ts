/* ============================================================
   往返测试：把一份小说摊成文件，再从文件读回对象，逐项比对。

   为什么这个测试必须有：
   设定库最不可接受的失败不是界面难看，是「保存的时候悄悄丢了东西」。
   落盘逻辑一旦有损，用户要用几个月之后才发现，那时已经晚了。
   所以这里不写「应该没问题」，而是真的跑一遍并逐字段核对。

   数据是自己造的而不是引用 seed.ts，原因有二：
   1. Node 的 ESM 解析要求显式扩展名，而应用源码里的导入是给打包器看的
   2. 自造数据可以精确覆盖边界情况：空值、缺字段、同名冲突、非法文件名、
      虚构历法、跨纪元、单引号、换行正文

   跑法：node scripts/roundtrip-test.ts
   ============================================================ */

import { novelToFiles, entityFilePaths, ENTITY_DIR } from '../src/lib/novelfs.ts'
import { parseEntity } from '../src/lib/frontmatter.ts'
import type {
  CalendarSystem,
  Entity,
  Novel,
  OutlineNode,
  Project,
  Term,
} from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

/**
 * 顺序无关、且缺失等价的深比较。
 * 不能用裸 JSON.stringify 有两个原因：
 * 1. 对象键顺序取决于构造顺序，顺序不同不代表数据有损
 * 2. undefined 和 null 都是「没填」，不该判定为不一致
 */
function stable(v: unknown): string {
  if (v === null || v === undefined) return 'undefined'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'undefined'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  const obj = v as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(obj[k]))
      .join(',') +
    '}'
  )
}

/* ---------------- 测试数据 ---------------- */

const calendar: CalendarSystem = {
  name: '天和历',
  eras: [
    { name: '昭元', abbr: '昭' },
    { name: '天和', abbr: '天' },
  ],
  eraOrder: ['昭元', '天和'],
  months: [
    { name: '霜月', days: 30 },
    { name: '雪月', days: 30 },
    { name: '雁月', days: 30 },
  ],
}

const project: Project = {
  id: 'proj_test',
  title: '测试之书',
  author: '无名',
  logline: "一句话：他烧了粮仓，用的是自己的名字。'",
  linkTypes: ['亲属', '敌对', '参与'],
  fieldSchemas: { character: [{ key: '能力', label: '能力' }] },
  calendar,
  maps: [
    {
      id: 'map_1',
      name: '主图',
      width: 1600,
      height: 1000,
      pins: [{ entity: 'c1', x: 0.31, y: 0.24, label: '驻守' }],
      regions: [
        {
          id: 'r1',
          name: '北境',
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.4, y: 0.1 },
            { x: 0.4, y: 0.3 },
          ],
        },
      ],
    },
  ],
  createdAt: 1,
  updatedAt: 2,
}

function E(partial: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'name'>): Entity {
  return {
    tags: [],
    links: [],
    body: '',
    ...partial,
  }
}

const entities: Entity[] = [
  // 覆盖全部可选字段：标签、摘要、状态、自定义字段、时间段、所在地
  E({
    id: 'c1',
    type: 'character',
    name: '林昭',
    tags: ['主角', '军人'],
    summary: '一句话摘要，含逗号、冒号：和引号「测试」。',
    status: '存活',
    fields: { 能力: '寒刃。用一次躺三天。', 外貌: '左眼有疤' },
    date: { era: '天和', year: 312, month: '霜月', day: 12 },
    at: 'l1',
    body: '## 来历\n\n他有**一堆**毛病。\n\n- 第一条\n- 第二条\n\n> 引用一行\n\n写了 `代码` 和 [[苏无咎]] 的跳转。\n',
    links: [
      { to: 'c2', type: '敌对', note: '十年旧账', weight: 5 },
      { to: 'l1', type: '常驻' },
    ],
  }),
  // 最简实体：只有必填项，其余全空。这是最容易在往返中出错的形状
  E({ id: 'c2', type: 'character', name: '苏无咎' }),
  // 名字里带 Windows 非法字符
  E({ id: 'c3', type: 'character', name: 'A/B:C*D?E"F<G>H|I' }),
  // 跨纪元的时间段事件
  E({
    id: 'e1',
    type: 'event',
    name: '北境要塞陷落',
    date: { era: '昭元', year: 27, month: '雁月', day: 8, order: 0.5 },
    dateEnd: { era: '天和', year: 1, month: '霜月', day: 3 },
    at: 'l1',
    body: '正文里有换行\n\n和空行。\n',
  }),
  E({ id: 'l1', type: 'location', name: '北境要塞', tags: ['军事'] }),
  // 单引号与特殊标点，最容易破坏 YAML 标量
  E({
    id: 'i1',
    type: 'item',
    name: "寒刃's Edge",
    summary: "它叫'寒刃'，不是「冷刀」。",
    body: '',
  }),
  E({ id: 'k1', type: 'concept', name: '冰息' }),
]

const outline: OutlineNode[] = [
  {
    id: 'o1',
    kind: 'volume',
    title: '卷一 · 铁砧',
    summary: '粮道断绝。',
    status: 'drafting',
    plotlines: ['主线'],
    cast: ['c1'],
    target: 120000,
    date: { era: '天和', year: 421 },
    children: [
      {
        id: 'o2',
        kind: 'chapter',
        title: '第一章',
        summary: '',
        status: 'done',
        plotlines: [],
        cast: [],
        children: [],
      },
    ],
  },
]

const terms: Term[] = [
  {
    id: 't1',
    term: '息',
    pronunciation: 'xī',
    gloss: '寒性力量的本体',
    definition: '北境人对冰息的简称。',
    links: [{ to: 'k1', type: '参与' }],
  },
]

const original: Novel = { project, entities, outline, terms }

/* ---------------- 1. 摊成文件 ---------------- */

console.log('\n[1] 摊成文件')
const files = novelToFiles(original)
check(
  '文件数 = 实体数 + 元信息 + 大纲 + 词条',
  files.length === entities.length + 3,
  `${files.length} vs ${entities.length + 3}`,
)

const paths = files.map((f) => f.path)
check('没有重复路径', new Set(paths).size === paths.length, paths.join(' | '))

for (const [type, dir] of Object.entries(ENTITY_DIR)) {
  const expected = entities.filter((e) => e.type === type).length
  if (expected === 0) continue
  const actual = files.filter((f) => f.path.startsWith(`${dir}/`)).length
  check(`${dir}/ 下有 ${expected} 个文件`, actual === expected, `实际 ${actual}`)
}

/* ---------------- 2. 读回来 ---------------- */

console.log('\n[2] 从文件读回来')
const readBack: Entity[] = []
for (const f of files) {
  if (!f.path.endsWith('.md')) continue
  readBack.push(parseEntity(f.content, { file: f.path }))
}
check('实体总数一致', readBack.length === entities.length, `${readBack.length} vs ${entities.length}`)

/* ---------------- 3. 逐字段比对 ---------------- */

console.log('\n[3] 逐字段比对（往返必须无损）')
let mismatch = 0
const norm = (v: unknown) => (v === '' || v === undefined ? undefined : v)

for (const before of entities) {
  const after = readBack.find((e) => e.id === before.id)
  if (!after) {
    check(`实体存在: ${before.name}`, false, '读回来时丢失')
    continue
  }
  const pairs: Array<[string, unknown, unknown]> = [
    ['type', before.type, after.type],
    ['name', before.name, after.name],
    ['tags', before.tags, after.tags],
    ['summary', norm(before.summary), norm(after.summary)],
    ['status', norm(before.status), norm(after.status)],
    ['links', before.links, after.links],
    ['date', norm(before.date), norm(after.date)],
    ['dateEnd', norm(before.dateEnd), norm(after.dateEnd)],
    ['at', norm(before.at), norm(after.at)],
    ['fields', norm(before.fields), norm(after.fields)],
  ]
  for (const [label, b, a] of pairs) {
    if (stable(b) !== stable(a)) {
      mismatch++
      console.log(`    ${before.name}.${label}: ${stable(b)} → ${stable(a)}`)
    }
  }
  if (before.body.trim() !== after.body.trim()) {
    mismatch++
    console.log(`    ${before.name}.body 正文不一致`)
  }
}
check('全部实体的全部字段无损', mismatch === 0, `${mismatch} 处不一致`)

// 逐个点名最危险的几项，让失败时能立刻定位
const c1 = readBack.find((e) => e.id === 'c1')
check('虚构历法日期（纪元+月名）保住', c1?.date?.era === '天和' && c1?.date?.month === '霜月')
check('链接备注保住', c1?.links[0]?.note === '十年旧账' && c1?.links[0]?.weight === 5)
check('自定义字段保住', c1?.fields?.['能力'] === '寒刃。用一次躺三天。')
check('中文全角标点保住', c1?.summary?.includes('：') === true && c1?.summary?.includes('「') === true)
const e1 = readBack.find((e) => e.id === 'e1')
check('跨纪元时间段保住', e1?.dateEnd?.era === '天和' && e1?.date?.order === 0.5)
const i1 = readBack.find((e) => e.id === 'i1')
check("单引号正文保住", i1?.name === "寒刃's Edge" && i1?.summary?.includes("'寒刃'") === true)
check('最简实体（空数组/空字段）不产生垃圾值',
  readBack.find((e) => e.id === 'c2')?.tags.length === 0 &&
  readBack.find((e) => e.id === 'c2')?.links.length === 0)

/* ---------------- 4. 链接与文件名 ---------------- */

console.log('\n[4] 关系网与文件名')
const ids = new Set(readBack.map((e) => e.id))
const dangling = readBack.flatMap((e) => e.links.filter((l) => !ids.has(l.to)))
check('没有指向不存在实体的链接', dangling.length === 0, dangling.map((d) => d.to).join(', '))
check(
  '链接总数一致',
  entities.reduce((n, e) => n + e.links.length, 0) ===
    readBack.reduce((n, e) => n + e.links.length, 0),
)

const collide: Novel = {
  ...original,
  entities: [
    E({ id: 'd1', type: 'character', name: '同名' }),
    E({ id: 'd2', type: 'character', name: '同名' }),
    E({ id: 'd3', type: 'character', name: '同名' }),
  ],
}
check('三个同名实体得到三个不同路径', entityFilePaths(collide).size === 3,
  [...entityFilePaths(collide)].join(' | '))

const illegalPath = files.find((f) => f.path.includes('A·B'))?.path
check('Windows 非法字符已被替换', !!illegalPath, paths.filter((p) => p.includes('角色')).join(' | '))

/* ---------------- 5. 二次往返稳定 ---------------- */

console.log('\n[5] 二次往返必须与一次往返等价')
const round2 = novelToFiles({ ...original, entities: readBack })
const norm1 = files.map((f) => f.path + '\u0000' + f.content).sort().join('\n')
const norm2 = round2.map((f) => f.path + '\u0000' + f.content).sort().join('\n')
check('第二次摊出的内容与第一次完全一致（幂等）', norm1 === norm2)

/* ---------------- 6. JSON 部分 ---------------- */

console.log('\n[6] 元信息 / 大纲 / 词条')
const metaFile = files.find((f) => f.path.endsWith('novel.json'))
const meta = metaFile ? (JSON.parse(metaFile.content) as Project) : null
check('自定义历法保住（含纪元顺序与月名）',
  meta?.calendar?.months.length === calendar.months.length &&
  meta?.calendar?.eraOrder.join() === calendar.eraOrder.join())
check('关系类型词表保住', meta?.linkTypes.length === project.linkTypes.length)
check('地图图钉坐标保住', meta?.maps[0]?.pins[0]?.x === 0.31)
check('区域多边形顶点保住', meta?.maps[0]?.regions[0]?.points.length === 3)

const outlineFile = files.find((f) => f.path.endsWith('大纲.json'))
const parsedOutline = outlineFile ? (JSON.parse(outlineFile.content) as OutlineNode[]) : []
check('大纲层级结构保住',
  parsedOutline.length === 1 && parsedOutline[0].children.length === 1 &&
  parsedOutline[0].children[0].title === '第一章')
check('大纲字数目标保住', parsedOutline[0]?.target === 120000)
check('大纲剧情内时间保住', parsedOutline[0]?.date?.year === 421)

const termsFile = files.find((f) => f.path.endsWith('词条.json'))
const parsedTerms = termsFile ? (JSON.parse(termsFile.content) as Term[]) : []
check('词条保住（含读音与直译）',
  parsedTerms[0]?.term === '息' && parsedTerms[0]?.pronunciation === 'xī' &&
  parsedTerms[0]?.gloss === '寒性力量的本体')

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：落盘与读回是无损的，且二次往返幂等。')
  process.exit(0)
}
console.log('结论：存在数据丢失风险，必须修复。')
process.exit(1)
