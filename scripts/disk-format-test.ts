/* ============================================================
   磁盘侧格式契约

   这个测试的存在理由是「防止两种实现产生分歧」。

   同一份小说文件夹会被两套代码读写：
     · 浏览器版（TypeScript，src/lib/storage.ts）
     · 桌面版（Rust，src-tauri/src/）
   如果两边对「文件名怎么转义」「快照怎么命名」的规则不一致，
   结果就是同一个文件夹被两种格式打架，数据看起来时有时无。

   所以我在这里把磁盘侧的格式钉死。Rust 侧还有一份镜像断言
   （src-tauri/src/tests.rs），两边必须给出相同的期望值。

   跑法：由 npm test 统一触发
   ============================================================ */

import { safeFileName } from '../src/lib/frontmatter.ts'
import { ENTITY_DIR, HISTORY_DIR, NOVELS_ROOT, novelToFiles } from '../src/lib/novelfs.ts'
import type { Entity, Novel, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

/* ============================================================
   1. 路径常量 —— Rust 侧必须用同样的字面量
   ============================================================ */

console.log('\n[1] 路径常量')

check('小说根目录名', NOVELS_ROOT === '小说', NOVELS_ROOT)
check('历史目录名', HISTORY_DIR === '历史', HISTORY_DIR)
check('角色目录名', ENTITY_DIR.character === '角色', ENTITY_DIR.character)
check('地点目录名', ENTITY_DIR.location === '地点', ENTITY_DIR.location)
check('事件目录名', ENTITY_DIR.event === '事件', ENTITY_DIR.event)
check('势力目录名', ENTITY_DIR.faction === '势力', ENTITY_DIR.faction)
check('物品目录名', ENTITY_DIR.item === '物品', ENTITY_DIR.item)
check('概念目录名', ENTITY_DIR.concept === '概念', ENTITY_DIR.concept)

/* ============================================================
   2. 文件名转义 —— 最容易出现分歧的地方
   ============================================================ */

console.log('\n[2] 文件名转义规则')

// Rust 侧同样要断言这些（tests.rs）
const nameCases: Array<[string, string]> = [
  ['林昭', '林昭'],
  ['苏无咎', '苏无咎'],
  ['A/B', 'A·B'],
  ['A:B', 'A·B'],
  ['A*B', 'A·B'],
  ['A?B', 'A·B'],
  ['A"B', 'A·B'],
  ['A<B', 'A·B'],
  ['A>B', 'A·B'],
  ['A|B', 'A·B'],
  ['A\\B', 'A·B'],
  ['寒刃\'s Edge', "寒刃's Edge"],
  ['  前后空格  ', '前后空格'],
  ['多个    空格', '多个 空格'],
  ['', '未命名'],
  ['   ', '未命名'],
]

for (const [input, expected] of nameCases) {
  const got = safeFileName(input)
  check(`safeFileName(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
    got === expected, `实际 ${JSON.stringify(got)}`)
}

{
  // 超长名字要截断到 60 字符，否则会撞 Windows 路径长度限制
  const long = '长'.repeat(100)
  const got = safeFileName(long)
  check('超长名字截断到 60 字符', got.length === 60, `长度 ${got.length}`)

  // 全是被转义字符的情况
  check('全是非法字符时仍返回可用名字', safeFileName('///').length > 0, safeFileName('///'))
}

/* ============================================================
   3. 快照命名 —— Rust 侧必须产生同样格式的时间戳
   ============================================================ */

console.log('\n[3] 快照命名格式')

{
  // 浏览器版用 toISOString().replace(/[:.]/g,'-').slice(0,19)
  // 例如 2026-09-29T14:22:42.123Z → 2026-09-29T14-22-42
  const iso = '2026-09-29T14:22:42.123Z'
  const stamp = iso.replace(/[:.]/g, '-').slice(0, 19)
  check('快照时间戳格式', stamp === '2026-09-29T14-22-42', stamp)

  // 关键性质：这个格式按文件名排序就等于按时间排序
  const a = '2026-09-29T09-00-00'
  const b = '2026-09-29T14-22-42'
  const c = '2026-09-30T01-00-00'
  check('按文件名排序等于按时间排序', [a, b, c].slice().sort().join() === [a, b, c].join())

  // 不能含冒号：Windows 文件名里非法
  check('时间戳不含冒号', !stamp.includes(':'), stamp)
  check('时间戳不含点', !stamp.includes('.'), stamp)
}

{
  // 快照上限 60 份：超出时删掉最旧的（文件名排序后取前 N 个）
  const names = Array.from({ length: 65 }, (_, i) => {
    const day = String(1 + Math.floor(i / 24)).padStart(2, '0')
    const hour = String(i % 24).padStart(2, '0')
    return `2026-09-${day}T${hour}-00-00.json`
  })
  const sorted = [...names].sort()
  const toDelete = sorted.slice(0, sorted.length - 60)
  check('超量时删掉 5 份', toDelete.length === 5, `${toDelete.length}`)
  check('删掉的是最旧的', toDelete[0] === sorted[0], toDelete[0])
  check('保留 60 份', sorted.length - toDelete.length === 60)
}

/* ============================================================
   4. 完整布局 —— 两边必须产出同样的路径集合
   ============================================================ */

console.log('\n[4] 完整布局')

{
  const project: Project = {
    id: 'p1',
    title: '测试/之书', // 含非法字符，验证书名也被转义
    linkTypes: [],
    fieldSchemas: {},
    calendar: { name: 'c', eras: [], eraOrder: [], months: [] },
    maps: [],
    createdAt: 0,
    updatedAt: 0,
  }
  const E = (p: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'name'>): Entity => ({
    tags: [],
    links: [],
    body: '',
    ...p,
  })
  const novel: Novel = {
    project,
    entities: [
      E({ id: 'c1', type: 'character', name: '林昭' }),
      E({ id: 'l1', type: 'location', name: '北境/要塞' }),
      E({ id: 'e1', type: 'event', name: '陷落' }),
    ],
    outline: [],
    terms: [],
  }

  const paths = novelToFiles(novel).map((f) => f.path)
  const expect = [
    '小说/测试·之书/novel.json',
    '小说/测试·之书/角色/林昭.md',
    '小说/测试·之书/地点/北境·要塞.md',
    '小说/测试·之书/事件/陷落.md',
    '小说/测试·之书/大纲.json',
    '小说/测试·之书/词条.json',
  ]
  for (const p of expect) {
    check(`产出路径 ${p}`, paths.includes(p), paths.join(' | '))
  }
  check('没有多余路径', paths.length === expect.length, `${paths.length} vs ${expect.length}`)
  check('书名里的斜杠被转义（不会变成子目录）',
    paths.every((p) => !p.includes('测试/之书')), paths.join(' | '))
}

/* ============================================================
   结果
   ============================================================ */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：磁盘格式契约已钉死，Rust 侧须按同样的期望值实现。')
  process.exit(0)
}
console.log('结论：磁盘格式不符合约定。')
process.exit(1)
