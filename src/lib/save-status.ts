/* ============================================================
   保存状态

   为什么需要这个：
   落盘失败原先是被静默吞掉的（`.catch(() => undefined)`）。
   磁盘满、权限被浏览器收回、文件夹被移走、文件被别的程序锁住 ——
   这些情况下程序不会告诉你，你会一直打字以为都存上了。

   对「文件即真相」的工具来说这是最严重的一类问题：数据没了而你
   不知道。所以写盘结果必须浮到界面上。

   抽成独立模块的原因：它是保存流程里唯一能被纯函数测到的部分。
   计时器与 React 测不了，但「什么结果对应什么状态」可以。
   ============================================================ */

export type SaveState =
  /** 内存已改，但还没安排落盘（节流窗口内） */
  | { kind: 'idle' }
  /** 正在写盘 */
  | { kind: 'saving' }
  /** 写盘成功，记下时间供界面显示 */
  | { kind: 'saved'; at: number }
  /** 写盘失败，必须让作者看见 */
  | { kind: 'error'; message: string; at: number }

export interface WriteOutcome {
  ok: boolean
  error?: string
}

/** 从存储层抛出或返回的结果里提取一句人话 */
export function describeWriteError(err: unknown): string {
  if (!err) return '保存失败'
  const e = err as { name?: string; message?: string; code?: number }
  const name = e.name ?? ''
  const msg = e.message ?? ''

  // 浏览器在权限被收回时抛 NotAllowedError，这个最需要说清楚
  if (name === 'NotAllowedError') {
    return '浏览器收回了文件夹的写入权限，需要重新授权'
  }
  if (name === 'NotFoundError') {
    return '找不到小说库文件夹，可能被移动或改名了'
  }
  if (name === 'QuotaExceededError' || e.code === 22) {
    return '存储空间不够了'
  }
  if (name === 'InvalidStateError') {
    return '文件夹连接已失效，需要重新选择'
  }
  if (/no such file|not found|ENOENT/i.test(msg)) {
    return '找不到小说库文件夹，可能被移动或改名了'
  }
  if (/permission|denied|EACCES|EPERM/i.test(msg)) {
    return '没有写入权限'
  }
  if (/quota|space|ENOSPC/i.test(msg)) {
    return '存储空间不够了'
  }
  if (/locked|EBUSY/i.test(msg)) {
    return '文件被其他程序占用，稍后会重试'
  }
  return msg ? `保存失败：${msg}` : '保存失败'
}

/**
 * 执行一次落盘，把结果翻译成界面状态。
 *
 * 刻意不用 try/catch 包住「成功」分支的逻辑：如果成功之后
 * 读列表或取指纹失败，那是另一类问题，不该被报成「保存失败」
 * 让作者以为数据没写进去。
 */
export async function runSave(
  write: () => Promise<void>,
  afterSuccess: () => Promise<void>,
  now: number,
): Promise<SaveState> {
  try {
    await write()
  } catch (err) {
    return { kind: 'error', message: describeWriteError(err), at: now }
  }
  // 数据已经落盘了。后续的收尾操作失败不该谎报「保存失败」
  try {
    await afterSuccess()
  } catch {
    // 忽略：列表刷新失败不影响数据安全
  }
  return { kind: 'saved', at: now }
}

/** 界面上一句话描述当前状态 */
export function describeSaveState(state: SaveState, now: number): string {
  switch (state.kind) {
    case 'idle':
      return '有未保存的改动'
    case 'saving':
      return '保存中…'
    case 'saved': {
      const secs = Math.max(0, Math.round((now - state.at) / 1000))
      if (secs < 5) return '已保存'
      if (secs < 60) return `${secs} 秒前已保存`
      const mins = Math.round(secs / 60)
      if (mins < 60) return `${mins} 分钟前已保存`
      return '已保存'
    }
    case 'error':
      return state.message
  }
}

/** 是不是需要引起注意的状态 */
export function isSaveProblem(state: SaveState): boolean {
  return state.kind === 'error'
}
