/* ============================================================
   全文搜索的行为测试

   搜索最容易出的两类问题：
   1. 排序不可解释 —— 精确匹配排在模糊匹配后面，作者会觉得「它瞎了」
   2. 刷屏 —— 一个高频词命中同一段正文十次，把其他结果全挤掉

   这两个都不是崩溃型错误，只会让人慢慢不用这个功能，
   所以必须靠测试按住。

   跑法：由 npm test 统一触发
   ============================================================ */

import { parseSnippet, searchNovel, hitKindLabel } from '../src/lib/search.ts'
import type { Entity, Novel, OutlineNode, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

/* ---------------- 测试数据 ---------------- */

const project: Project = {
  id: 'p',
  title: '测试之书',
  linkTypes: ['敌对', '常驻'],
  fieldSchemas: {},
  calendar: { name: '历', eras: [], eraOrder: [], months: [] },
  maps: [],
  createdAt: 0,
  updatedAt: 0,
}

function E(p: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'name'>): Entity {
  return { tags: [], links: [], body: '', ...p }
}

const entities: Entity[] = [
  // 名称精确匹配 + 正文多次命中
  E({
    id: 'c1',
    type: 'character',
    name: '林昭',
    tags: ['主角'],
    summary: '北境要塞守将。',
    fields: { 能力: '寒刃。能在三息内冻结水汽。', 外貌: '左眼有一道旧疤。' },
    links: [{ to: 'c2', type: '敌对', note: '十年前那场审判的当事人' }],
    body: '他守了十年的要塞。\n霜月里，他第一次决定不再守了。\n要塞的雪比往年厚。',
  }),
  // 名称只是包含关系
  E({ id: 'c2', type: 'character', name: '苏无咎', body: '他认识林昭，但从不提起。' }),
  // 完全不相关，用于验证不被误命中
  E({ id: 'c3', type: 'character', name: '沈雁', body: '她只管北门。' }),
  // 只在自定义字段里命中
  E({
    id: 'i1',
    type: 'item',
    name: '寒刃',
    fields: { 来历: '由一副破冰锥重新锻成，本身就是冷兵器。' },
  }),
]

const outline: OutlineNode[] = [
  {
    id: 'o1',
    kind: 'volume',
    title: '卷一 · 铁砧',
    summary: '粮道断绝，要塞开始吃存粮。',
    status: 'done',
    plotlines: ['主线'],
    cast: [],
    children: [
      {
        id: 'o2',
        kind: 'chapter',
        title: '第一章',
        summary: '云绮的商队带来最后一批粮。',
        status: 'idea',
        plotlines: [],
        cast: [],
        children: [],
      },
    ],
  },
]

/* 词条（term）已经不单列：字典并进了「概念」条目，词就是条目，
   条目本来就搜得到。所以这里不再摆词条数据。 */
const novel: Novel = { project, entities, outline, terms: [] }

/* ---------------- 1. 能搜到该搜的 ---------------- */

console.log('\n[1] 覆盖全部字段')

{
  const r = searchNovel(novel, '林昭')
  check('搜索能命中条目', r.length > 0, `命中 ${r.length}`)
  check('名称字段有结果', r.some((h) => h.field === 'name' && h.id === 'c1'))
  check('正文里提到林昭的条目也被搜到', r.some((h) => h.id === 'c2' && h.field === 'body'),
    r.map((h) => `${h.id}:${h.field}`).join(' '))
}

check('能按名字的一部分搜到', searchNovel(novel, '无咎').some((h) => h.field === 'name' && h.id === 'c2'),
  searchNovel(novel, '无咎').map((h) => h.id + ':' + h.field).join(' '))
check('能搜标签', searchNovel(novel, '主角').some((h) => h.field === 'tag' && h.id === 'c1'))
check('能搜一句话摘要', searchNovel(novel, '守将').some((h) => h.field === 'summary' && h.id === 'c1'))
check('能搜自定义字段', searchNovel(novel, '三息').some((h) => h.field === 'field' && h.id === 'c1'),
  searchNovel(novel, '三息').map((h) => h.id + ':' + h.field).join(' '))
check('能搜关系备注', searchNovel(novel, '审判').some((h) => h.field === 'linkNote' && h.id === 'c1'),
  searchNovel(novel, '审判').map((h) => h.id + ':' + h.field).join(' '))
check('能搜大纲', searchNovel(novel, '粮道').some((h) => h.kind === 'outline' && h.id === 'o1'),
  searchNovel(novel, '粮道').map((h) => h.kind + ':' + h.id).join(' '))
check('能搜大纲深处的子节点', searchNovel(novel, '商队').some((h) => h.id === 'o2'),
  searchNovel(novel, '商队').map((h) => h.id).join(' '))
check('能搜物品的自定义字段', searchNovel(novel, '破冰锥').some((h) => h.id === 'i1'),
  searchNovel(novel, '破冰锥').map((h) => h.id).join(' '))

/* ---------------- 2. 排序必须可解释 ---------------- */

console.log('\n[2] 排序可解释性')

{
  // 「寒刃」既是物品的名称（精确），也出现在角色的能力字段里
  const r = searchNovel(novel, '寒刃')
  check('精确名称匹配排第一', r[0]?.id === 'i1' && r[0]?.field === 'name',
    r.slice(0, 3).map((h) => `${h.id}:${h.field}:${h.score}`).join(' | '))
  check('自定义字段命中排在名称之后', r.findIndex((h) => h.id === 'c1') > 0)
}

{
  const r = searchNovel(novel, '林昭')
  const nameIdx = r.findIndex((h) => h.field === 'name')
  const bodyIdx = r.findIndex((h) => h.field === 'body')
  check('名称命中排在正文命中之前', nameIdx !== -1 && (bodyIdx === -1 || nameIdx < bodyIdx),
    `${nameIdx} vs ${bodyIdx}`)
}

/* ---------------- 3. 不能刷屏 ---------------- */

console.log('\n[3] 同一字段只给一条结果')

{
  // 造一个高频词：在正文里出现很多次
  const spammy: Novel = {
    ...novel,
    entities: [
      E({
        id: 'x1',
        type: 'character',
        name: '甲',
        body: '要塞。'.repeat(30) + '别的句子。',
      }),
      E({ id: 'x2', type: 'character', name: '乙', body: '他也提过一次要塞。' }),
    ],
  }
  const r = searchNovel(spammy, '要塞')
  const forX1 = r.filter((h) => h.id === 'x1')
  check('同一实体的正文只产生一条结果', forX1.length === 1, `${forX1.length} 条`)
  check('但仍报告总命中次数', (forX1[0]?.totalMatches ?? 0) >= 30,
    String(forX1[0]?.totalMatches))
  check('不会把其他条目挤掉', r.some((h) => h.id === 'x2'))
}

/* ---------------- 4. 上下文片段 ---------------- */

console.log('\n[4] 片段与高亮标记')

{
  const r = searchNovel(novel, '霜月')
  const hit = r.find((h) => h.id === 'c1')
  check('正文命中带出上下文片段', !!hit && hit.snippet.includes('⟪霜月⟫'), hit?.snippet)
  check('片段里包含命中词周围的字', !!hit && hit.snippet.includes('第一次决定'),
    hit?.snippet)
}

{
  const parts = parseSnippet('前面⟪命中⟫后面')
  check('parseSnippet 切成三段', parts.length === 3, JSON.stringify(parts))
  check('标记段被识别为命中', parts[1]?.hit === true && parts[1]?.text === '命中')
  check('普通段不是命中', parts[0]?.hit === false && parts[0]?.text === '前面')
  check('无标记时原样返回', parseSnippet('没有标记').length === 1)
}

{
  // 命中的词在长文中间时，片段两端要有省略号
  const long: Novel = {
    ...novel,
    entities: [E({ id: 'y1', type: 'character', name: '丙', body: '前'.repeat(200) + '目标词' + '后'.repeat(200) })],
  }
  const r = searchNovel(long, '目标词')
  check('片段两端加省略号', r[0]?.snippet.startsWith('…') === true && r[0]?.snippet.endsWith('…') === true,
    r[0]?.snippet)
}

/* ---------------- 5. 边界情况 ---------------- */

console.log('\n[5] 边界情况')

check('空查询返回空结果', searchNovel(novel, '').length === 0)
check('只有空格返回空结果', searchNovel(novel, '   ').length === 0)
check('搜不到的词返回空数组', searchNovel(novel, '这个词绝对不存在').length === 0)

{
  // 正则元字符不能导致崩溃（我们用的是 indexOf，但查询里带这些字符仍要安全）
  const r = searchNovel(novel, '.*+?[]()')
  check('含正则元字符的查询不崩溃', Array.isArray(r))
}

{
  // 大小写不敏感（英文内容）
  const en: Novel = {
    ...novel,
    entities: [E({ id: 'z1', type: 'character', name: 'Alice', body: 'She met BOB here.' })],
  }
  check('英文搜索大小写不敏感（名称）', searchNovel(en, 'alice').length > 0)
  check('英文搜索大小写不敏感（正文）', searchNovel(en, 'bob').some((h) => h.id === 'z1' && h.field === 'body'),
    searchNovel(en, 'bob').map((h) => h.id + ':' + h.field).join(' '))
}

{
  // limit 生效
  const many: Novel = {
    ...novel,
    entities: Array.from({ length: 120 }, (_, i) =>
      E({ id: `m${i}`, type: 'character', name: `角色${i}`, body: '共同的词' }),
    ),
  }
  check('结果数量受 limit 限制', searchNovel(many, '共同的词', 10).length === 10,
    String(searchNovel(many, '共同的词', 10).length))
  check('默认上限是 40', searchNovel(many, '共同的词').length === 40,
    String(searchNovel(many, '共同的词').length))
}

check('hitKindLabel 覆盖大纲与词条',
  hitKindLabel('outline') === '大纲' &&
  hitKindLabel('character') === '角色')

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：全文搜索覆盖全部字段，排序可解释，且不会刷屏。')
  process.exit(0)
}
console.log('结论：搜索行为不符合预期。')
process.exit(1)
