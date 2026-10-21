/* ============================================================
   时间线这一栏：先看有哪些时间线，再进一张

   为什么要有这一层：
   原来点「时间线」直接进「全部事件」那张自动生成的图。想自己摆一张
   ——只挑几条线、把两个国家的事并排对齐——没有地方可放。
   现在第一屏是列表（每张写着名字和整体时间跨度），进去才是那张图。

   自动生成的三种视图（事件轴 / 轨道 / 在场）没被删掉，也没被藏起来：
   它们是固定的一条入口，因为它们回答的是另一个问题 ——
   「我一共有哪些事件，它们按时间铺开是什么样」，那个不需要作者摆。
   ============================================================ */

import { useState } from 'react'
import { BoardList, BoardView } from './BoardView'
import { TimelineView } from './TimelineView'
import { useStore } from '../store/useNovel'

export function TimelineSection() {
  const novel = useStore((s) => s.novel)
  /** null = 还在列表；'derived' = 自动生成的那三种 */
  const [openId, setOpenId] = useState<string | 'derived' | null>(null)

  const boards = novel?.project.boards ?? []
  const board = openId && openId !== 'derived' ? boards.find((b) => b.id === openId) : undefined

  /* 这张板被删掉之后，别停在一个空壳上 */
  if (openId && openId !== 'derived' && !board) {
    return <BoardList onOpen={setOpenId} onOpenDerived={() => setOpenId('derived')} />
  }

  if (openId === 'derived') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          className="flex flex-none items-center gap-2 px-4 py-2"
          style={{ borderBottom: '1px solid var(--color-line)' }}
        >
          <button type="button" className="btn btn-plain" onClick={() => setOpenId(null)}>
            全部事件
          </button>
          <span className="text-[11.5px]" style={{ color: 'var(--color-ink-faint)' }}>
            自动生成 · 返回时间线列表
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <TimelineView />
        </div>
      </div>
    )
  }

  if (board) return <BoardView board={board} onBack={() => setOpenId(null)} />

  return <BoardList onOpen={setOpenId} onOpenDerived={() => setOpenId('derived')} />
}
