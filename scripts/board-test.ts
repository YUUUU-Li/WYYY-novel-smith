/* ============================================================
   手工摆的时间线：行是算出来的，横坐标是存下来的

   这个功能的坏法都很安静：
   · 行算错了 → 两件不同时的事并到一行，读起来像「同期发生」
   · 没时间的事件被丢掉 → 你以为它还在板上，其实早就没了
   · 同一行塞进来两格叠在一起 → 看起来只剩一格
   · 老文件没有 boards 字段 → 界面直接崩
   所以这一组断言全部围绕这四件事。

   跑法：由 npm test 统一触发
   ============================================================ */

import {
  BOARD_MAX_WIDTH,
  BOARD_MIN_WIDTH,
  BOARD_WIDTH_STEP,
  addGuide,
  addToBoard,
  boardLayout,
  boardSpan,
  clampBoardWidth,
  dateRowKey,
  freeXOnRow,
  moveOnBoard,
  newBoard,
  normalizeBoards,
  removeFromBoard,
  removeGuide,
  setBoardWidth,
  updateGuide,
} from '../src/lib/boards.ts'
import { DEFAULT_CALENDAR } from '../src/lib/types.ts'
import type { Entity, Novel, Project, TimelineBoard } from '../src/lib/types.ts'

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
  calendar: DEFAULT_CALENDAR,
  maps: [],
  boards: [],
  folders: [],
  rootItems: [],
  createdAt: 0,
  updatedAt: 0,
}

function E(p: Partial<Entity> & Pick<Entity, 'id' | 'name'>): Entity {
  return { type: 'event', tags: [], links: [], body: '', ...p }
}

const cal = DEFAULT_CALENDAR

/* ============================================================
   1. 行：同一时间才是一行
   ============================================================ */

console.log('\n[1] 行由时间算出来')

{
  const novel: Novel = {
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'a', name: '齐国伐宋', date: { era: '第一纪元', year: 421, monthIndex: 0, day: 1 } }),
      E({ id: 'b', name: '宋国求援', date: { era: '第一纪元', year: 421, monthIndex: 0, day: 1 } }),
      E({ id: 'c', name: '云京会盟', date: { era: '第一纪元', year: 422, monthIndex: 2, day: 1 } }),
      E({ id: 'd', name: '只有年份', date: { era: '第一纪元', year: 420 } }),
    ],
  }
  const board: TimelineBoard = {
    ...newBoard('测试'),
    items: [
      { entity: 'c', x: 0.7 },
      { entity: 'a', x: 0.2 },
      { entity: 'b', x: 0.5 },
      { entity: 'd', x: 0.1 },
    ],
  }
  const { rows, undated } = boardLayout(novel, board, cal)
  console.log('    行标签：', rows.map((r) => r.label).join(' | '))

  check('同一天的两个人并成一行', rows.length === 3, `${rows.length} 行`)
  check('最早的在最上面', rows[0].items[0].entity.id === 'd', rows[0].items[0].entity.name)
  check('420 那一行只有一件事', rows[0].items.length === 1, String(rows[0].items.length))
  check('421 那一行有两件事', rows[1].items.length === 2, String(rows[1].items.length))
  check('行内按左右位置排',
    rows[1].items[0].entity.id === 'a' && rows[1].items[1].entity.id === 'b',
    rows[1].items.map((i) => i.entity.name).join(','))
  check('只知道年份的不和某一天挤一行', rows[0].key !== rows[1].key, `${rows[0].key} / ${rows[1].key}`)
  check('没有未定时间的', undated.length === 0)
  check('行标签是人读的（不是 id）',
    rows.every((r) => r.label.length <= 12 && /[0-9]/.test(r.label)),
    rows.map((r) => r.label).join(' | '))
}

{
  // 精确到月和精确到日的同一个月：不是同一行
  const novel: Novel = {
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'm', name: '某月', date: { era: '第一纪元', year: 421, monthIndex: 0 } }),
      E({ id: 'dm', name: '某日', date: { era: '第一纪元', year: 421, monthIndex: 0, day: 5 } }),
    ],
  }
  const board: TimelineBoard = { ...newBoard('t'), items: [{ entity: 'm', x: 0.2 }, { entity: 'dm', x: 0.8 }] }
  const { rows } = boardLayout(novel, board, cal)
  check('只知道月份的和精确到日的分开排', rows.length === 2, `${rows.length} 行`)
  check('键里带上了日', dateRowKey({ era: '第一纪元', year: 421, monthIndex: 0, day: 5 }).endsWith('d5'),
    dateRowKey({ era: '第一纪元', year: 421, monthIndex: 0, day: 5 }))
}

