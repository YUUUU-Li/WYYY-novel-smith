/* ============================================================
   字典并进「概念」：迁移不丢东西，断链说得清

   这一组防的是三件安静坏掉的事：
   · 老作品里的词在迁移时被丢掉（内容没了，界面上也没有任何痕迹）
   · 迁移不幂等：每开一次就多出一套同名条目
   · 断链检查只看「自造词」，或者干脆和跳转用两套判断

   跑法：由 npm test 统一触发
   ============================================================ */

import { migrateTerms } from '../src/lib/terms-migration.ts'
import { unresolvedLinks } from '../src/lib/wiki-links.ts'
import { DEFAULT_CALENDAR } from '../src/lib/types.ts'
import type { Entity, Novel, Project, Term } from '../src/lib/types.ts'

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
  fieldSchemas: { concept: [{ key: '规则', label: '规则' }] },
  calendar: DEFAULT_CALENDAR,
  maps: [],
  boards: [],
  folders: [],
  rootItems: [],
  createdAt: 0,
  updatedAt: 0,
}

function E(p: Partial<Entity> & Pick<Entity, 'id' | 'name'>): Entity {
  return { type: 'character', tags: [], links: [], body: '', ...p }
}

function term(p: Partial<Term> & Pick<Term, 'id' | 'term'>): Term {
  return { definition: '', links: [], ...p }
}

/* ============================================================
   1. 词 → 概念条目
   ============================================================ */

console.log('\n[1] 词变成概念条目，字段一个都不少')

{
  const novel: Novel = {
    project,
    entities: [E({ id: 'c1', name: '林昭' })],
    outline: [],
    terms: [
      term({
        id: 't1',
        term: '息',
        pronunciation: 'xī',
        gloss: 'breath',
        definition: '这个世界的原初力量。',
      }),
    ],
  }

  const r = migrateTerms(novel)
  const created = r.novel.entities.find((e) => e.name === '息')
  check('改出一个概念条目', created?.type === 'concept', String(created?.type))
  check('定义进了正文', created?.body === '这个世界的原初力量。', String(created?.body))
  check('读音进了自定义字段', created?.fields?.['读音'] === 'xī', JSON.stringify(created?.fields))
  check('直译进了自定义字段', created?.fields?.['直译'] === 'breath', JSON.stringify(created?.fields))
  check('直译同时是一句话摘要', created?.summary === 'breath', String(created?.summary))
  check('词条列表清空（不留第二份真相）', r.novel.terms.length === 0, String(r.novel.terms.length))
  check('原来就有的条目还在', r.novel.entities.some((e) => e.id === 'c1'))
  check('报告说迁移了 1 个', r.migrated === 1, String(r.migrated))
  check('changed 为 true（调用方据此落盘）', r.changed)
  check('概念类型补上了「读音」「直译」', (() => {
    const keys = (r.novel.project.fieldSchemas.concept ?? []).map((f) => f.key)
    return keys.includes('读音') && keys.includes('直译') && keys.includes('规则')
  })(), JSON.stringify(r.novel.project.fieldSchemas.concept))
}

/* ============================================================
   2. 幂等：再跑一遍什么都不该变
   ============================================================ */

console.log('\n[2] 幂等')

{
  const novel: Novel = {
    project,
    entities: [],
    outline: [],
    terms: [term({ id: 't1', term: '岁末月', definition: '一年最后一个月。' })],
  }
  const once = migrateTerms(novel)
  const twice = migrateTerms(once.novel)
  check('第二遍不再新建条目', twice.migrated === 0, String(twice.migrated))
  check('第二遍 changed 为 false', twice.changed === false)
  check('条目不重复', twice.novel.entities.filter((e) => e.name === '岁末月').length === 1,
    String(twice.novel.entities.length))
  check('第二遍拿回同一个对象（不做无谓的重建）', twice.novel === once.novel)
}

{
  // 本来就是干净的：一个字段都不该被塞进去
  const clean: Novel = {
    project: { ...project, fieldSchemas: { concept: [{ key: '读音', label: '读音' }, { key: '直译', label: '直译' }] } },
    entities: [],
    outline: [],
    terms: [],
  }
  const r = migrateTerms(clean)
  check('干净的作品原样返回（不是每次都重建一次）', r.novel === clean && r.changed === false)
}

/* ============================================================
   3. 同名条目已存在：并进去，不造第二个同名页
   ============================================================ */

console.log('\n[3] 名字已经被占了')

