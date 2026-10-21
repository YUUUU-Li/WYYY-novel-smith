/* ============================================================
   保存状态的行为测试

   防的是最严重的一类问题：写盘失败被静默吞掉，作者以为存上了。

   跑法：由 npm test 统一触发
   ============================================================ */

import {
  describeSaveState,
  describeWriteError,
  isSaveProblem,
  runSave,
  type SaveState,
} from '../src/lib/save-status.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

/* ---------------- 1. 写盘成功 ---------------- */

console.log('\n[1] 写盘成功')

{
  let wrote = false
  let tidied = false
  const st = await runSave(
    async () => {
      wrote = true
    },
    async () => {
      tidied = true
    },
    1000,
  )
  check('真的调用了写入', wrote)
  check('成功时做了收尾', tidied)
  check('状态是 saved', st.kind === 'saved', st.kind)
  check('记录了时间', st.kind === 'saved' && st.at === 1000)
  check('成功不算问题状态', !isSaveProblem(st))
}

/* ---------------- 2. 写盘失败必须浮出来 ---------------- */

console.log('\n[2] 写盘失败')

{
  const boom = new Error('disk on fire')
  boom.name = 'NotAllowedError'
  const st = await runSave(
    async () => {
      throw boom
    },
    async () => {
      throw new Error('收尾不该被调用')
    },
    2000,
  )
  check('状态是 error', st.kind === 'error', st.kind)
  check('错误信息是人话而不是堆栈', st.kind === 'error' && !/disk on fire/.test(st.message), st.kind === 'error' ? st.message : '')
  check('错误状态被判为问题', isSaveProblem(st))
  check('记录了时间', st.kind === 'error' && st.at === 2000)
}

{
  // 关键：写入成功但收尾失败，不能谎报「保存失败」
  // 否则作者会以为数据没落盘，可能去做多余的补救操作
  const st = await runSave(
    async () => undefined,
    async () => {
      throw new Error('列列表时炸了')
    },
    3000,
  )
  check('收尾失败不谎报保存失败', st.kind === 'saved', st.kind)
}

/* ---------------- 3. 错误翻译成人话 ---------------- */

console.log('\n[3] 错误信息翻译')

{
  const mk = (name: string) => {
    const e = new Error(name)
    e.name = name
    return e
  }
  check('权限被收回说得清楚', describeWriteError(mk('NotAllowedError')).includes('重新授权'),
    describeWriteError(mk('NotAllowedError')))
  check('文件夹找不到说得清楚', describeWriteError(mk('NotFoundError')).includes('移动或改名'),
    describeWriteError(mk('NotFoundError')))
  check('空间不足说得清楚', describeWriteError(mk('QuotaExceededError')).includes('空间'),
    describeWriteError(mk('QuotaExceededError')))
  check('连接失效说得清楚', describeWriteError(mk('InvalidStateError')).includes('失效'),
    describeWriteError(mk('InvalidStateError')))
}

{
  // 从 message 里猜（有些错误只有 message 没有 name）
  check('ENOENT 被识别', describeWriteError(new Error('ENOENT: no such file')).includes('移动或改名'),
    describeWriteError(new Error('ENOENT: no such file')))
  check('EACCES 被识别', describeWriteError(new Error('EACCES: permission denied')).includes('权限'),
    describeWriteError(new Error('EACCES: permission denied')))
  check('EBUSY 被识别', describeWriteError(new Error('EBUSY: resource busy')).includes('占用'),
    describeWriteError(new Error('EBUSY: resource busy')))
  check('ENOSPC 被识别', describeWriteError(new Error('ENOSPC: no space')).includes('空间'),
    describeWriteError(new Error('ENOSPC: no space')))
}

{
  // 未知错误也要给出可读的一句话，而不是空串或 [object Object]
  const weird = describeWriteError(new Error('某种没见过的错误'))
  check('未知错误不返回空串', weird.length > 0, JSON.stringify(weird))
  check('未知错误带出原始信息', weird.includes('某种没见过的错误'), weird)
  check('null 不崩溃', describeWriteError(null).length > 0, describeWriteError(null))
  check('undefined 不崩溃', describeWriteError(undefined).length > 0)
  check('字符串不崩溃', describeWriteError('炸了').length > 0, describeWriteError('炸了'))
}

/* ---------------- 4. 状态文案 ---------------- */

console.log('\n[4] 状态文案')

{
  const states: Array<[SaveState, string]> = [
    [{ kind: 'idle' }, '有未保存的改动'],
    [{ kind: 'saving' }, '保存中…'],
    [{ kind: 'saved', at: 1000 }, '已保存'],
  ]
  for (const [st, expected] of states) {
    check(`「${st.kind}」的文案是「${expected}」`, describeSaveState(st, 1000) === expected,
      describeSaveState(st, 1000))
  }
}

{
  // 时间流逝后的文案
  check('10 秒前', describeSaveState({ kind: 'saved', at: 0 }, 10_000) === '10 秒前已保存',
    describeSaveState({ kind: 'saved', at: 0 }, 10_000))
  check('5 分钟前', describeSaveState({ kind: 'saved', at: 0 }, 300_000) === '5 分钟前已保存',
    describeSaveState({ kind: 'saved', at: 0 }, 300_000))
  check('超过一小时不再报分钟数',
    describeSaveState({ kind: 'saved', at: 0 }, 7_200_000) === '已保存',
    describeSaveState({ kind: 'saved', at: 0 }, 7_200_000))
  // 系统时间往回调不能出现负数
  check('时间倒流不出现负数秒',
    !describeSaveState({ kind: 'saved', at: 5000 }, 1000).includes('-'),
    describeSaveState({ kind: 'saved', at: 5000 }, 1000))
}

{
  check('错误状态直接显示原因',
    describeSaveState({ kind: 'error', message: '存储空间不够了', at: 0 }, 0) === '存储空间不够了')
}

/* ---------------- 5. 问题状态判定 ---------------- */

console.log('\n[5] 问题状态判定')

{
  check('idle 不是问题', !isSaveProblem({ kind: 'idle' }))
  check('saving 不是问题', !isSaveProblem({ kind: 'saving' }))
  check('saved 不是问题', !isSaveProblem({ kind: 'saved', at: 0 }))
  check('error 是问题', isSaveProblem({ kind: 'error', message: 'x', at: 0 }))
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：写盘失败会浮出界面，且不会被误报或被吞掉。')
  process.exit(0)
}
console.log('结论：保存状态不可靠。')
process.exit(1)
