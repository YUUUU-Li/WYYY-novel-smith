/* ============================================================
   设定页组织结构的测试

   这一层的坏法都是「东西不见了」，不报错、不崩溃：
     · 把夹子拖进自己的子孙 → 整棵子树从界面上消失
     · 删夹子顺手删掉里面的角色 → 数据没了
     · 一个条目同时躺在两个夹子的数组里 → 显示两次，改哪个都不对
   所以每一条都要钉住。

   跑法：由 npm test 统一触发
   ============================================================ */

import {
  ROOT,
  ancestorPath,
  containerOf,
  containersOf,
  countEntities,
  countOwnEntities,
  deleteFolder,
  descendantFolderIds,
  findFolder,
  isFolderId,
  materializeRoot,
  moveItem,
  newFolder,
  normalizeOrg,
  placeItem,
  rawItems,
  reorderVisible,
  resolveContainer,
  unplaceItem,
  wouldCycle,
} from '../src/lib/org.ts'
import type { Entity, EntityFolder, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

function E(id: string, name: string): Entity {
  return { id, type: 'character', name, tags: [], links: [], body: '' }
}

function F(id: string, name: string, items: string[] = []): EntityFolder {
  return { id, name, items }
}

function P(folders: EntityFolder[], rootItems: string[]): Project {
  return {
    id: 'p',
    title: '书',
    linkTypes: [],
    fieldSchemas: {},
    calendar: { name: 'c', eras: [], eraOrder: [], months: [] },
    maps: [],
    folders,
    rootItems,
    createdAt: 0,
    updatedAt: 0,
  }
}

const novel = {
  entities: [E('a', '阿甲'), E('b', '阿乙'), E('c', '阿丙'), E('d', '阿丁')],
}

const names = (items: ReturnType<typeof resolveContainer>) =>
  items.map((i) => (i.kind === 'folder' ? `[${i.folder.name}]` : i.entity.name)).join(' ')

/* ---------------- 1. 容器解析 ---------------- */

console.log('\n[1] 一个容器里有什么、按什么顺序')

{
  const p = P([F('f1', '人物', ['b', 'a'])], ['d', 'f1'])
  // 注意 c 没被任何地方认领，会补在顶层末尾
  check('顶层按 rootItems 的顺序，没认领的补在后面',
    names(resolveContainer(p, novel, ROOT)) === '阿丁 [人物] 阿丙',
    names(resolveContainer(p, novel, ROOT)))
  check('夹子里按自己的 items 顺序', names(resolveContainer(p, novel, 'f1')) === '阿乙 阿甲',
    names(resolveContainer(p, novel, 'f1')))
}

{
  // c 没被任何夹子列过 —— 必须出现在顶层，不能凭空消失
  const p = P([F('f1', '人物', ['a'])], ['f1'])
  const top = resolveContainer(p, novel, ROOT)
  // 丙(bǐng) < 丁(dīng) < 乙(yǐ)，按拼音排就是这个顺序
  check('没被认领的条目补在顶层末尾', names(top) === '[人物] 阿丙 阿丁 阿乙', names(top))
  check('补进来的按拼音排序',
    top.filter((i) => i.kind === 'entity').map((i) => i.id).join('') === 'cdb',
    top.map((i) => i.id).join(''))
  check('夹子里的条目不会同时出现在顶层', !top.some((i) => i.id === 'a'))
}

{
  const p = P([F('f1', '人物', ['a', '不存在', 'b'])], ['f1', '也没有这个'])
  // 「也没有这个」认不到东西，静默跳过；但 a/b 被 f1 认领、c/d 仍是孤儿
  const top = resolveContainer(p, novel, ROOT)
  check('顶层里指不到的 id 不显示',
    !top.some((i) => i.id === '也没有这个') && top[0]?.id === 'f1',
    top.map((i) => i.id).join(','))
  check('夹子里指不到的也跳过', names(resolveContainer(p, novel, 'f1')) === '阿甲 阿乙',
    names(resolveContainer(p, novel, 'f1')))
}

{
  const p = P([F('f1', '人物', ['a', 'a'])], ['f1'])
  check('同一个 id 写两遍只显示一次', names(resolveContainer(p, novel, 'f1')) === '阿甲',
    names(resolveContainer(p, novel, 'f1')))
}

{
  // 环：f1 里有 f2，f2 里又有 f1。很可能是手工改文件改出来的
  const p = P([F('f1', '甲', ['f2']), F('f2', '乙', ['f1'])], ['f1'])
  check('有环时不死循环', resolveContainer(p, novel, 'f1').length >= 1)
  check('有环时 countEntities 也能返回', countEntities(p, novel, 'f1') >= 0)
}

/* ---------------- 2. 身份查询 ---------------- */

console.log('\n[2] 谁在哪儿')

{
  const p = P([F('f1', '人物', ['a']), F('f2', '地名', ['b'])], ['d', 'f1', 'f2'])
  check('条目在夹子里', containerOf(p, 'a') === 'f1', String(containerOf(p, 'a')))
  check('条目在顶层', containerOf(p, 'd') === ROOT, String(containerOf(p, 'd')))
  check('夹子也在顶层', containerOf(p, 'f1') === ROOT, String(containerOf(p, 'f1')))
  check('不存在的 id 返回 undefined', containerOf(p, 'zzz') === undefined)
  check('isFolderId 认得夹子', isFolderId(p, 'f1') && !isFolderId(p, 'a'))
}

{
  const p = P([F('f1', '甲', ['f2']), F('f2', '乙', ['f3']), F('f3', '丙', [])], ['f1'])
  check('子孙夹是两层的', descendantFolderIds(p, 'f1').size === 2,
    [...descendantFolderIds(p, 'f1')].join(','))
  check('祖先链从上往下', ancestorPath(p, 'f3').join('>') === 'f1>f2', ancestorPath(p, 'f3').join('>'))
  check('顶层没有祖先', ancestorPath(p, ROOT).length === 0)
}

/* ---------------- 3. 移动 ---------------- */

console.log('\n[3] 挪位置')

{
  const p = P([], ['a', 'b', 'c'])
  const next = moveItem(p, 'c', ROOT, 0)
  check('顶层内往前挪', next.rootItems.join('') === 'cab', next.rootItems.join(''))
}

{
  const p = P([], ['a', 'b', 'c'])
  const next = moveItem(p, 'a', ROOT, 2)
  check('挪到末尾', next.rootItems.join('') === 'bca', next.rootItems.join(''))
  const beyond = moveItem(p, 'a', ROOT, 99)
  check('index 超界不报错，落到末尾', beyond.rootItems.join('') === 'bca', beyond.rootItems.join(''))
  const negative = moveItem(p, 'a', ROOT, -5)
  check('index 为负不报错，落到开头', negative.rootItems.join('') === 'abc', negative.rootItems.join(''))
}

{
  const p = P([F('f1', '人物', []), F('f2', '地名', [])], ['f1', 'f2', 'a'])
  const next = moveItem(p, 'a', 'f1', 0)
  check('从顶层挪进夹子', rawItems({ ...p, ...next }, 'f1').join('') === 'a')
  check('挪进去之后顶层就没有了', !next.rootItems.includes('a'), next.rootItems.join(','))
}

{
  const p = P([F('f1', '人物', ['a']), F('f2', '地名', ['b'])], ['f1', 'f2'])
  const next = moveItem(p, 'a', 'f2', 1)
  check('从一个夹子挪到另一个夹子', rawItems({ ...p, ...next }, 'f2').join('') === 'ba',
    rawItems({ ...p, ...next }, 'f2').join(''))
  check('原夹子里不再有它', rawItems({ ...p, ...next }, 'f1').join('') === '', rawItems({ ...p, ...next }, 'f1').join(''))
}

{
  // 最要命的一条：一个 id 绝对不能同时出现在两个容器里
  const p = P([F('f1', '人物', ['a']), F('f2', '地名', ['a'])], ['f1', 'f2', 'a'])
  const next = moveItem(p, 'a', 'f1', 0)
  const all = [...rawItems({ ...p, ...next }, ROOT), ...next.folders.flatMap((f) => f.items)]
  check('移动后这个 id 在所有容器里只出现一次',
    all.filter((x) => x === 'a').length === 1, all.join(','))
}

{
  const p = P([F('f1', '甲', [])], ['f1'])
  const next = moveItem(p, 'f1', 'f1', 0)
  check('夹子不能进自己', next.rootItems.join('') === 'f1', next.rootItems.join(''))
}

{
  const p = P([F('f1', '甲', ['f2']), F('f2', '乙', [])], ['f1'])
  check('识别出「夹子进自己子孙」', wouldCycle(p, 'f1', 'f2'))
  const next = moveItem(p, 'f1', 'f2', 0)
  check('夹子不能进自己的子孙',
    next.rootItems.join('') === 'f1' && next.folders.find((f) => f.id === 'f2')!.items.length === 0,
    next.rootItems.join(',') + ' / ' + next.folders.find((f) => f.id === 'f2')!.items.join(','))
  check('条目之间不存在环的问题', !wouldCycle(p, 'a', 'f1'))
}

{
  const p = P([F('f1', '甲', [])], ['f1', 'a'])
  const next = moveItem(p, 'a', 'nope', 0)
  check('挪到不存在的容器 = 什么都不做', next.rootItems.join('') === 'f1a', next.rootItems.join(''))
}

/* ---------------- 4. 删除夹子 ---------------- */

console.log('\n[4] 删夹子不能把里面的东西一起删掉')

{
  const p = P([F('f1', '人物', ['a', 'b']), F('f2', '地名', ['c'])], ['f1', 'd', 'f2'])
  const next = deleteFolder(p, 'f1')
  const top = resolveContainer({ ...p, ...next }, novel, ROOT)
  check('夹子没了', !next.folders.some((f) => f.id === 'f1'))
  check('里面的条目上交到原来那一层', next.rootItems.join(',') === 'a,b,d,f2', next.rootItems.join(','))
  check('上交后仍然看得见', names(top).includes('阿甲') && names(top).includes('阿乙'), names(top))
  check('别的夹子不受影响', next.folders.find((f) => f.id === 'f2')!.items.join('') === 'c')
}

{
  // 删嵌套的夹子：里面的东西交给它的上级，不是交给顶层
  const p = P([F('f1', '外', ['f2', 'a']), F('f2', '内', ['b'])], ['f1'])
  const next = deleteFolder(p, 'f2')
  check('子夹的东西交给父夹', next.folders.find((f) => f.id === 'f1')!.items.join(',') === 'b,a',
    next.folders.find((f) => f.id === 'f1')!.items.join(','))
  check('顶层不受影响', next.rootItems.join('') === 'f1', next.rootItems.join(''))
}

{
  const p = P([F('f1', '甲', ['f2']), F('f2', '乙', ['a'])], ['f1'])
  const next = deleteFolder(p, 'f1')
  // f1 在顶层，它里面的 f2 上交到顶层；f2 里还有 a，a 跟着 f2 走
  check('删外层夹子时子夹也一并上交', next.rootItems.join(',') === 'f2', next.rootItems.join(','))
  check('子夹里的条目还在', rawItems({ ...p, ...next }, 'f2').join('') === 'a')
}

{
  const p = P([F('f1', '甲', ['a'])], ['f1'])
  check('删不存在的夹子不出事', deleteFolder(p, 'zzz').folders.length === 1)
}

/* ---------------- 5. 计数与兼容 ---------------- */

console.log('\n[5] 计数与老文件兼容')

{
  const p = P([F('f1', '外', ['f2', 'a']), F('f2', '内', ['b', 'c'])], ['f1', 'd'])
  check('含子孙的条目数', countEntities(p, novel, 'f1') === 3, String(countEntities(p, novel, 'f1')))
  check('内层只有两个', countEntities(p, novel, 'f2') === 2, String(countEntities(p, novel, 'f2')))
  check('空夹子是 0', countEntities(p, novel, '不存在') === 0)
}

{
  // 老 novel.json 里没有 folders / rootItems
  const legacy = {
    id: 'p', title: '书', linkTypes: [], fieldSchemas: {},
    calendar: { name: 'c', eras: [], eraOrder: [], months: [] },
    maps: [], createdAt: 0, updatedAt: 0,
  } as unknown as Project
  const n = normalizeOrg(legacy)
  check('老文件补出空 folders', Array.isArray(n.folders) && n.folders.length === 0)
  check('老文件补出空 rootItems', Array.isArray(n.rootItems) && n.rootItems.length === 0)
  check('老文件里所有条目都落在顶层',
    resolveContainer(n, novel, ROOT).length === 4, String(resolveContainer(n, novel, ROOT).length))
}

{
  // 字段类型被写坏
  const broken = {
    id: 'p', title: '书', linkTypes: [], fieldSchemas: {},
    calendar: { name: 'c', eras: [], eraOrder: [], months: [] },
    maps: [], folders: [null, { id: 'f1' }, { id: 'f2', name: '好的', items: ['a', 3, null] }],
    rootItems: ['a', 7], createdAt: 0, updatedAt: 0,
  } as unknown as Project
  const n = normalizeOrg(broken)
  check('坏掉的夹子条目被丢掉', n.folders.length === 2, String(n.folders.length))
  check('没有名字的夹子有兜底名字', n.folders[0].name === '未命名词条夹', n.folders[0].name)
  check('items 里的非字符串被过滤', n.folders[1].items.join(',') === 'a', n.folders[1].items.join(','))
  /* a 同时出现在夹子和顶层：条目允许摆在多处，所以它两边都留着 */
  check('rootItems 里的非字符串被过滤', n.rootItems.join(',') === 'a', n.rootItems.join(','))
}

{
  /* 曾经有个 bug 会把同一个 id 写进容器两次，症状就是「夹子里的条目数
     比实际多」。用户手里的旧文件已经坏了，所以读进来时要就地修掉。

     注意「跨夹子重复」现在要分成两种：
       · 条目 —— 合法（同一个条目可以在好几个夹子里露头）
       · 词条夹 —— 仍然是坏数据，子树会被数两遍 */
  const bad = {
    id: 'p', title: '书', linkTypes: [], fieldSchemas: {},
    calendar: { name: 'c', eras: [], eraOrder: [], months: [] },
    maps: [],
    folders: [
      { id: 'f1', name: '宋国', items: ['a', 'b', 'a', 'c'] }, // 同一个夹子里重复
      { id: 'f2', name: '子夹', items: ['b', 'd', 'f1'] }, // b 在 f1 里也有；f1 是夹子
    ],
    rootItems: ['e', 'e', 'f1', 'f1'],
    createdAt: 0, updatedAt: 0,
  } as unknown as Project
  const n = normalizeOrg(bad)
  check('夹子里的重复被去掉', n.folders[0].items.join(',') === 'a,b,c', n.folders[0].items.join(','))
  check('条目在两个夹子里各有一份是合法的',
    n.folders[1].items.join(',') === 'b,d,f1', n.folders[1].items.join(','))
  check('同一个夹子不许横跨两处', n.rootItems.join(',') === 'e', n.rootItems.join(','))
  check('每个容器内部都没有重复', (() => {
    const containers = [n.rootItems, ...n.folders.map((f) => f.items)]
    return containers.every((arr) => new Set(arr).size === arr.length)
  })())
  check('干净的数据不会被复制一份（保持同一个对象）', normalizeOrg(n) === n)
}

console.log('\n[5b] 同一个条目可以摆在多处')

{
  const p = P([F('f1', '齐国', []), F('f2', '宋国', [])], [])
  const novelWith = { entities: [E('war', '齐国伐宋'), E('a', '别的')] }

  const one = { ...p, ...placeItem(p, 'war', 'f1') }
  check('放进第一个夹子', rawItems(one, 'f1').join(',') === 'war', rawItems(one, 'f1').join(','))

  const two = { ...one, ...placeItem(one, 'war', 'f2') }
  check('再放一份进第二个夹子，原来那份还在',
    rawItems(two, 'f1').join(',') === 'war' && rawItems(two, 'f2').join(',') === 'war',
    `${rawItems(two, 'f1').join(',')} / ${rawItems(two, 'f2').join(',')}`)
  check('同一个条目在两个夹子里都数得到',
    countEntities(two, novelWith, 'f1') === 1 && countEntities(two, novelWith, 'f2') === 1)
  check('全书总数还是 1 个条目（不是复制成两个）', novelWith.entities.length === 1 + 1)
  check('知道它摆在哪几处', containersOf(two, 'war').join(',') === 'f1,f2',
    containersOf(two, 'war').join(','))

  check('重复放进同一个夹子不会加第二份',
    rawItems({ ...two, ...placeItem(two, 'war', 'f1') }, 'f1').join(',') === 'war',
    rawItems({ ...two, ...placeItem(two, 'war', 'f1') }, 'f1').join(','))

  const off = { ...two, ...unplaceItem(two, 'war', 'f2') }
  check('撤掉一处，另一处不动',
    rawItems(off, 'f2').join(',') === '' && rawItems(off, 'f1').join(',') === 'war',
    `${rawItems(off, 'f1').join(',')} / ${rawItems(off, 'f2').join(',')}`)
  check('撤掉之后只剩一处', containersOf(off, 'war').join(',') === 'f1', containersOf(off, 'war').join(','))

  /* 夹子不能被这样复制：子树会数两遍 */
  const withFolder = { ...p, ...placeItem(p, 'f1', 'f2') }
  check('夹子不能靠 placeItem 复制一份', rawItems(withFolder, 'f2').join(',') === '',
    rawItems(withFolder, 'f2').join(','))
}

console.log('\n[5c] 拖动只搬当前这一份')

{
  /* 齐国伐宋摆在齐国和宋国两处。在宋国那张卡片上把它拖到顶层，
     搬走的应该只是「宋国里的那一份」—— 齐国里那份不该跟着消失。 */
  const p = P([F('f1', '齐国', []), F('f2', '宋国', [])], ['x'])
  const both = { ...p, ...placeItem({ ...p, ...placeItem(p, 'war', 'f1') }, 'war', 'f2') }
  const moved = { ...both, ...moveItem(both, 'war', ROOT, 0, 'f2') }
  check('宋国那一份搬去顶层了', rawItems(moved, ROOT).includes('war'), rawItems(moved, ROOT).join(','))
  check('宋国里没有了', !rawItems(moved, 'f2').includes('war'), rawItems(moved, 'f2').join(','))
  check('齐国里那一份还在', rawItems(moved, 'f1').includes('war'), rawItems(moved, 'f1').join(','))

  /* 不给 from 的时候（老的调用方式）仍然「从所有地方搬过来」 */
  const movedAll = { ...both, ...moveItem(both, 'war', ROOT, 0) }
  check('不说清是哪一份时，按搬家处理',
    !rawItems(movedAll, 'f1').includes('war') && !rawItems(movedAll, 'f2').includes('war'),
    `${rawItems(movedAll, 'f1').join(',')} / ${rawItems(movedAll, 'f2').join(',')}`)
}

console.log('\n[6] 拖到中间要落在中间（顶层顺序固化）')

{
  // 四个条目一个都没登记：它们靠「补在末尾」显示，顺序是名称序。
  // 名称是 甲(jiǎ) 乙(yǐ) 丙(bǐng) 丁(dīng)，按拼音排是 丙丁甲乙
  const p = P([], [])
  const seen = resolveContainer(p, novel, ROOT).map((i) => i.id)
  check('没登记时按名称显示', seen.join('') === 'cdab', seen.join(''))

  // 把 b（显示在第 4 位）拖到第 2 位
  const mat = materializeRoot(p, novel)
  check('固化后 rootItems 就是看见的顺序', mat.rootItems.join('') === 'cdab',
    mat.rootItems.join(''))

  const next = moveItem(mat, 'b', ROOT, 1)
  check('落在第 2 位而不是最前面', next.rootItems.join('') === 'cbda', next.rootItems.join(''))
  check('拖完之后显示顺序与 rootItems 一致',
    resolveContainer({ ...p, ...next }, novel, ROOT).map((i) => i.id).join('') === 'cbda',
    resolveContainer({ ...p, ...next }, novel, ROOT).map((i) => i.id).join(''))
}

{
  // 混合：登记的 + 没登记的（f1 没登记在 rootItems 里，属于被改坏的边缘情况）
  const p = P([F('f1', '人物', ['a'])], ['d'])
  const seen = resolveContainer(p, novel, ROOT).map((i) => i.id)
  check('混合时孤儿排在登记项后面', seen.join(',') === 'd,c,b,f1', seen.join(','))
  const mat = materializeRoot(p, novel)
  const next = moveItem(mat, 'b', ROOT, 0)
  check('把孤儿拖到最前', next.rootItems.join(',') === 'b,d,c,f1', next.rootItems.join(','))
}

{
  const p = P([], ['c', 'd', 'a', 'b'])
  check('已经一致时原样返回同一个对象', materializeRoot(p, novel) === p)
}

/* ---------------- 7. 落点 index 要放回正确的槽位 ---------------- */

console.log('\n[7] 屏幕上的顺序 ≠ 存下来的顺序时，index 不能直接套用')

{
  /* 底子：存的是 [a, b, c, d]，但屏幕上按名称排是 [c, d, a, b]。
     用户把 b 拖到屏幕上的第 2 位（c 和 d 之间）。 */
  const p = P([], ['a', 'b', 'c', 'd'])
  const visible = ['c', 'd', 'a', 'b'] // 屏幕上看到的顺序
  const next = reorderVisible(p, ROOT, visible, 'b', 1)

  const shown = next.rootItems
  // b 应该落在可见序列里 c 和 d 之间 → 可见序列变成 [c, b, d, a]
  const visibleAfter = visible.filter((x) => x !== 'b')
  visibleAfter.splice(1, 0, 'b')
  check('可见序列里 b 落到了第 2 位', visibleAfter.join('') === 'cbda', visibleAfter.join(''))
  check('落回槽位之后，可见的相对顺序实现了',
    (() => {
      const order = shown.filter((x) => visible.includes(x))
      return order.join('') === visibleAfter.join('')
    })(), shown.join(''))
  check('四个条目一个都没丢', shown.length === 4, shown.join(''))
}

{
  /* 类型筛选：只看得见 a 和 c，把 c 拖到 a 前面。
     看不见的 b、d 必须原地不动，不能被挤走也不能丢。 */
  const p = P([], ['a', 'b', 'c', 'd'])
  const next = reorderVisible(p, ROOT, ['a', 'c'], 'c', 0)
  check('筛选时只动看得见的槽位', next.rootItems.join('') === 'cbad',
    next.rootItems.join(''))
  check('看不见的条目还在原位置',
    next.rootItems[1] === 'b' && next.rootItems[3] === 'd', next.rootItems.join(''))
}

{
  /* 夹子里也走同一套。
     存的是 [a,b,c]，屏幕上是 [c,b,a]，把 a 拖到可见序列第 1 位
     → 可见序列变 [a,c,b]，按槽位落回就是 [a,c,b]。 */
  const p = P([F('f1', '人物', ['a', 'b', 'c'])], ['f1'])
  const next = reorderVisible(p, 'f1', ['c', 'b', 'a'], 'a', 0)
  check('夹子里的可见顺序也按槽位落回',
    next.folders.find((f) => f.id === 'f1')!.items.join('') === 'acb',
    next.folders.find((f) => f.id === 'f1')!.items.join(''))
}

{
  // 边界：拖到最前 / 最后
  const p = P([], ['a', 'b', 'c'])
  check('拖到最前', reorderVisible(p, ROOT, ['a', 'b', 'c'], 'c', 0).rootItems.join('') === 'cab')
  check('拖到最后', reorderVisible(p, ROOT, ['a', 'b', 'c'], 'a', 2).rootItems.join('') === 'bca')
  check('index 超界落到最后',
    reorderVisible(p, ROOT, ['a', 'b', 'c'], 'a', 99).rootItems.join('') === 'bca')
}

/* ---------------- 8. 新建夹子 ---------------- */

{
  const f = newFolder('人物')
  check('新夹子有自己的 id', f.id.startsWith('f_') && f.id.length > 4, f.id)
  check('新夹子是空的', f.items.length === 0)
  check('连续建两个 id 不同', newFolder('a').id !== newFolder('a').id)
}

console.log('\n[9] 夹子的条目数 = 自己的 + 子孙的，夹子本身不算')

{
  const many = {
    entities: [E('a', '甲'), E('b', '乙'), E('c', '丙'), E('d', '丁'), E('e', '戊'), E('f', '己')],
  }
  /* 宋国里有四个条目，另有一个空子夹 */
  const p = P([F('f1', '宋国', ['a', 'b', 'c', 'd', 'f2']), F('f2', '子夹', [])], ['f1'])

  check('宋国此时是 4 个条目', countEntities(p, many, 'f1') === 4, String(countEntities(p, many, 'f1')))
  check('空子夹是 0 个', countEntities(p, many, 'f2') === 0, String(countEntities(p, many, 'f2')))
  check('夹子本身不算条目（4 条 + 1 个夹子，结果还是 4）',
    countEntities(p, many, 'f1') === 4, String(countEntities(p, many, 'f1')))

  /* 往子夹里加两个条目：子夹 2，宋国 4+2=6 */
  const p2 = P(
    [F('f1', '宋国', ['a', 'b', 'c', 'd', 'f2']), F('f2', '子夹', ['e', 'f'])],
    ['f1'],
  )
  check('子夹里加两条 → 子夹显示 2', countEntities(p2, many, 'f2') === 2,
    String(countEntities(p2, many, 'f2')))
  check('子夹里加两条 → 宋国继承，变成 4+2=6',
    countEntities(p2, many, 'f1') === 6, String(countEntities(p2, many, 'f1')))

  /* 往里加一个空夹子，父夹的数字不能变 */
  const p3 = P(
    [
      F('f1', '宋国', ['a', 'b', 'c', 'd', 'f2', 'f3']),
      F('f2', '子夹', []),
      F('f3', '另一个空夹', []),
    ],
    ['f1'],
  )
  check('再加一个空夹子，宋国仍然是 4',
    countEntities(p3, many, 'f1') === 4, String(countEntities(p3, many, 'f1')))

  /* 只算本夹子里的，不能把整本书算进来 */
  check('只算夹子里的，不算整本书（全书有 6 个）',
    countEntities(p, many, 'f1') === 4 && many.entities.length === 6,
    `${countEntities(p, many, 'f1')} / ${many.entities.length}`)

  /* 指不到的 id 不算 */
  const p4 = P([F('f1', '宋国', ['a', '不存在', 'b'])], ['f1'])
  check('夹子里指不到的 id 不算数', countEntities(p4, many, 'f1') === 2,
    String(countEntities(p4, many, 'f1')))

  /* 「自己有多少」—— 界面上写成「7 条（自己 4）」，用来解释继承来的数 */
  check('自己的条目数不含子夹', countOwnEntities(p2, many, 'f1') === 4,
    String(countOwnEntities(p2, many, 'f1')))
  check('自己的条目数不含子夹本身（4 条 + 1 个子夹 → 4）',
    countOwnEntities(p, many, 'f1') === 4, String(countOwnEntities(p, many, 'f1')))
  check('总数 > 自己 时才需要括号说明', countEntities(p2, many, 'f1') > countOwnEntities(p2, many, 'f1'))
  check('没有子夹时总数 = 自己', countEntities(p4, many, 'f1') === countOwnEntities(p4, many, 'f1'))
}

/* ---------------- 11. 随机操一千次：不许凭空多出东西、同一个容器里不许重复 ---------------- */

console.log('\n[11] 随机操作一千次，守住「不多不少」')

{
  /* 例子式测试只能覆盖我想到的情况。而「夹子里的数目对不上」这种问题，
     往往来自某个我没设想到的操作顺序 —— 所以这里随机摇操作，
     每一步都检查三条铁律：

       1. 同一个容器里，同一个 id 不许出现两次
       2. 容器里不许出现原本不存在于这本小说里的 id
       3. **词条夹**只许待在一个容器里（条目可以摆在多处，夹子不行 ——
          否则子树会被数两遍）

     第 2 条是「宋国显示 7 条」那类问题的根源：只要某个操作把别的 id
     塞进了夹子的 items，计数就会凭空变大。 */
  let seed = 20260111
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]

  const ENTITY_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] // 7 个，和用户的情况对齐
  const FOLDER_IDS = ['f1', 'f2']
  const all = new Set([...ENTITY_IDS, ...FOLDER_IDS])
  const fakeNovel = { entities: ENTITY_IDS.map((id, i) => E(id, `条目${i}`)) }

  let project = P(
    [F('f1', '宋国', []), F('f2', '子夹', [])],
    [...ENTITY_IDS, 'f1', 'f2'],
  )

  let violations = 0
  const checkInvariants = (step: number, op: string) => {
    const containers = [ROOT, ...(project.folders ?? []).map((f) => f.id)]
    const count = new Map<string, number>()
    for (const c of containers) {
      const here = new Set<string>()
      for (const id of rawItems(project, c)) {
        if (here.has(id)) {
          violations++
          console.log(`    第 ${step} 步（${op}）${c} 里出现两次：${id}`)
          return
        }
        here.add(id)
        count.set(id, (count.get(id) ?? 0) + 1)
      }
    }
    for (const [id, n] of count) {
      // 铁律二：容器里不许出现这本小说里没有的 id
      if (!all.has(id)) {
        violations++
        console.log(`    第 ${step} 步（${op}）凭空多出 id：${id}`)
        return
      }
      // 铁律三：夹子只能在一个地方（条目可以摆在多处）
      if (n > 1 && FOLDER_IDS.includes(id)) {
        violations++
        console.log(`    第 ${step} 步（${op}）夹子同时出现在 ${n} 个容器里：${id}`)
        return
      }
    }
    /* 不检查「每个 id 都还在某个容器里」：那两条都是合法状态 ——
       删掉的夹子本来就该没了，没登记的条目本来就会靠「补在末尾」显示。 */
  }

  const containerIds = () => [ROOT, ...(project.folders ?? []).map((f) => f.id)]

  for (let step = 1; step <= 1000; step++) {
    const op = Math.floor(rnd() * 6)
    try {
      if (op === 0) {
        const id = pick([...all])
        const to = pick(containerIds())
        const at = Math.floor(rnd() * 8) - 2
        // 一半时候说清楚「搬的是哪一份」，一半时候不传（老调用方式）
        const from = rnd() > 0.5 ? containerOf(project, id) : undefined
        const next = moveItem(project, id, to, at, from)
        project = { ...project, ...next }
        checkInvariants(step, 'moveItem')
      } else if (op === 1) {
        project = materializeRoot(project, fakeNovel)
        checkInvariants(step, 'materializeRoot')
      } else if (op === 2) {
        // 换位：visible 模拟「屏幕上看得见的那一串」，可能是子集（类型筛选）
        const c = pick(containerIds())
        const items = rawItems(project, c)
        if (items.length > 0) {
          const visible = items.filter(() => rnd() > 0.3)
          if (visible.length > 0) {
            const id = pick(visible)
            const at = Math.floor(rnd() * visible.length)
            const next = reorderVisible(project, c, visible, id, at)
            project = { ...project, ...next }
            checkInvariants(step, 'reorderVisible')
          }
        }
      } else if (op === 3) {
        // 再放一份 / 撤掉一份：条目可以在多个夹子里露头
        const id = pick(ENTITY_IDS)
        const to = pick(containerIds())
        const next = rnd() > 0.5 ? placeItem(project, id, to) : unplaceItem(project, id, to)
        project = { ...project, ...next }
        checkInvariants(step, rnd() > 0.5 ? 'placeItem' : 'unplaceItem')
      } else if (op === 4) {
        const f = pick(FOLDER_IDS)
        if ((project.folders ?? []).some((x) => x.id === f)) {
          const next = deleteFolder(project, f)
          project = { ...project, ...next }
          checkInvariants(step, 'deleteFolder')
        }
      } else {
        // 读回来过一遍 normalizeOrg：不许因为它而多出东西或丢掉东西
        const before = JSON.stringify([project.folders, project.rootItems])
        project = normalizeOrg(project)
        const after = JSON.stringify([project.folders, project.rootItems])
        if (before !== after) {
          violations++
          console.log(`    第 ${step} 步 normalizeOrg 改动了本来合法的数据`)
        }
        checkInvariants(step, 'normalizeOrg')
      }
    } catch (e) {
      violations++
      console.log(`    第 ${step} 步（op ${op}）抛异常：${String(e)}`)
      break
    }
  }

  check('一千次随机操作没有破坏「同一个容器里不重复」', violations === 0,
    `${violations} 次违规`)

  /* 再把计数本身也压一遍：夹子里的条目数不能超过整本小说 */
  let overcount = 0
  for (const f of project.folders ?? []) {
    if (countEntities(project, fakeNovel, f.id) > ENTITY_IDS.length) overcount++
  }
  check('任何夹子的条目数都不会超过全书总数', overcount === 0, String(overcount))
}

console.log('\n[12] findFolder')

{
  const p = P([F('f1', '甲')], [])
  check('找得到', findFolder(p, 'f1')?.name === '甲')
  check('找不到返回 undefined', findFolder(p, 'zzz') === undefined)
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：词条夹不会吞东西，同一个条目摆在多处也不会把自己弄乱。')
  process.exit(0)
}
console.log('结论：组织结构行为不符合预期。')
process.exit(1)