{
  const existing = E({ id: 'c2', name: '成刃', body: '原本写的一段。' })
  const novel: Novel = {
    project,
    entities: [existing],
    outline: [],
    terms: [term({ id: 't1', term: '成刃', pronunciation: 'chéng rèn', definition: '把息压进刀里。' })],
  }
  const r = migrateTerms(novel)
  const still = r.novel.entities.filter((e) => e.name === '成刃')
  check('不会造出第二个同名条目', still.length === 1, String(still.length))
  check('原来的正文没被覆盖', (still[0].body ?? '').includes('原本写的一段。'), String(still[0].body))
  check('词里的定义也进来了（没丢内容）', (still[0].body ?? '').includes('把息压进刀里。'),
    String(still[0].body))
  check('读音挂到了这个条目上', still[0].fields?.['读音'] === 'chéng rèn',
    JSON.stringify(still[0].fields))
  check('报告说并进了 1 个', r.mergedIntoExisting === 1, String(r.mergedIntoExisting))
}

/* ============================================================
   4. 关系类型：词和条目的关系落成「相关」，不是「参与」
   ============================================================ */

console.log('\n[4] 关系类型')

{
  const novel: Novel = {
    project,
    entities: [E({ id: 'c1', name: '林昭' })],
    outline: [],
    terms: [
      term({
        id: 't1',
        term: '息',
        definition: '原初力量。',
        // 老字典把这件事写成了「参与」，对词讲不通
        links: [{ to: 'c1', type: '参与' }],
      }),
    ],
  }
  const r = migrateTerms(novel)
  const created = r.novel.entities.find((e) => e.name === '息')
  check('关系还在（没把作者的连线丢掉）', created?.links.length === 1, JSON.stringify(created?.links))
  check('关系指向原来那个条目', created?.links[0].to === 'c1', JSON.stringify(created?.links))
  check('关系类型落成「相关」', created?.links[0].type === '相关', String(created?.links[0].type))
}

/* ============================================================
   5. 断链：[[双括号]] 指向不存在的东西
   ============================================================ */

console.log('\n[5] 断链检查')

{
  const novel: Novel = {
    project,
    entities: [
      E({ id: 'c1', name: '林昭', body: '他和[[苏无咎]]在[[北境要塞]]见过[[雪原]]两次。[[雪原]]很冷。' }),
      E({ id: 'c2', name: '苏无咎', body: '[[林昭]]的朋友。' }),
      E({ id: 'c3', name: '北境要塞', type: 'location', body: '' }),
    ],
    outline: [],
    terms: [],
  }
  const broken = unresolvedLinks(novel)
  console.log('    断链：', JSON.stringify(broken))
  check('只报真正解析不到的', broken.length === 1, JSON.stringify(broken.map((b) => b.name)))
  check('报的是那个词', broken[0]?.name === '雪原', String(broken[0]?.name))
  check('数了出现次数', broken[0]?.count === 2, String(broken[0]?.count))
  check('记着它是从哪个条目里来的', broken[0]?.sources[0]?.id === 'c1',
    JSON.stringify(broken[0]?.sources))
}

{
  // 带显示文字、跨行、空括号、自己指自己
  const novel: Novel = {
    project,
    entities: [
      E({ id: 'c1', name: '林昭', body: '[[雪原|那片雪原]] 和 [[林昭]] 不算断链。\n[[雪原]] 再来一次。' }),
      E({ id: 'c2', name: '另一个', body: '[[  ]] 空的不用管。[[  雪原  ]] 前后有空格。' }),
    ],
    outline: [],
    terms: [],
  }
  const broken = unresolvedLinks(novel)
  check('带显示文字的也算（按竖线前面的名字）', broken.some((b) => b.name === '雪原'),
    JSON.stringify(broken.map((b) => b.name)))
  check('指向自己的不算断链', !broken.some((b) => b.name === '林昭'), JSON.stringify(broken.map((b) => b.name)))
  check('空的 [[ ]] 不算', !broken.some((b) => b.name === ''), JSON.stringify(broken.map((b) => b.name)))
  check('两处都算次数（同名聚合成一条）', broken.find((b) => b.name === '雪原')?.count === 3,
    String(broken.find((b) => b.name === '雪原')?.count))
  check('前后空格的同一个词仍算同一个', broken.filter((b) => b.name === '雪原').length === 1,
    JSON.stringify(broken.map((b) => b.name)))
}

{
  const clean: Novel = {
    project,
    entities: [E({ id: 'c1', name: '林昭', body: '什么都没有。' })],
    outline: [],
    terms: [],
  }
  check('没有双括号时返回空列表', unresolvedLinks(clean).length === 0)
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：词并进条目没丢东西，断链数得清，迁移是幂等的。')
  process.exit(0)
}
console.log('结论：字典合并或断链检查不符合预期。')
process.exit(1)
