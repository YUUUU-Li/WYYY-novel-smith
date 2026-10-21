/* ============================================================
   Tauri 存储适配器

   这就是当初说的那层封装：整个应用只有这一个地方需要为「桌面版」
   写新代码，界面一行都不用改。

   它实现了和浏览器版完全相同的 StorageAdapter 接口：
     listProjects / read / write / remove / filesOf / signatureOf

   与浏览器版的关键差别：
   浏览器版受制于 File System Access API —— 权限会被收回、每次启动
   需要用户点一次授权、拿不到真实路径。桌面版没有这些问题，
   因为它直接调 Rust 读写磁盘。

   互操作的关键设计：**文件夹格式与浏览器版完全一致**。
   两边共享同一份路径常量与命名规则，由 scripts/disk-format-test.ts
   钉死（Rust 侧 src-tauri/src/tests.rs 是它的镜像）。
   所以你可以今天用浏览器版写，明天用桌面版继续，或者反过来。
   ============================================================ */

import type { Novel } from './types'
import type { ProjectSummary, StorageAdapter } from './storage'
import { parseEntity, serializeEntity } from './frontmatter'

/** Tauri 在页面里注入的运行时标记 */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isTauri(): boolean {
  return inTauri()
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/**
 * 懒加载 Tauri 的 invoke。
 *
 * 用动态 import 而不是顶层 import 的原因：
 * 顶层 import 会让浏览器形态也必须装 @tauri-apps/api 才能启动。
 * 这个模块整体也是被动态引入的，浏览器形态下永远不会执行到。
 */
async function getInvoke(): Promise<Invoke> {
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke as Invoke
}

/**
 * Rust 侧返回的形状。
 * 字段用 camelCase —— Rust 结构体上标了 #[serde(rename_all = "camelCase")]。
 * 两边必须完全一致：不一致的话拿到的会是 undefined，
 * 而且是编译期查不出来的那种错误。
 */
interface TauriSummary {
  id: string
  title: string
  logline: string
  updatedAt: number
  entityCount: number
  counts: Record<string, number>
}

interface TauriRawNovel {
  project: Novel['project']
  /** 每个实体的原始 Markdown 文本，解析交给前端已经测过的解析器 */
  rawEntities: Array<{ raw: string; file: string }>
  outline: Novel['outline']
  terms: Novel['terms']
}

export class TauriStorage implements StorageAdapter {
  readonly kind = 'tauri'

  constructor(private root: string) {}

  get rootName(): string {
    // 只显示最后一级目录名，和浏览器版保持一致的信息量
    const parts = this.root.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] ?? this.root
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const invoke = await getInvoke()
    const rows = await invoke<TauriSummary[]>('list_projects', { root: this.root })
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      logline: r.logline || undefined,
      updatedAt: r.updatedAt,
      entityCount: r.entityCount,
    }))
  }

  async read(id: string): Promise<Novel | null> {
    const invoke = await getInvoke()
    const raw = await invoke<TauriRawNovel | null>('read_novel', { root: this.root, id })
    if (!raw) return null

    // Rust 侧不做 front matter 解析：那边重写一份解析器没有意义，
    // 而前端这份已经过了 29 项往返测试。
    const entities = raw.rawEntities
      .map((r) => parseEntity(r.raw, { file: r.file }))
      .filter((e) => e.id)

    return {
      project: raw.project,
      entities,
      outline: Array.isArray(raw.outline) ? raw.outline : [],
      terms: Array.isArray(raw.terms) ? raw.terms : [],
    }
  }

  async write(novel: Novel): Promise<void> {
    const invoke = await getInvoke()
    await invoke('write_novel', {
      root: this.root,
      project: novel.project,
      // 序列化成 Markdown 在前端做，与浏览器版共用同一个序列化器，
      // 保证两种形态产出的文件逐字节一致
      entities: novel.entities.map((e) => ({
        type: e.type,
        name: e.name,
        raw: serializeEntity(e),
      })),
      outline: novel.outline,
      terms: novel.terms,
    })
  }

  async remove(id: string): Promise<void> {
    const invoke = await getInvoke()
    await invoke('delete_novel', { root: this.root, id })
  }

  /** 导出与浏览器版共用同一份布局函数，保证两边结构一致 */
  async filesOf(novel: Novel) {
    const { novelToFiles } = await import('./novelfs')
    return novelToFiles(novel)
  }

  /**
   * 桌面版没有「外部改动检测」这个必要 —— 浏览器版需要它是因为
   * 权限模型导致的间接访问，而桌面版直接读写磁盘，改动立刻可见。
   * 返回 null 即表示不支持，store 会自动跳过检测。
   */
  async signatureOf(): Promise<string | null> {
    return null
  }
}

/** 弹系统对话框选小说库文件夹 */
export async function pickLibraryFolder(): Promise<TauriStorage | null> {
  if (!inTauri()) return null
  const invoke = await getInvoke()
  const picked = await invoke<string | null>('pick_library')
  return picked ? new TauriStorage(picked) : null
}

/**
 * 把小说库路径存起来，下次启动直接恢复。
 * 桌面版不需要重新授权，所以这比浏览器版简单得多。
 */
const LS_ROOT = 'novel-studio:tauri-root'

export function rememberRoot(root: string): void {
  try {
    localStorage.setItem(LS_ROOT, root)
  } catch {
    // 存不了就算了，不影响本次使用
  }
}

export function lastRoot(): string | null {
  try {
    return localStorage.getItem(LS_ROOT)
  } catch {
    return null
  }
}

/** 启动时尝试恢复上次的小说库 */
export function restoreTauriStorage(): TauriStorage | null {
  if (!inTauri()) return null
  const root = lastRoot()
  return root ? new TauriStorage(root) : null
}