{
  /* 公元纪年的历法：格式化成「前293 年」，而且同一年里的不同月份
     必须能看出区别 —— 列表里可以只写年份，时间线的刻度不行。 */
  const ceCal = { ...DEFAULT_CALENDAR, eraDisplay: 'none' as const, yearDisplay: 'ce' as const }
  const ceProject: Project = { ...project, calendar: ceCal }
  const novel: Novel = {
    project: ceProject,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'a', name: '长平', date: { year: -293, monthIndex: 2 } }),
      E({ id: 'b', name: '邯郸', date: { year: -293, monthIndex: 6 } }),
      E({ id: 'c', name: '次年', date: { year: -292 } }),
    ],
  }
  const board: TimelineBoard = {
    ...newBoard('t'),
    items: [{ entity: 'a', x: 0.2 }, { entity: 'b', x: 0.6 }, { entity: 'c', x: 0.4 }],
  }
  const { rows } = boardLayout(novel, board, ceCal)
  console.log('    公元纪年的行：', rows.map((r) => `${r.head}/${r.tail}`).join(' | '))
  check('负年份写成「前 N 年」，不是一个光秃秃的负数',
    rows[0].head === '前293 年', rows[0].head)
  check('同一年不同月份分成两行', rows.length === 3, `${rows.length} 行`)
  check('两行的上行相同、下行不同（这是必须的，否则看不出区别）',
    rows[0].head === rows[1].head && rows[0].tail !== rows[1].tail,
    `${rows[0].head}/${rows[0].tail} vs ${rows[1].head}/${rows[1].tail}`)
  check('月份是月份名，不是下标', rows[0].tail === '三月', rows[0].tail)
  check('只知道年的那行没有下行', rows[2].tail === '', JSON.stringify(rows[2].tail))
}

/* ============================================================
   2. 没时间的事件不丢
   ============================================================ */

console.log('\n[2] 没时间的事件不许消失')

{
  const novel: Novel = {
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'x', name: '还没定时' }),
      E({ id: 'y', name: '有时间的', date: { era: '第一纪元', year: 421 } }),
    ],
  }
  const board: TimelineBoard = {
    ...newBoard('t'),
    items: [{ entity: 'x', x: 0.3 }, { entity: 'y', x: 0.6 }],
  }
  const { rows, undated } = boardLayout(novel, board, cal)
  check('没时间的单独收着', undated.length === 1 && undated[0].entity.id === 'x',
    undated.map((u) => u.entity.name).join(','))
  check('它的横坐标记着（填上时间就按它落位）', undated[0]?.x === 0.3, String(undated[0]?.x))
  check('有时间的照常进行', rows.length === 1)
}

{
  // 板上引用了已经被删掉的条目：不算崩，只记个数
  const novel: Novel = { project, outline: [], terms: [], entities: [] }
  const board: TimelineBoard = { ...newBoard('t'), items: [{ entity: 'gone', x: 0.5 }] }
  const { rows, undated, missing } = boardLayout(novel, board, cal)
  check('指向不存在的条目不崩', rows.length === 0 && undated.length === 0)
  check('并记下有几处坏引用', missing === 1, String(missing))
}

/* ============================================================
   3. 整体时间（列表上写的那一行）
   ============================================================ */

console.log('\n[3] 列表要显示的整体时间')

