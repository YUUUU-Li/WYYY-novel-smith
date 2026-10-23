/* ============================================================
   存储访问层

   这是全应用唯一碰「持久化」的地方，也是当初说的那层封装。
   现在有两个实现：

   LocalStorageAdapter —— 兜底。不支持文件夹的浏览器（Firefox/Safari）
                          或用户还没选文件夹时用。
   FileStorage         —— 真实文件夹。一份小说一个目录，
                          实体是单个 Markdown 文件，能被 Git 逐行 diff、
                          能被记事本打开、能整包拷走。

   为什么界面代码不用改就能切换：
   因为 store 只依赖 StorageAdapter 接口，不关心背后是 localStorage
   还是磁盘。write(novel) 这个「整份写回」的语义在两边都成立。

   将来套 Tauri 壳时，再加一个走 Rust 的实现即可，
   接口完全一致，切换点就是文件末尾那一行。
   ============================================================ */

import type { Novel } from './types'
import {
  ENTITY_DIR,
  HISTORY_DIR,
  META_FILE,
  OUTLINE_FILE,
  TERMS_FILE,
  novelFromDir,
  novelToFiles,
} from './novelfs'
import { safeFileName } from './frontmatter'

const LS_PREFIX = 'novel-studio:'
const LS_INDEX = `${LS_PREFIX}projects`
const IDB_NAME = 'novel-studio'
const IDB_STORE = 'handles'

const novelKey = (id: string) => `${LS_PREFIX}novel:${id}`

export interface ProjectSummary {
  id: string
  title: string
  logline?: string
  updatedAt: number
  entityCount: number
  /**
   * 这部作品存在哪，给作品库卡片显示用。
   * 由 store 填（文件夹名 / "程序内部存储"），存储适配器不负责。
   * 以前卡片显示的是"当前打开的作品文件夹"，于是回到列表时每张卡都
   * 顶着最后打开那本的名字 —— 位置是作品自己的属性，不是全局状态。
   */
  location?: string
  /** 桌面版：完整路径 */
  locationPath?: string
  /** 作者自己写的层级标签（浏览器版拿不到父目录时用） */
  locationLabel?: string
  /** 这部作品在文件夹里还是在程序内部存储里 */
  kind?: 'folder' | 'internal'
}

export interface StorageAdapter {
  readonly kind: string
  /** 供界面显示「当前存到哪」。localStorage 时返回 null。 */
  readonly rootName: string | null
  listProjects(): Promise<ProjectSummary[]>
  read(id: string): Promise<Novel | null>
  write(novel: Novel): Promise<void>
  remove(id: string): Promise<void>
  /** 摊成文件集合。导出和真实落盘都走这个，保证两边结构一致。 */
  filesOf(novel: Novel): Promise<Array<{ path: string; content: string }>>
  /**
   * 文件夹指纹，用于检测「文件被程序之外的东西改过」。
   * 只有真实文件系统才有意义，localStorage 实现返回 null。
   */
  signatureOf?(novel: Novel): Promise<string | null>
}

function toSummary(novel: Novel): ProjectSummary {
  return {
    id: novel.project.id,
    title: novel.project.title,
    logline: novel.project.logline,
    updatedAt: novel.project.updatedAt,
    entityCount: novel.entities.length,
  }
}

/** 把 localStorage 里的项目索引当缓存用，主数据在各自的小说文件里 */
function writeIndex(list: ProjectSummary[]) {
  localStorage.setItem(LS_INDEX, JSON.stringify(list))
}

function readIndex(): ProjectSummary[] {
  try {
    const raw = localStorage.getItem(LS_INDEX)
    if (!raw) return []
    const list = JSON.parse(raw) as ProjectSummary[]
    return Array.isArray(list)
      ? list.sort((a, b) => b.updatedAt - a.updatedAt)
      : []
  } catch {
    return []
  }
}

/* ============================================================
   兜底实现：浏览器本地存储
   ============================================================ */

class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'localStorage'
  readonly rootName = null

  async listProjects(): Promise<ProjectSummary[]> {
    return readIndex()
  }

  async read(id: string): Promise<Novel | null> {
    try {
      const raw = localStorage.getItem(novelKey(id))
      return raw ? (JSON.parse(raw) as Novel) : null
    } catch {
      return null
    }
  }

  async write(novel: Novel): Promise<void> {
    localStorage.setItem(novelKey(novel.project.id), JSON.stringify(novel))
    writeIndex([...readIndex().filter((p) => p.id !== novel.project.id), toSummary(novel)])
  }

  async remove(id: string): Promise<void> {
    localStorage.removeItem(novelKey(id))
    writeIndex(readIndex().filter((p) => p.id !== id))
  }

  async filesOf(novel: Novel) {
    return novelToFiles(novel)
  }

  /* 刻意不实现 signatureOf。
     内部的「有没有被外部改过」检测只对真实文件夹有意义，而调用方
     用 `store.signatureOf` 是否存在来判断「这个后端支不支持」。
     以前这里返回的是 null，结果被调用方读成「文件夹找不到了」，
     于是内部存储模式下每次打开都会弹一条假告警。不实现 = 不支持。 */
}

