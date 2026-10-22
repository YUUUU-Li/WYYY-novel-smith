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
  const s = new UndoStack<number>()
  ok('空栈不能撤回', s.undo(0) === null)
  ok('空栈不能重做', s.redo(0) === null)
  ok('空栈深度为 0', s.undoDepth === 0 && s.redoDepth === 0)
  ok('空栈没有标签', s.undoLabel === null)
}

{
  const s = new UndoStack<number>()
  s.record(1, '改字段', 1000)
  ok('记一步后深度 1', s.undoDepth === 1)
  ok('撤回给出改动前的值', s.undo(2, 2000) === 1)
  ok('撤回后深度 0、重做深度 1', s.undoDepth === 0 && s.redoDepth === 1)
  ok('重做给出撤回前的值', s.redo(1, 3000) === 2)
  ok('重做后深度回到 1', s.undoDepth === 1 && s.redoDepth === 0)
}

/* ---------------- 合并：同一串输入算一步 ---------------- */

{
  const s = new UndoStack<number>()
  s.record(10, '编辑条目', 1000)
  s.record(11, '编辑条目', 1200) // 700ms 内，合并
  s.record(12, '编辑条目', 1400)
  ok('连续打字只记一步', s.undoDepth === 1, s.undoDepth)
  ok('撤回退到这一串开始之前', s.undo(13, 5000) === 10)
}

{
  const s = new UndoStack<number>()
  s.record(10, '编辑条目', 1000)
  s.record(11, '编辑条目', 5000) // 超过合并窗口
  ok('隔太久的两次改动分开记', s.undoDepth === 2, s.undoDepth)
  ok('第一次撤回退一步', s.undo(12, 6000) === 11)
  ok('第二次撤回再退一步', s.undo(11, 6001) === 10)
}

{
  const s = new UndoStack<number>()
  s.record(10, '编辑条目', 1000)
  s.record(11, '删除条目', 1100) // 标签不同，不合并
  ok('不同标签不合并', s.undoDepth === 2, s.undoDepth)
}

/* ---------------- 新改动会清空重做栈 ---------------- */

{
  const s = new UndoStack<number>()
  s.record(1, 'a', 1000)
  s.undo(2, 2000)
  ok('撤回后可以重做', s.redoDepth === 1)
  s.record(1, 'b', 3000)
  ok('新改动清掉重做栈', s.redoDepth === 0, s.redoDepth)
  ok('旧的重做内容取不到了', s.redo(1, 4000) === null)
}

/* ---------------- 上限 ---------------- */

{
  const s = new UndoStack<number>(3, 0)
  for (let i = 0; i < 5; i++) s.record(i, `步骤${i}`, 1000 + i * 1000)
  ok('超过上限只保留最近 3 步', s.undoDepth === 3, s.undoDepth)
  ok('最旧的被丢掉了（撤到底只到 2）', (s.undo(99, 9000) === 4) && (s.undo(4, 9001) === 3) && (s.undo(3, 9002) === 2) && s.undo(2, 9003) === null)
}

/* ---------------- clear ---------------- */

{
  const s = new UndoStack<number>()
  s.record(1, 'a', 1000)
  s.record(2, 'b', 2000)
  s.undo(3, 3000)
  s.clear()
  ok('clear 之后两边都空', s.undoDepth === 0 && s.redoDepth === 0)
  ok('clear 之后撤不回去', s.undo(3, 4000) === null)
}

/* ---------------- 标签 ---------------- */

{
  const s = new UndoStack<number>()
  s.record(1, '删除了 3 个条目', 1000)
  ok('撤回标签就是那一步的标签', s.undoLabel === '删除了 3 个条目')
  s.undo(2, 2000)
  ok('撤回后重做标签也带着', s.redoLabel === '删除了 3 个条目')
}

/* ---------------- 对象快照（和 store 里同型） ---------------- */

{
  const s = new UndoStack<{ text: string }>()
  const a = { text: '第一版' }
  const b = { text: '第一版被我删光了' }
  s.record(a, '编辑正文', 1000)
  const back = s.undo(b, 2000)
  ok('快照能原样取回', back?.text === '第一版', back)
  ok('当前状态进了重做栈', s.redo(back!, 3000)?.text === '第一版被我删光了')
}

console.log(`\n共 ${pass + fail} 项检查，失败 ${fail} 项。`)
if (fail > 0) process.exit(1)