{
  const novel: Novel = {
    project,
    outline: [],
    terms: [],
    entities: [
      E({ id: 'a', name: 'A', date: { era: '第一纪元', year: 420 } }),
      E({ id: 'b', name: 'B', date: { era: '第一纪元', year: 423 } }),
      E({ id: 'c', name: 'C' }),
    ],
  }
  const board: TimelineBoard = {
    ...newBoard('t'),
    items: [{ entity: 'b', x: 0.2 }, { entity: 'a', x: 0.5 }, { entity: 'c', x: 0.8 }],
  }
  const span = boardSpan(novel, board, cal)
  console.log('    整体时间：', span.from, '→', span.to)
  check('起点是最早那件事', span.from !== null && /420/.test(span.from), String(span.from))
  check('终点是最晚那件事', span.to !== null && /423/.test(span.to), String(span.to))
  check('数量算的是全部条目（含没时间的）', span.count === 3, String(span.count))
  check('其中排得上时间的有两个', span.dated === 2, String(span.dated))
}

{
  const novel: Novel = {
    project,
    outline: [],
    terms: [],
    entities: [E({ id: 'a', name: 'A' })],
  }
  const board: TimelineBoard = { ...newBoard('t'), items: [{ entity: 'a', x: 0.5 }] }
  const span = boardSpan(novel, board, cal)
  check('一件有时间的都没有时，不给跨度', span.from === null && span.to === null,
    `${span.from} / ${span.to}`)
  check('但条目数照报', span.count === 1 && span.dated === 0)
}

/* ============================================================
   4. 增删改与「别叠在一起」
   ============================================================ */

console.log('\n[4] 往板上放、拿走、左右挪')

{
  const board = newBoard('t')
  const one = addToBoard(board, 'a', 0.4)
  check('放进去了', one.items.length === 1 && one.items[0].x === 0.4)
  check('放进去不会改原对象', board.items.length === 0)

  const again = addToBoard(one, 'a', 0.9)
  check('同一个条目放两次没有意义，第二次不动', again === one)

  check('横坐标超界会被夹回 0~1', addToBoard(board, 'b', 3).items[0].x === 1,
    String(addToBoard(board, 'b', 3).items[0].x))

  const moved = moveOnBoard(one, 'a', 0.85)
  check('左右挪是改 x', moved.items[0].x === 0.85, String(moved.items[0].x))
  check('挪的时候不会多出一格', moved.items.length === 1)

  const removed = removeFromBoard(moved, 'a')
  check('拿走之后板上没有了', removed.items.length === 0)
  check('拿走不存在的条目返回原对象', removeFromBoard(removed, 'zzz') === removed)
}

{
  // 同一行已经有格子时，新来的要往右让开
  const row = [{ x: 0.02 }, { x: 0.18 }, { x: 0.34 }]
  const x = freeXOnRow(row, 0.16)
  console.log('    row =', JSON.stringify(row), '→ 新格子的 x =', x)
  check('新格子不会叠在已有的格子上',
    row.every((r) => Math.abs(r.x - x) > 0.05), String(x))
  check('让开之后还在板内', x >= 0 && x <= 1, String(x))

  const crowded = Array.from({ length: 10 }, (_, i) => ({ x: i * 0.16 }))
  const cx = freeXOnRow(crowded, 0.16)
  check('排满了也不会跑到板外', cx >= 0 && cx <= 1, String(cx))
}

/* ============================================================
   5. 列（竖线）
   ============================================================ */

console.log('\n[5] 列：作者自己定义它是什么意思')

{
  const board = newBoard('t')
  const withGuide = addGuide(board, '齐国', 0.3)
  check('加一列', withGuide.guides.length === 1 && withGuide.guides[0].name === '齐国')
  check('列的 id 是新的', typeof withGuide.guides[0].id === 'string')

  const renamed = updateGuide(withGuide, withGuide.guides[0].id, { name: '宋国' })
  check('能改名字', renamed.guides[0].name === '宋国')

  const movedGuide = updateGuide(renamed, renamed.guides[0].id, { x: 0.8 })
  check('能挪位置', movedGuide.guides[0].x === 0.8)
  check('挪出界会被夹回来',
    updateGuide(renamed, renamed.guides[0].id, { x: 9 }).guides[0].x === 1)

  const dropped = removeGuide(movedGuide, movedGuide.guides[0].id)
  check('能删掉', dropped.guides.length === 0)
  check('删列不会动任何事件', dropped.items.length === board.items.length)
}

/* ============================================================
   6. 板宽：一屏摆不下就放宽，横向滚动
   ============================================================ */

console.log('\n[6] 板宽：同一时间的事多了，就把画布放宽')

