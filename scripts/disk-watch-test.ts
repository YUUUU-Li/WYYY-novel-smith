/* ============================================================
   外部改动检测：存储层部分的行为测试

   为什么需要一个假文件系统：
   检测链路依赖浏览器的 File System Access API，Node 里没有。
   但「哪些文件算进指纹」这个判断恰恰是最容易写错的地方 ——
   把历史快照或临时文件算进去，就会每秒都误报一次「文件被改过」，
   这个功能会立刻从有用变成关不掉的骚扰。

   所以这里手写一个内存文件系统，把真实的边界情况跑一遍。

   跑法：由 npm test 统一触发
   ============================================================ */

import { FileStorage } from '../src/lib/storage.ts'
import { canonEntity, comparable, countChanged, describeDiff, sameContent } from '../src/lib/compare.ts'
import type { Entity, Novel, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

/* ============================================================
   内存文件系统
   ============================================================ */

interface FakeFile {
  content: string
  lastModified: number
}
type FakeTree = Map<string, FakeFile | FakeTree>

let clock = 1_700_000_000_000

function dir(entries: Record<string, FakeFile | FakeTree> = {}): FakeTree {
  return new Map(Object.entries(entries))
}

function file(content: string): FakeFile {
  return { content, lastModified: clock }
}

function makeHandle(tree: FakeTree, label = 'library') {
  const handle = {
    kind: 'directory' as const,
    name: label,
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const hit = tree.get(name)
      if (hit instanceof Map) return makeHandle(hit, name)
      if (opts?.create) {
        const fresh = dir()
        tree.set(name, fresh)
        return makeHandle(fresh, name)
      }
      const err = new Error(`NotFoundError: ${name}`)
      err.name = 'NotFoundError'
      throw err
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const hit = tree.get(name)
      if (hit && !(hit instanceof Map)) {
        return {
          kind: 'file' as const,
          name,
          async getFile() {
            return {
              name,
              lastModified: hit.lastModified,
              async text() {
                return hit.content
              },
            } as unknown as File
          },
          async createWritable() {
            return {
              async write(data: string) {
                hit.content = String(data)
                hit.lastModified = ++clock
              },
              async close() {},
            }
          },
        }
      }
      if (opts?.create) {
        const fresh = file('')
        tree.set(name, fresh)
        return this.getFileHandle(name)
      }
      const err = new Error(`NotFoundError: ${name}`)
      err.name = 'NotFoundError'
      throw err
    },
    async removeEntry(name: string) {
      tree.delete(name)
    },
    async *values() {
      for (const [name, v] of tree.entries()) {
        if (v instanceof Map) yield { kind: 'directory' as const, name }
        else yield { kind: 'file' as const, name }
      }
    },
  }
  return handle
}

/** 用假文件系统造一个 FileStorage 实例（构造器是私有的，这里按内部结构绕过） */
function storageOver(tree: FakeTree): FileStorage {
  return new (FileStorage as unknown as new (root: unknown) => FileStorage)(makeHandle(tree))
}

/** 构造一个最小的真实小说文件夹 */
function buildLibrary(): { tree: FakeTree; novel: Novel } {
  const project: Project = {
    id: 'proj_x',
    title: '测试之书',
    linkTypes: ['敌对'],
    fieldSchemas: {},
    calendar: { name: '标准历', eras: [{ name: '第一纪元', abbr: 'E1' }], eraOrder: ['第一纪元'], months: [] },
    maps: [],
    createdAt: 1,
    updatedAt: 2,
  }
  const entity: Entity = {
    id: 'c1',
    type: 'character',
    name: '林昭',
    tags: [],
    links: [{ to: 'l1', type: '常驻' }],
    body: '正文\n',
  }
  const novel: Novel = { project, entities: [entity], outline: [], terms: [] }

  // 「文件夹即作品」：novel.json 和各类型目录直接在这一层
  const tree = dir({
    'novel.json': file(JSON.stringify(project)),
    '大纲.json': file('[]'),
    '词条.json': file('[]'),
    角色: dir({ '林昭.md': file('---\nid: c1\ntype: character\nname: 林昭\n---\n\n正文\n') }),
  })
  return { tree, novel }
}

/* ============================================================
   1. 指纹必须稳定，且忽略会自己变化的文件
   ============================================================ */

console.log('\n[1] 指纹的稳定性')

