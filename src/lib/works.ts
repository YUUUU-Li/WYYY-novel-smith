/* ============================================================
   作品注册表：程序记着"哪些文件夹是作品"

   为什么需要它：
   一个作品就是一个文件夹，没有统一的"小说库"可以扫描了。所以
   作品库页面的列表 = 这里记着的那几个文件夹 + 内部存储里的作品。

   存哪儿：
   · 元信息（标题、更新时间、条目数、桌面版的绝对路径）→ localStorage
   · 浏览器版的文件夹句柄 → IndexedDB（句柄不能序列化进 localStorage）

   已知取舍（写在这里免得以后自己纳闷）：
   桌面版把路径存在 WebView2 的 localStorage 里。如果哪天界面缓存目录
   被换掉（就是启动时自动换目录那条路），列表会空 —— 但**作品文件一个
   都没丢**，重新「打开作品文件夹」指一次就好。真要做成永不丢，得把
   这份表写进 %LOCALAPPDATA% 的文件里（多一个 Rust 命令），暂时不值当。
   ============================================================ */

import { getHandle, idbSet } from './storage'

export type WorkKind = 'internal' | 'folder'

export interface WorkRef {
  /** 就是 project.id，用来在列表里指认 */
  id: string
  kind: WorkKind
  /** 显示用：作品标题（缓存，打开时以 novel.json 为准） */
  title: string
  /** 显示用：文件夹名 */
  folderName: string
  /**
   * 作者自己写的"位置"标签，优先级最高。
   *
   * 为什么需要：浏览器的文件夹句柄只给最后一层的名字，拿不到父目录，
   * 所以想看到「小说库 / 小说 / 战国记」这种完整层级，只能由作者填一次。
   * 桌面版有真实路径，不填也没关系。
   */
  label?: string
  /** 桌面版：作品文件夹的绝对路径 */
  path?: string
  /** 浏览器版：IndexedDB 里句柄的 key */
  handleKey?: string
  updatedAt: number
  entityCount: number
}

const KEY = 'novel-studio:works'

export function loadWorks(): WorkRef[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as WorkRef[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function saveWorks(list: WorkRef[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // 存不了就算了：这一次仍然能用，只是下次列表会空
  }
}

/** 加一条或按 id 覆盖（同一部作品换了文件夹也走这里） */
export function upsertWork(ref: WorkRef): WorkRef[] {
  const list = loadWorks().filter((w) => w.id !== ref.id)
  const next = [...list, ref].sort((a, b) => b.updatedAt - a.updatedAt)
  saveWorks(next)
  return next
}

export function dropWork(id: string): WorkRef[] {
  const next = loadWorks().filter((w) => w.id !== id)
  saveWorks(next)
  return next
}

/** 浏览器版：把文件夹句柄塞进 IndexedDB，返回给注册表用的 key */
export async function stashHandle(id: string, handle: FileSystemDirectoryHandle): Promise<string> {
  const key = `work:${id}`
  await idbSet(key, handle)
  return key
}

export async function loadHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  return await getHandle<FileSystemDirectoryHandle>(key)
}

export function clearHandle(id: string): void {
  void idbSet(`work:${id}`, null)
}
