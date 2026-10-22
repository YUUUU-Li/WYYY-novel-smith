/* ============================================================
   撤回 / 重做栈

   为什么放在 lib 里而不是直接写在 store 里：
   这是全应用唯一一块"会毁掉别人稿子"的逻辑，必须能单独测。
   store 里那层只负责接线（把 novel 存进去、取出来）。

   为什么用快照而不是"记录操作再反向执行"：
   操作种类太多了（改字段、删条目、拖位置、换纪时法、整组换地图……），
   每种都写一份反向操作，就有一半的代码是"反向"的，而反向代码写错了
   往往比不写更危险。快照唯一要担心的是内存，但 Novel 是不可变更新的，
   没改到的子对象在每一步之间是共享的，所以 40 步的实际开销远小于
   40 份完整拷贝。

   合并（coalesce）：打字和拖动会在一秒内触发几十次改动，如果每次都
   存一步，撤回一次只退一个字符——那不是 Word 的行为。同一标签的连续
   改动在 coalesceMs 内并成一步，保留最早的那份 before，这样「撤回」
   退掉的是"这一串输入"，符合直觉。
   ============================================================ */

export interface UndoStep<T> {
  /** 何时记录，用于判断能不能和上一步合并 */
  at: number
  /** 给界面显示的文字：撤回「删除了 3 个条目」 */
  label: string
  /** 这一步"改动之前"的状态 */
  before: T
}

export class UndoStack<T> {
  private past: UndoStep<T>[] = []
  private future: UndoStep<T>[] = []

  constructor(
    private readonly limit = 40,
    private readonly coalesceMs = 700,
  ) {}

  get undoDepth(): number {
    return this.past.length
  }

  get redoDepth(): number {
    return this.future.length
  }

  get undoLabel(): string | null {
    return this.past.length > 0 ? this.past[this.past.length - 1].label : null
  }

  get redoLabel(): string | null {
    return this.future.length > 0 ? this.future[this.future.length - 1].label : null
  }

  /**
   * 记一步。`before` 是改动之前的状态。
   *
   * 注意这里同时清空重做栈：一旦有了新改动，"未来"那条分支就不存在了，
   * 这和所有编辑器一致。
   */
  record(before: T, label: string, at = Date.now()): void {
    this.future.length = 0
    const top = this.past[this.past.length - 1]
    if (top && top.label === label && at - top.at <= this.coalesceMs) {
      // 同一串操作：保留最早的 before，只把时间往后挪
      top.at = at
      return
    }
    this.past.push({ at, label, before })
    if (this.past.length > this.limit) this.past.shift()
  }

  /**
   * 撤回。传入"当前状态"，返回需要恢复成的状态；没得撤时返回 null。
   */
  undo(current: T, at = Date.now()): T | null {
    const step = this.past.pop()
    if (!step) return null
    // 把当前状态推进重做栈，label 沿用被撤回那一步的
    this.future.push({ at, label: step.label, before: current })
    if (this.future.length > this.limit) this.future.shift()
    return step.before
  }

  /** 重做。传的同样是"当前状态" */
  redo(current: T, at = Date.now()): T | null {
    const step = this.future.pop()
    if (!step) return null
    this.past.push({ at, label: step.label, before: current })
    if (this.past.length > this.limit) this.past.shift()
    return step.before
  }

  /** 换作品、换存储位置、接受磁盘版本时必须清掉，否则会撤到别人的内容里 */
  clear(): void {
    this.past.length = 0
    this.future.length = 0
  }
}