{
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)

  const a = await s.signatureOf()
  const b = await s.signatureOf()
  check('同样的目录连取两次指纹一致', a !== null && a === b)

  // 历史快照是我们自己每次保存都写的，必须排除，否则永远在误报
  const bookDir = tree
  bookDir.set('历史', dir({ '2026-01-01T00-00-00.json': file('{"x":1}') }))
  const c = await s.signatureOf()
  check('新增历史快照不改变指纹', a === c, `${a} vs ${c}`)

  // 编辑器留下的临时文件和隐藏文件
  bookDir.set('.storage.ts.tmpdir', dir({ 'x.tmp': file('junk') }))
  bookDir.set('林昭.md.tmp', file('junk'))
  bookDir.set('.DS_Store', file('junk'))
  const d = await s.signatureOf()
  check('临时文件与隐藏文件不改变指纹', a === d, `${a} vs ${d}`)

  // 非 md/json 的杂项文件（比如你放进来的参考图）
  bookDir.set('参考图.png', file('binary'))
  const e = await s.signatureOf()
  check('无关的图片文件不改变指纹', a === e)
}

/* ============================================================
   2. 真正的改动必须被检测到
   ============================================================ */

console.log('\n[2] 真实改动必须被检测到')

{
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)
  const before = await s.signatureOf()

  const bookDir = tree
  const chars = bookDir.get('角色') as FakeTree
  const f = chars.get('林昭.md') as FakeFile
  f.content += '\n外部加的一行\n'
  f.lastModified = ++clock

  const after = await s.signatureOf()
  check('在外部编辑一个角色文件后指纹改变', before !== after)
}

{
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)
  const before = await s.signatureOf()

  const bookDir = tree
  const chars = bookDir.get('角色') as FakeTree
  chars.set('苏无咎.md', file('---\nid: c2\ntype: character\nname: 苏无咎\n---\n'))

  const after = await s.signatureOf()
  check('新增一个实体文件后指纹改变', before !== after)
}

{
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)
  const before = await s.signatureOf()

  const bookDir = tree
  ;(bookDir.get('novel.json') as FakeFile).content = '{"id":"proj_x","title":"改了名"}'
  ;(bookDir.get('novel.json') as FakeFile).lastModified = ++clock

  const after = await s.signatureOf()
  check('修改 novel.json 后指纹改变', before !== after)
}

/* ============================================================
   3. 文件夹不可用时必须返回 null，而不是抛异常
   ============================================================ */

console.log('\n[3] 文件夹消失时的行为')

{
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)

  tree.delete('novel.json') // 作品文件夹被改名或移走了：这一层不再是作品

  const sig = await s.signatureOf().catch(() => 'THREW')
  check('文件夹不存在时返回 null 而不是抛异常', sig === null, String(sig))
}

/* ============================================================
   4. 内容比对：绝不能因为键顺序或来源路径就误报
   ============================================================ */

console.log('\n[4] 内容比对不能误报')

const project: Project = {
  id: 'p',
  title: '书',
  linkTypes: [],
  fieldSchemas: {},
  calendar: { name: 'c', eras: [], eraOrder: [], months: [] },
  maps: [],
  createdAt: 0,
  updatedAt: 0,
}

const memoryEntity: Entity = {
  id: 'c1',
  type: 'character',
  name: '林昭',
  tags: ['主角'],
  links: [
    { to: 'c2', type: '敌对', note: '旧账', weight: 5 },
    { to: 'l1', type: '常驻' },
  ],
  date: { era: '天和', year: 312, month: '霜月', day: 12 },
  body: '正文',
}

const memory: Novel = { project, entities: [memoryEntity], outline: [], terms: [] }

{
  // 磁盘读回来的对象：键顺序不同、多了 file 字段、links 顺序颠倒、空值是 '' 而不是 undefined
  const diskEntity: Entity = {
    file: '角色/林昭.md',
    body: '正文',
    links: [
      { type: '常驻', to: 'l1' },
      { note: '旧账', weight: 5, type: '敌对', to: 'c2' },
    ],
    date: { day: 12, year: 312, month: '霜月', era: '天和' },
    tags: ['主角'],
    name: '林昭',
    type: 'character',
    id: 'c1',
  }
  const disk: Novel = { project, entities: [diskEntity], outline: [], terms: [] }

  check('键顺序不同不算改动', sameContent(memory, disk))
  check('file 字段存在不算改动', canonEntity(memoryEntity) === canonEntity(diskEntity))
  check('links 顺序颠倒不算改动', sameContent(memory, disk))
  check('describeDiff 对等价内容返回空数组', describeDiff(memory, disk).length === 0,
    describeDiff(memory, disk).join(' | '))
}