{
  const board = newBoard('t')
  check('新板子是正好一屏', clampBoardWidth(board.width) === BOARD_MIN_WIDTH, String(board.width))
  check('没写过板宽的老板按一屏算', clampBoardWidth(undefined) === BOARD_MIN_WIDTH)
  check('板宽有下限', clampBoardWidth(0) === BOARD_MIN_WIDTH, String(clampBoardWidth(0)))
  check('板宽有上限', clampBoardWidth(99) === BOARD_MAX_WIDTH, String(clampBoardWidth(99)))
  check('步进是半屏', BOARD_WIDTH_STEP === 0.5 && BOARD_MAX_WIDTH > BOARD_MIN_WIDTH)

  const wide = setBoardWidth(board, BOARD_MIN_WIDTH + BOARD_WIDTH_STEP)
  check('放宽存住了', wide.width === 1.5, String(wide.width))
  check('放宽不会多出格子、也不会挪格子', wide.items.length === board.items.length)
  check('放宽不改原对象', board.width === BOARD_MIN_WIDTH, String(board.width))
  check('一直收窄不会收成负数', setBoardWidth(board, -3).width === BOARD_MIN_WIDTH,
    String(setBoardWidth(board, -3).width))
  check('一直放宽不会出界', setBoardWidth(board, 40).width === BOARD_MAX_WIDTH)

  // 归一化也管这一项：老文件里的坏板宽要被夹回来，好的原样留着
  const fixed = normalizeBoards({
    boards: [
      { id: 'x1', name: '宽的', width: 12, guides: [], items: [] },
      { id: 'x2', name: '没写', guides: [], items: [] },
    ],
  } as never)
  check('超界的板宽被夹回上限', fixed[0].width === BOARD_MAX_WIDTH, String(fixed[0].width))
  check('没写板宽的板不会凭空多出一个字段', fixed[1].width === undefined, String(fixed[1].width))
}

/* ============================================================
   7. 老文件兼容与修坏数据
   ============================================================ */

console.log('\n[7] 老 novel.json 里没有 boards')

{
  const legacy = { ...project, boards: undefined } as unknown as Project
  const fixed = normalizeBoards(legacy)
  check('缺字段时补成空数组', Array.isArray(fixed) && fixed.length === 0, JSON.stringify(fixed))
}

{
  const broken = {
    ...project,
    boards: [
      null,
      { id: 'b1' }, // 缺 items / guides / name
      {
        id: 'b2',
        name: '好的',
        items: [{ entity: 'a', x: 2 }, { entity: 'a', x: 0.5 }, null],
        guides: [{ id: 'g1', name: 'x', x: -1 }],
      },
      { id: 'b2', name: '重名的' }, // 同一个 id 出现两次
    ],
  } as unknown as Project
  const fixed = normalizeBoards(broken)
  check('坏掉的板被丢掉', fixed.length === 2, `${fixed.length} 张`)
  check('没有名字的板有兜底名字', fixed[0].name.length > 0, fixed[0].name)
  check('x 超界被夹回 0~1', fixed[1].items[0].x === 1, String(fixed[1].items[0].x))
  check('同一个条目在同一张板上只留一格', fixed[1].items.length === 1, String(fixed[1].items.length))
  check('坏掉的格子被丢掉', fixed[1].items.every((i) => typeof i.entity === 'string'))
  check('重复的板 id 只留第一张', fixed[1].name === '好的', fixed[1].name)
  check('竖线的 x 也被夹回来', fixed[1].guides[0].x === 0, String(fixed[1].guides[0].x))
}

{
  // 干净的数据必须原样返回同一个数组，否则每次读盘都会白白重建
  const clean: TimelineBoard[] = [
    { id: 'b1', name: '甲', guides: [{ id: 'g1', name: '列', x: 0.4 }], items: [{ entity: 'e1', x: 0.2 }] },
  ]
  const out = normalizeBoards({ boards: clean })
  check('干净的数据返回同一个数组（不做无谓的重建）', out === clean)
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：行按时间算、横坐标按手摆，没时间的事件也不会丢。')
  process.exit(0)
}
console.log('结论：时间线的排布逻辑不符合预期。')
process.exit(1)
