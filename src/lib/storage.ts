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
  NOVELS_ROOT,
  novelFromDir,
  novelToFiles,
} from './novelfs'
import { safeFileName } from './frontmatter'

const LS_PREFIX = 'novel-studio:'
const LS_INDEX = `${LS_PREFIX}projects`
const LS_ROOT = `${LS_PREFIX}fs-root`
const IDB_NAME = 'novel-studio'
const IDB_STORE = 'handles'
const IDB_KEY = 'library-root'

const novelKey = (id: string) => `${LS_PREFIX}novel:${id}`

export interface ProjectSummary {
  id: string
  title: string
  logline?: string
  updatedAt: number
  entityCount: number
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

  /** 浏览器存储没有「外部改动」这个概念，永远返回 null */
  async signatureOf(): Promise<string | null> {
    return null
  }
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

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idbOpen()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function idbGet<T>(key: string): Promise<T | null> {
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
export function supportsFileSystem(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export class FileStorage implements StorageAdapter {
  readonly kind = 'filesystem'

  private constructor(private root: FileSystemDirectoryHandle) {}

  get rootName(): string {
    return this.root.name
  }

  /** 让用户选一个小说库文件夹 */
  static async pick(): Promise<FileStorage | null> {
    if (!supportsFileSystem()) return null
    const handle = await window.showDirectoryPicker!({
      id: 'novel-studio-library',
      mode: 'readwrite',
      startIn: 'documents',
    })
    await idbSet(IDB_KEY, handle)
    return new FileStorage(handle)
  }

  /** 尝试恢复上次选的文件夹。返回 null 表示需要用户重新授权。 */
  static async restore(): Promise<FileStorage | null> {
    const handle = await idbGet<FileSystemDirectoryHandle>(IDB_KEY)
    if (!handle) return null
    const perm = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt'
    if (perm === 'granted') return new FileStorage(handle)
    // 不静默请求权限：浏览器要求必须由用户手势触发
    localStorage.setItem(LS_ROOT, handle.name)
    return null
  }

  /** 重新请求权限。必须在用户点击事件里调用。 */
  static async reauthorize(): Promise<FileStorage | null> {
    const handle = await idbGet<FileSystemDirectoryHandle>(IDB_KEY)
    if (!handle) return null
    const perm = await handle.requestPermission?.({ mode: 'readwrite' })
    if (perm === 'granted') return new FileStorage(handle)
    return null
  }

  static async hasSaved(): Promise<string | null> {
    const handle = await idbGet<FileSystemDirectoryHandle>(IDB_KEY)
    return handle ? handle.name : null
  }

  /** 上一次用过文件夹的名字，用于界面提示 */
  static lastRootName(): string | null {
    return localStorage.getItem(LS_ROOT)
  }

  static async forget(): Promise<void> {
    await idbSet(IDB_KEY, null)
    localStorage.removeItem(LS_ROOT)
  }

  /* ---------- 路径操作 ---------- */

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

  private async readFile(path: string): Promise<string | null> {
    try {
      const parts = path.split('/')
      const fileName = parts.pop()!
      const dir = await this.dirFor(parts.join('/'), false)
      const fh = await dir.getFileHandle(fileName)
      return await (await fh.getFile()).text()
    } catch {
      return null
    }
  }

  private async dirNames(path: string): Promise<string[]> {
    try {
      const dir = await this.dirFor(path, false)
      const out: string[] = []
      for await (const entry of dir.values()) {
        if (entry.kind === 'directory') out.push(entry.name)
      }
      return out
    } catch {
      return []
    }
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

  private folderOf(novel: Novel): string {
    return `${NOVELS_ROOT}/${safeFileName(novel.project.title)}`
  }

  /* ---------- 外部改动检测 ---------- */

  /**
   * 计算一个小说文件夹的指纹：全部文件的路径 + 修改时间。
   *
   * 为什么用指纹而不是直接比对内容：
   * 每隔几秒把几百个文件读一遍是浪费。指纹只看元信息，很便宜；
   * 只有指纹变了才值得去读内容。
   *
   * 刻意排除 历史/ 目录：那是我们自己每次保存都写的快照，
   * 把它算进指纹会导致每秒都判定为「被外部改过」，永远在误报。
   * 同理排除编辑器留下的临时文件和隐藏文件。
   */
  async signature(folder: string): Promise<string | null> {
    try {
      const entries: Array<[string, number]> = []

      const walk = async (dir: string, prefix: string): Promise<void> => {
        const handle = await this.dirFor(dir, false)
        for await (const entry of handle.values()) {
          const name = entry.name
          if (name.startsWith('.')) continue
          if (name.endsWith('.tmp')) continue
          const path = prefix ? `${prefix}/${name}` : name
          if (entry.kind === 'directory') {
            if (entry.name === HISTORY_DIR) continue
            await walk(`${dir}/${name}`, path)
            continue
          }
          if (!/\.(md|json)$/i.test(name)) continue
          const fh = await handle.getFileHandle(name)
          const file = await fh.getFile()
          entries.push([path, file.lastModified])
        }
      }

      await walk(folder, '')
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      return entries.map(([p, t]) => `${p}@${t}`).join('|')
    } catch {
      // 文件夹被移走或权限失效时返回 null，调用方据此提示用户
      return null
    }
  }

  /** 列表里每个项目对应的文件夹名，界面和检测都用得上 */
  async folderOfId(id: string): Promise<string | null> {
    for (const folder of await this.dirNames(NOVELS_ROOT)) {
      const meta = await this.readFile(`${NOVELS_ROOT}/${folder}/${META_FILE}`)
      if (!meta) continue
      try {
        if ((JSON.parse(meta) as Novel['project']).id === id) return folder
      } catch {
        continue
      }
    }
    return null
  }

  /* ---------- 接口实现 ---------- */

  async listProjects(): Promise<ProjectSummary[]> {
    const out: ProjectSummary[] = []
    for (const folder of await this.dirNames(NOVELS_ROOT)) {
      const meta = await this.readFile(`${NOVELS_ROOT}/${folder}/${META_FILE}`)
      if (!meta) continue
      try {
        const project = JSON.parse(meta) as Novel['project']
        // 实体数量要真数一遍，因为用户可能手改过文件夹
        let entityCount = 0
        for (const dirName of Object.values(ENTITY_DIR)) {
          entityCount += (await this.fileNames(`${NOVELS_ROOT}/${folder}/${dirName}`)).filter((n) =>
            n.toLowerCase().endsWith('.md'),
          ).length
        }
        out.push({
          id: project.id,
          title: project.title,
          logline: project.logline,
          updatedAt: project.updatedAt ?? 0,
          entityCount,
        })
      } catch {
        // 读不出来的文件夹跳过，但不要让它拖垮整个列表
        continue
      }
    }
    // 文件夹名可能被用户改过，所以按更新时间排序而不是按名字
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async read(id: string): Promise<Novel | null> {
    for (const folder of await this.dirNames(NOVELS_ROOT)) {
      const meta = await this.readFile(`${NOVELS_ROOT}/${folder}/${META_FILE}`)
      if (!meta) continue
      try {
        const project = JSON.parse(meta) as Novel['project']
        if (project.id !== id) continue
        const root = await this.dirFor(`${NOVELS_ROOT}/${folder}`, false)
        return await novelFromDir(root as never)
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * 写回。先写全部文件，再删掉已经不存在的实体文件。
   * 不做增量更新：整份写回在文件系统上是最简单也最不容易写坏的模型，
   * 而「文件数量」在这个体量下根本不是瓶颈（几百个文件，几十毫秒）。
   */
  async write(novel: Novel): Promise<void> {
    const folder = this.folderOf(novel)
    const files = novelToFiles(novel, folder)

    for (const f of files) {
      await this.writeFile(f.path, f.content)
    }

    // 清理重命名或删除后留下的孤儿文件
    const keep = new Set(
      files.map((f) => f.path.slice(folder.length + 1)),
    )
    for (const dirName of Object.values(ENTITY_DIR)) {
      for (const name of await this.fileNames(`${folder}/${dirName}`)) {
        if (!keep.has(`${dirName}/${name}`)) {
          try {
            const dir = await this.dirFor(`${folder}/${dirName}`, false)
            await dir.removeEntry(name)
          } catch {
            // 删不掉就算了，不值得让保存失败
          }
        }
      }
    }

    await this.snapshot(novel, folder).catch(() => undefined)
  }

  async remove(id: string): Promise<void> {
    for (const folder of await this.dirNames(NOVELS_ROOT)) {
      const meta = await this.readFile(`${NOVELS_ROOT}/${folder}/${META_FILE}`)
      if (!meta) continue
      try {
        if ((JSON.parse(meta) as Novel['project']).id !== id) continue
        const root = await this.dirFor(NOVELS_ROOT, false)
        await root.removeEntry(folder, { recursive: true })
      } catch {
        continue
      }
    }
  }

  async filesOf(novel: Novel) {
    return novelToFiles(novel)
  }

  /** 按项目 id 找到它的文件夹并取指纹 */
  async signatureOf(novel: Novel): Promise<string | null> {
    const folder = await this.folderOfId(novel.project.id)
    if (!folder) return null
    return this.signature(`${NOVELS_ROOT}/${folder}`)
  }

  /* ---------- 版本快照 ---------- */

  /**
   * 每次保存留一份快照，文件名是时间戳。
   * 这不是 Git，是「出事了能翻回去」的保底。
   * 真正的 Git 历史等套 Tauri 壳之后交给 Rust 侧的 git2 做，
   * 那样才是逐行 diff 的正确形态。
   * 为了不让文件夹无限膨胀，只保留最近 60 份。
   */
  private async snapshot(novel: Novel, folder: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await this.writeFile(
      `${folder}/${HISTORY_DIR}/${stamp}.json`,
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
    const names = (await this.fileNames(`${folder}/${HISTORY_DIR}`)).sort()
    if (names.length > 60) {
      const dir = await this.dirFor(`${folder}/${HISTORY_DIR}`, false)
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

/** 导出功能的共用实现：摊成文件清单后打包下载 */
export async function exportBundle(novel: Novel): Promise<number> {
  const files = await novelToFiles(novel)
  const blob = new Blob(
    [
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          project: novel.project.title,
          fileCount: files.length,
          files,
        },
        null,
        2,
      ),
    ],
    { type: 'application/json' },
  )
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeFileName(novel.project.title)}-世界观导出.json`
  a.click()
  URL.revokeObjectURL(url)
  return files.length
}