{
  // 真正改了正文
  const changed: Entity = { ...memoryEntity, body: '改过的正文' }
  const disk: Novel = { project, entities: [changed], outline: [], terms: [] }
  check('正文真的改了会被识别', !sameContent(memory, disk))
  check('describeDiff 指出具体差异', describeDiff(memory, disk).some((s) => s.includes('1 个条目')))
}

{
  // 空字符串与 undefined 等价
  const a: Entity = { ...memoryEntity, summary: undefined, status: undefined }
  const b: Entity = { ...memoryEntity, summary: '', status: '' }
  check('空串与 undefined 等价，不算改动', canonEntity(a) === canonEntity(b), canonEntity(a) + ' vs ' + canonEntity(b))
}

{
  // 增删条目
  const added: Novel = { ...memory, entities: [...memory.entities, { ...memoryEntity, id: 'c9', name: '新人' }] }
  check('磁盘多出一个条目会被识别', !sameContent(memory, added))
  check('条目数变化写进描述', describeDiff(memory, added).some((s) => s.includes('1 → 2')),
    describeDiff(memory, added).join(' | '))
  check('countChanged 计入新增条目', countChanged(memory, added) >= 1)
}

{
  // 字段对象的内容真的改了
  const a: Entity = { ...memoryEntity, fields: { 能力: '寒刃' } }
  const b: Entity = { ...memoryEntity, fields: { 能力: '烈火' } }
  check('自定义字段改值会被识别', canonEntity(a) !== canonEntity(b))
}

{
  // 项目标题改了
  const renamed: Novel = { ...memory, project: { ...project, title: '新书名' } }
  check('标题改动会被识别', !sameContent(memory, renamed))
  check('标题差异写进描述', describeDiff(memory, renamed).some((s) => s.includes('标题')))
}

/* ============================================================
   9. 改类型后旧文件必须被清掉
   ============================================================ */

console.log('\n[9] 条目改类型后的落盘清理')

{
  // 场景：把一个角色改成概念。
  // 文件会写到 概念/ 目录，但 角色/ 下那份旧文件必须被删掉 ——
  // 否则读回来时同一个 id 出现两次，界面里条目重影。
  //
  // 这里同时点名了一个曾经存在的 bug：清理逻辑原先只按文件名比对，
  // 而新旧文件名相同（都叫「林昭.md」），于是它认为「这个文件还在」，
  // 不会删除。正确做法是按实体 id 判断归属，而不是按文件名。
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)

  const bookDir = tree
  const chars = bookDir.get('角色') as FakeTree

  check('改类型前，角色/ 下有文件', chars.has('林昭.md'))

  // 把唯一的角色改成概念，然后走一次完整落盘
  const converted: Novel = {
    ...novel,
    entities: novel.entities.map((e) => (e.type === 'character' ? { ...e, type: 'concept' } : e)),
  }
  await s.write(converted)

  check('改类型后，概念/ 下出现文件',
    (bookDir.get('概念') as FakeTree | undefined)?.has('林昭.md') === true,
    [...((bookDir.get('概念') as FakeTree | undefined)?.keys() ?? [])].join(' '))
  check('改类型后，角色/ 下的旧文件被清掉',
    chars.has('林昭.md') === false,
    [...chars.keys()].join(' '))

  // 读回来不能出现同 id 两条
  const back = await s.read('proj_x')
  const dupes = back ? back.entities.filter((e) => e.id === 'c1').length : -1
  check('读回来没有重影条目', dupes === 1, `id=c1 出现 ${dupes} 次`)
}

{
  // 重命名实体（文件名会变）也必须清掉旧文件
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)
  const bookDir = tree
  const chars = bookDir.get('角色') as FakeTree

  const renamed: Novel = {
    ...novel,
    entities: novel.entities.map((e) => ({ ...e, name: '林昭之改名' })),
  }
  await s.write(renamed)

  check('改名后新文件名存在', chars.has('林昭之改名.md'), [...chars.keys()].join(' '))
  check('改名后旧文件名被清掉', chars.has('林昭.md') === false, [...chars.keys()].join(' '))
}

{
  // 删除实体后文件必须消失
  const { tree, novel } = buildLibrary()
  const s = storageOver(tree)
  const bookDir = tree
  const chars = bookDir.get('角色') as FakeTree

  await s.write({ ...novel, entities: [] })
  check('删除实体后文件被清掉', chars.size === 0, [...chars.keys()].join(' '))
}

/* ============================================================
   结果
   ============================================================ */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：外部改动检测只会在内容真变化时报，且不会因格式差异误报。')
  process.exit(0)
}
console.log('结论：检测不可靠，会误报或漏报。')
process.exit(1)