/* ============================================================
   真实实现：磁盘文件夹

   权限模型要注意：浏览器不允许静默重连上次选的文件夹。
   已授权的句柄存在 IndexedDB 里，下次打开需要用户点一次「继续使用」，
   这是浏览器的安全边界，不是我们偷懒。套上 Tauri 壳之后这一层会消失。
   ============================================================ */

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idbOpen()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await idbOpen()
  const out = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return out
}

/** 支持文件夹持久化的浏览器才有这个 API */
/** 给作品注册表用的薄封装：句柄进出 IndexedDB */
export async function getHandle<T>(key: string): Promise<T | null> {
  return await idbGet<T>(key)
}

export function supportsFileSystem(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export class FileStorage implements StorageAdapter {
  readonly kind = 'filesystem'

  private constructor(private root: FileSystemDirectoryHandle) {}

  get rootName(): string {
    return this.root.name
  }

  /** 从作品注册表拿到的句柄直接包起来用 */
  static wrap(handle: FileSystemDirectoryHandle): FileStorage {
    return new FileStorage(handle)
  }

  /** 让用户选一个文件夹当「这部作品」的家 */
  static async pick(): Promise<FileStorage | null> {
    if (!supportsFileSystem()) return null
    const handle = await window.showDirectoryPicker!({
      id: 'novel-studio-work',
      mode: 'readwrite',
      startIn: 'documents',
    })
    return new FileStorage(handle)
  }

  /** 这个文件夹里有没有 novel.json —— 有就说明它本身是一部作品 */
  async hasNovelJson(): Promise<boolean> {
    try {
      await this.root.getFileHandle(META_FILE)
      return true
    } catch {
      return false
    }
  }

  /** 把句柄交出去给注册表存 */
  get handle(): FileSystemDirectoryHandle {
    return this.root
  }

  /* ---------- 路径操作（相对作品文件夹） ---------- */

  private async dirFor(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = this.root
    for (const part of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(part, { create })
    }
    return dir
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const parts = path.split('/')
    const fileName = parts.pop()!
    const dir = await this.dirFor(parts.join('/'), true)
    const fh = await dir.getFileHandle(fileName, { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
  }

  private async fileNames(path: string): Promise<string[]> {
    try {
      const dir = await this.dirFor(path, false)
      const out: string[] = []
      for await (const entry of dir.values()) {
        if (entry.kind === 'file') out.push(entry.name)
      }
      return out
    } catch {
      return []
    }
  }

  /* ---------- 外部改动检测 ---------- */

  /**
   * 指纹：全部文件的「路径 + 修改时间」。
   *
   * 只看元信息不看内容 —— 几百个文件读一遍内容太贵，而这里只需要判断
   * "有没有人动过"。排除 历史/（每次保存都写，算进去会永远误报）、
   * 隐藏文件和 .tmp。
   */
  async signature(): Promise<string | null> {
    // 这一层里没有 novel.json 就不再是作品了（被改名/移走/清空）
    if (!(await this.hasNovelJson())) return null
    try {
      const entries: Array<[string, number]> = []

      const walk = async (path: string, prefix: string): Promise<void> => {
        const handle = await this.dirFor(path, false)
        for await (const entry of handle.values()) {
          const name = entry.name
          if (name.startsWith('.')) continue
          if (name.endsWith('.tmp')) continue
          const rel = prefix ? `${prefix}/${name}` : name
          if (entry.kind === 'directory') {
            if (name === HISTORY_DIR) continue
            await walk(path ? `${path}/${name}` : name, rel)
            continue
          }
          if (!/\.(md|json)$/i.test(name)) continue
          const fh = await handle.getFileHandle(name)
          entries.push([rel, (await fh.getFile()).lastModified])
        }
      }

      await walk('', '')
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      return entries.map(([p2, t]) => `${p2}@${t}`).join('|')
    } catch {
      // 文件夹被移走或权限失效：返回 null，调用方据此提示作者
      return null
    }
  }

  /* ---------- 接口实现 ---------- */

  /** 一个文件夹只有一部作品，所以列表最多一条 */
  async listProjects(): Promise<ProjectSummary[]> {
    const novel = await this.readSelf()
    if (!novel) return []
    return [toSummary(novel)]
  }

  private async readSelf(): Promise<Novel | null> {
    try {
      return await novelFromDir(this.root as never)
    } catch {
      return null
    }
  }

  async read(_id: string): Promise<Novel | null> {
    return this.readSelf()
  }

  /**
   * 写回。先写全部文件，再删掉已经不存在的实体文件。
   * 不做增量更新：整份写回在文件系统上是最简单也最不容易写坏的模型。
   */
  async write(novel: Novel): Promise<void> {
    const files = novelToFiles(novel)

    for (const f of files) {
      await this.writeFile(f.path, f.content)
    }

    // 清理重命名或删除后留下的孤儿文件
    const keep = new Set(files.map((f) => f.path))
    for (const dirName of Object.values(ENTITY_DIR)) {
      for (const name of await this.fileNames(dirName)) {
        if (!keep.has(`${dirName}/${name}`)) {
          try {
            const dir = await this.dirFor(dirName, false)
            await dir.removeEntry(name)
          } catch {
            // 删不掉就算了，不值得让保存失败
          }
        }
      }
    }

    await this.snapshot(novel).catch(() => undefined)
  }

  /** 删掉这部作品的正文文件（文件夹本身留着，也不会碰别的目录） */
  async remove(_id: string): Promise<void> {
    for (const dirName of Object.values(ENTITY_DIR)) {
      for (const name of await this.fileNames(dirName)) {
        try {
          const dir = await this.dirFor(dirName, false)
          await dir.removeEntry(name)
        } catch {
          // 同上
        }
      }
    }
    for (const name of [META_FILE, OUTLINE_FILE, TERMS_FILE]) {
      try {
        await this.root.removeEntry(name)
      } catch {
        // 本来就没有
      }
    }
    for (const name of await this.fileNames(HISTORY_DIR)) {
      try {
        const dir = await this.dirFor(HISTORY_DIR, false)
        await dir.removeEntry(name)
      } catch {
        // 同上
      }
    }
  }

  async filesOf(novel: Novel) {
    return novelToFiles(novel)
  }

  async signatureOf(): Promise<string | null> {
    return this.signature()
  }

  /* ---------- 版本快照 ---------- */

  /**
   * 每次保存留一份快照。这不是 Git，是「出事了能翻回去」的保底。
   * 为了不让文件夹无限膨胀，只保留最近 60 份。
   */
  private async snapshot(novel: Novel): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await this.writeFile(
      `${HISTORY_DIR}/${stamp}.json`,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          project: novel.project.title,
          entities: novel.entities.length,
          novel,
        },
        null,
        2,
      ),
    )
    const names = (await this.fileNames(HISTORY_DIR)).sort()
    if (names.length > 60) {
      const dir = await this.dirFor(HISTORY_DIR, false)
      for (const old of names.slice(0, names.length - 60)) {
        await dir.removeEntry(old).catch(() => undefined)
      }
    }
  }
}


