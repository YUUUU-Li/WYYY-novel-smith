/* ============================================================
   撤回栈的测试

   跑法：npm run test:undo
   ============================================================ */

import { UndoStack } from '../src/lib/undo-stack'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra === undefined ? '' : '  -> ' + JSON.stringify(extra)}`)
  }
}

/* ---------------- 基本 ---------------- */

{
  const s = new UndoStack<number, string>()
  ok('空栈不能撤回', s.undo(0) === null)
  ok('空栈不能重做', s.redo(0) === null)
  ok('空栈深度为 0', s.undoDepth === 0 && s.redoDepth === 0)
  ok('空栈没有标签', s.undoLabel === null)
  ok('空栈没有上下文', s.undoContext === null)
}

{
  const s = new UndoStack<number, string>()
  s.record(1, '改字段', '设定页', 1000)
  ok('记一步后深度 1', s.undoDepth === 1)
  ok('撤回给出改动前的值', s.undo(2, 2000)?.state === 1)
  ok('撤回后深度 0、重做深度 1', s.undoDepth === 0 && s.redoDepth === 1)
  ok('重做给出撤回前的值', s.redo(1, 3000)?.state === 2)
  ok('重做后深度回到 1', s.undoDepth === 1 && s.redoDepth === 0)
}

/* ---------------- 合并：同一串输入算一步 ---------------- */

{
  const s = new UndoStack<number, string>()
  s.record(10, '编辑条目', '设定页', 1000)
  s.record(11, '编辑条目', '设定页', 1200) // 700ms 内，合并
  s.record(12, '编辑条目', '设定页', 1400)
  ok('连续打字只记一步', s.undoDepth === 1, s.undoDepth)
  ok('撤回退到这一串开始之前', s.undo(13, 5000)?.state === 10)
}

{
  const s = new UndoStack<number, string>()
  s.record(10, '编辑条目', '设定页', 1000)
  s.record(11, '编辑条目', '设定页', 5000) // 超过合并窗口
  ok('隔太久的两次改动分开记', s.undoDepth === 2, s.undoDepth)
  ok('第一次撤回退一步', s.undo(12, 6000)?.state === 11)
  ok('第二次撤回再退一步', s.undo(11, 6001)?.state === 10)
}

{
  const s = new UndoStack<number, string>()
  s.record(10, '编辑条目', '设定页', 1000)
  s.record(11, '删除条目', '设定页', 1100) // 标签不同，不合并
  ok('不同标签不合并', s.undoDepth === 2, s.undoDepth)
}

/* ---------------- 新改动会清空重做栈 ---------------- */

{
  const s = new UndoStack<number, string>()
  s.record(1, 'a', '设定页', 1000)
  s.undo(2, 2000)
  ok('撤回后可以重做', s.redoDepth === 1)
  s.record(1, 'b', '设定页', 3000)
  ok('新改动清掉重做栈', s.redoDepth === 0, s.redoDepth)
  ok('旧的重做内容取不到了', s.redo(1, 4000) === null)
}

/* ---------------- 上限 ---------------- */

{
  const s = new UndoStack<number, string>(3, 0)
  for (let i = 0; i < 5; i++) s.record(i, `步骤${i}`, '设定页', 1000 + i * 1000)
  ok('超过上限只保留最近 3 步', s.undoDepth === 3, s.undoDepth)
  ok(
    '最旧的被丢掉了（撤到底只到 2）',
    s.undo(99, 9000)?.state === 4 &&
      s.undo(4, 9001)?.state === 3 &&
      s.undo(3, 9002)?.state === 2 &&
      s.undo(2, 9003) === null,
  )
}

/* ---------------- clear ---------------- */

{
  const s = new UndoStack<number, string>()
  s.record(1, 'a', '设定页', 1000)
  s.record(2, 'b', '地图页', 2000)
  s.undo(3, 3000)
  s.clear()
  ok('clear 之后两边都空', s.undoDepth === 0 && s.redoDepth === 0)
  ok('clear 之后撤不回去', s.undo(3, 4000) === null)
  ok('clear 之后没有上下文', s.undoContext === null)
}

/* ---------------- 标签 ---------------- */

{
  const s = new UndoStack<number, string>()
  s.record(1, '删除了 3 个条目', '设定页', 1000)
  ok('撤回标签就是那一步的标签', s.undoLabel === '删除了 3 个条目')
  s.undo(2, 2000)
  ok('撤回后重做标签也带着', s.redoLabel === '删除了 3 个条目')
}

/* ---------------- 对象快照（和 store 里同型） ---------------- */

{
  const s = new UndoStack<{ text: string }, string>()
  const a = { text: '第一版' }
  const b = { text: '第一版被我删光了' }
  s.record(a, '编辑正文', '设定页', 1000)
  const back = s.undo(b, 2000)
  ok('快照能原样取回', back?.state.text === '第一版', back)
  ok('当前状态进了重做栈', s.redo(back!.state, 3000)?.state.text === '第一版被我删光了')
}

/* ---------------- 上下文：撤回要把画面带回去 ----------------
   这一节钉的是用户报的那个体验问题：
   在关系网里拖进一个词条，然后去地图页，此时按撤回 —— 数据退回去了，
   但画面还停在地图页，屏幕上什么都没动，看着像"撤回没生效"。 */

{
  const s = new UndoStack<number, string>()
  s.record(1, '编辑条目', 'sketch', 1000)
  ok('能提前看到这一步发生在哪', s.undoContext === 'sketch')

  s.record(2, '改作品信息', 'overview', 1500)
  const r = s.undo(3, 2000)
  ok('撤回带回那一步的页面', r?.context === 'overview', r)
  ok('撤回带回那一步的数据', r?.state === 2, r)

  const again = s.undo(2, 2100)
  ok('再撤一步回到更早的页面', again?.context === 'sketch', again)
}

{
  /* 合并时保留最早那一份上下文：这一串操作是从哪个页面起头的，
     撤回就该回到哪个页面 —— 否则拖到一半换了页，会跳到中间那个。 */
  const s = new UndoStack<number, string>()
  s.record(10, '拖动', 'sketch', 1000)
  s.record(11, '拖动', 'maps', 1200) // 同一个标签，合并
  ok('同一串只算一步', s.undoDepth === 1, s.undoDepth)
  const r = s.undo(12, 5000)
  ok('合并后保留起头那页', r?.context === 'sketch', r)
  ok('合并后保留起头的快照', r?.state === 10, r)
}

{
  /* 重做也要带上下文：撤到关系网、再重做，画面该回到这次改动所在的地方 */
  const s = new UndoStack<number, string>()
  s.record(1, '拖入角色', 'sketch', 1000)
  const back = s.undo(2, 2000)
  ok('撤回带着 sketch', back?.context === 'sketch')
  const fwd = s.redo(back!.state, 3000)
  ok('重做也带着 sketch', fwd?.context === 'sketch', fwd)
  ok('重做拿回改动后的状态', fwd?.state === 2, fwd)
}

console.log(`\n共 ${pass + fail} 项检查，失败 ${fail} 项。`)
if (fail > 0) process.exit(1)