/* ============================================================
   当前生效的适配器

   默认是 localStorage，用户选了文件夹之后由 store 换成 FileStorage。
   切换的唯一入口就是下面的 setStorage，界面完全不需要知道。
   ============================================================ */

let current: StorageAdapter = new LocalStorageAdapter()

export function getStorage(): StorageAdapter {
  return current
}

export function setStorage(next: StorageAdapter): void {
  current = next
}

export function useLocalStorageFallback(): void {
  current = new LocalStorageAdapter()
}

export { LocalStorageAdapter }

/**
 * 导出功能的共用实现：摊成文件清单，写成一个 JSON。
 *
 * 返回 null 表示作者在另存为窗口里点了取消（桌面版）—— 调用方据此
 * 不显示「已导出」，而不是假装成功。
 *
 * 为什么桌面版必须换一条路：浏览器里用 Blob + <a download> 就能下载，
 * 而在 WebView2 里那次下载要交给宿主程序处理，Tauri 没装下载处理器，
 * 于是点下去**什么都不发生也不报错**。所以桌面版弹系统的另存为窗口，
 * 由 Rust 直接写文件。
 */
export async function exportBundle(novel: Novel): Promise<number | null> {
  const files = await novelToFiles(novel)
  const text = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      project: novel.project.title,
      fileCount: files.length,
      files,
    },
    null,
    2,
  )
  const name = `${safeFileName(novel.project.title)}-世界观导出.json`

  // 动态 import：避免 storage 和 storage-tauri 之间出现顶层循环依赖
  const { isTauri } = await import('./storage-tauri')
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    const saved = await invoke<string | null>('export_text', { fileName: name, text })
    return saved ? files.length : null
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
  return files.length
}
