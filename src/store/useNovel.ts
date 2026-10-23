/* ============================================================
   全局状态

   策略：一次读入内存，所有操作在内存里做，变更后自动落盘。
   不写增量更新，因为「整份写回」在文件系统上才是最自然的模型，
   也是将来换 Tauri 时唯一能保持行为一致的做法。

   落盘用防抖（600ms），所以连续打字不会疯狂写盘。
   ============================================================ */

import { create } from 'zustand'
import type {
  Entity,
  EntityFolder,
  EntityType,
  Novel,
  NovelIndex,
  OutlineNode,
  Project,
  TimelineBoard,
  WorldMap,
} from '../lib/types'
import { createEntity, createProject, uid } from '../lib/types'
import {
  ROOT,
  containerOf,
  deleteFolder as deleteFolderIn,
  materializeRoot,
  moveItem as moveItemIn,
  newFolder,
  normalizeOrg,
  placeItem as placeItemIn,
  reorderVisible,
  unplaceItem as unplaceItemIn,
} from '../lib/org'
import { buildIndex, projectUpdated } from '../lib/index-builder'
import { stripForNewCalendar, stripOutlineDates } from '../lib/dates'
import { describeDiff, sameContent } from '../lib/compare'
import { runSave, type SaveState } from '../lib/save-status'
import { remapDeletedRegions } from '../lib/places'
import { normalizeBoards } from '../lib/boards'
import { migrateTerms } from '../lib/terms-migration'
import { UndoStack } from '../lib/undo-stack'

import {
  FileStorage,
  LocalStorageAdapter,
  getStorage,
  setStorage,
  supportsFileSystem,
  useLocalStorageFallback,
  type ProjectSummary,
  type StorageAdapter,
} from '../lib/storage'

/* 作品注册表：一个文件夹就是一部作品，列表来自这里 + 内部存储。 */
import {
  clearHandle,
  dropWork,
  loadHandle,
  loadWorks,
  stashHandle,
  upsertWork,
} from '../lib/works'

/* 桌面版的存储层。装在 Tauri 壳里时它会接管「选文件夹」和读写磁盘；
   在浏览器里 isTauri() 是 false，这些函数一个都不会被调用。 */
import {
  TauriStorage,

  isTauri,
  pickLibraryFolder,
  rememberRoot,
} from '../lib/storage-tauri'

/** 持久化位置。界面要显示「存在哪」，所以它是状态的一部分。 */
export type StorageMode = 'localStorage' | 'filesystem'

export type ViewId =
  | 'overview'
  | 'entities'
  /** 关系网：拖词条进来、自己摆位、自己连线 */
  | 'sketch'
  | 'timeline'
  | 'maps'
  | 'outline'

/**
 * 撤回栈里每一步带上的"界面上下文"。
 *
 * 只有一样东西：当时作者在哪个页面。目的是撤回的时候把画面也带回去 ——
 * 否则在地图页按 Ctrl+Z，数据退回去了、屏幕一动不动，看着像没生效。
 */
export interface UndoContext {
  view: ViewId
}

interface State {
  ready: boolean
  summaries: ProjectSummary[]
  novel: Novel | null
  index: NovelIndex | null

  selectedId: string | null
  view: ViewId
  /** 侧栏是否收起，写作时能腾出空间 */
  railCollapsed: boolean
  searchQuery: string
  /** 全文搜索浮层是否打开 */
  searchOpen: boolean

  /** 当前存在哪。filesystem 时 rootName 是文件夹名。 */
  storageMode: StorageMode
  rootName: string | null
  canUseFilesystem: boolean

  /**
   * 检测到「文件被程序之外的东西改过」时挂在这里。
   * null 表示没有待处理的外部改动。
   */
  /**
   * 需要作者裁决的磁盘变动。
   *
   * `kind` 必须分开：这两种情况看着像同一件事，实际处理完全不同 ——
   *   changed：文件真的被改过，要问「用哪一边」
   *   missing：文件夹找不到了，那就不存在"载入磁盘版本"这回事，
   *            该做的是重新选一次文件夹。以前两者共用一句话，
   *            结果在最容易吓到人的那种情况下给出了三个都没用的按钮。
   */
  diskChange: { at: number; summary: string; kind: 'changed' | 'missing' } | null

  /** 落盘状态。写盘失败必须浮到界面上，不能静默吞掉 */
  saveState: SaveState
  /** 写盘失败后的手动重试 */
  retrySave: () => Promise<void>

  /* ---- 撤回 / 重做 ----
     整个应用只有这一套：不管在设定、大纲、地图、时间线还是关系网里改的，
     都是同一个栈。理由见 lib/undo-stack.ts 顶部。 */
  undoDepth: number
  redoDepth: number
  /** 给按钮 tooltip 用：「撤回：删除条目」 */
  undoLabel: string | null
  redoLabel: string | null
  undo: () => void
  redo: () => void
  /**
   * 撤回 / 重做把画面带回来之后，界面上闪一下的计数器（只增不减）。
   * 界面拿它当 key 播一次动画：告诉作者「这一页刚刚变过」。
   */
  flashKey: number
  /** 立刻落盘一次（关窗、换作品之前用），不等那个防抖计时器 */
  flushNow: () => Promise<void>

  init: () => Promise<void>
  openProject: (id: string) => Promise<void>
  newProject: (title: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  backToLibrary: () => void

  /** 打开一个已经存在的作品文件夹，登记进作品库并进入 */
  openWorkFolder: () => Promise<void>
  /** 作品文件夹被改名/挪走之后，重新指过去（只更新记账，不搬文件） */
  relocateWork: (id: string) => Promise<void>
  /** 作者自己写"这部作品在哪"（浏览器版拿不到父目录，靠它补全层级） */
  setWorkLabel: (id: string, label: string) => Promise<void>
  /** 轮询入口：指纹变了就去看内容，内容真变了才提示 */
  checkDisk: () => Promise<void>
  /** 接受磁盘版本：丢弃内存改动，重新加载 */
  applyDiskVersion: () => Promise<void>
  /** 保留内存版本：重新写回磁盘，覆盖外部改动 */
  keepMemoryVersion: () => Promise<void>
  /** 只是知道了，不做任何事（下次保存照样会覆盖磁盘） */
  dismissDiskChange: () => void

  setView: (v: ViewId) => void
  select: (id: string | null) => void
  toggleRail: () => void
  setSearch: (q: string) => void
  setSearchOpen: (open: boolean) => void

  updateProject: (patch: Partial<Project>) => void
  /**
   * 换一套纪时方法。
   * 会顺带清理已有时间里「新历法解释不了」的字段（纪元名、月名），
   * 只保留年份 —— 详见实现里的注释。
   */
  applyCalendar: (calendar: Project['calendar']) => void
  addEntity: (type: EntityType, name?: string, container?: string) => Entity | null
  updateEntity: (id: string, patch: Partial<Entity>) => void
  deleteEntity: (id: string) => void
  /**
   * 在某个事件里当场新建一个角色，并连上「参与」。
   *
   * 和「新建词条」的区别：它不改当前选中项 —— 你正在写这个事件，
   * 只是顺手把一个还没建过的名字拉进来，不该被弹到另一个页面去。
   */
  addCast: (eventId: string, name: string) => Entity | null

  setOutline: (nodes: OutlineNode[]) => void
  setMaps: (maps: WorldMap[]) => void
  /** 手工摆的时间线。整组换掉（和 setMaps 一样，变换都在 lib/boards.ts 里做） */
  setBoards: (boards: TimelineBoard[]) => void

  /* ---- 设定页的组织：词条夹与手写顺序 ---- */

  /** 在某个容器里新建一个词条夹 */
  addFolder: (name: string, container: string) => EntityFolder
  updateFolder: (id: string, patch: Partial<Pick<EntityFolder, 'name' | 'desc'>>) => void
  /** 删夹子：里面的东西上交到上一层，绝不跟着删 */
  removeFolder: (id: string) => void
  /** 把条目或夹子挪到某个容器的第 index 位。visible 是屏幕上那一列的顺序。
      from 是「这张卡片原本在哪个容器」—— 条目可以摆在多处，得说清搬的是哪一份 */
  moveOrgItem: (
    id: string,
    toContainer: string,
    index: number,
    visible?: string[],
    from?: string,
  ) => void
  /** 再放一份：同一个条目在另一个夹子里也显示一份（只复制位置，不复制数据） */
  placeOrgItem: (id: string, toContainer: string) => void
  /** 撤掉某一处摆放，条目本身留着 */
  unplaceOrgItem: (id: string, fromContainer: string) => void
}

/** 索引重建：只在结构变化时做，纯正文编辑跳过，避免白算 */
function reindex(novel: Novel): NovelIndex {
  return buildIndex(novel)
}

/**
 * 任何一份小说进入内存前都从这里过一遍。
 * 补齐词条夹字段（老 novel.json 里没有），顺手把索引建好 ——
 * 少写一个 adopt 就会让界面上某处拿到 folders === undefined。
 *
 * 这里同时做「字典 → 概念」的迁移：词条和条目几乎是同一个东西，分开存
 * 必然出矛盾（[[息]] 的跳转只认条目）。迁移是幂等的，词条清空之后再进来
 * 就什么都不做；`changed` 用来决定要不要顺手落一次盘。
 */
function adopt(n: Novel): {
  novel: Novel
  index: NovelIndex
  migratedTerms: boolean
} {
  const proj = normalizeOrg(n.project)
  const base: Novel = {
    ...n,
    project: { ...proj, boards: normalizeBoards(proj) },
  }
  const t = migrateTerms(base)
  const fixed = t.novel
  return { novel: fixed, index: buildIndex(fixed), migratedTerms: t.changed }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<State>((set, get) => {
  /**
   * 上次我们自己写盘之后的文件夹指纹。
   *
   * 放在模块作用域而不是 store 状态里：它只是内部记账，
   * 变化不需要触发任何渲染，放进状态只会造成无意义的重渲染。
   */
  let diskBaseline: string | null = null

  /* 撤回栈。放在模块作用域（不进 React 状态）：它只是记账，
     真正需要重渲染的只有 undoDepth / undoLabel 这几个数字。 */
  const history = new UndoStack<Novel, UndoContext>(40, 700)

  /** 写盘之后重新取基线。不做这一步，我们自己的保存会被误判成外部改动 */
  const refreshBaseline = async (novel: Novel): Promise<void> => {
    const store = getStorage()
    if (!store.signatureOf) {
      diskBaseline = null
      return
    }
    diskBaseline = await store.signatureOf(novel).catch(() => null)
  }

  /** 安排一次落盘。防抖，合并同一批改动 */
  const scheduleSave = (ms = 600) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void flushSave()
    }, ms)
  }

  /** 提交一次内存变更并安排落盘。
   *
   *  `label` 是给撤回按钮看的（「撤回：删除条目」）。同一标签的连续改动
   *  会被撤回栈合并成一步 —— 否则打一行字要点几十次撤回。 */
  const commit = (mutate: (n: Novel) => Novel, reindexToo = true, label = '编辑') => {
    const cur = get().novel
    if (!cur) return
    const next = mutate(cur)
    next.project = projectUpdated(normalizeOrg(next.project))
    history.record(cur, label, { view: get().view })
    set({
      novel: next,
      index: reindexToo ? reindex(next) : get().index,
      // 内存已改但还没落盘。作者应该能看见「有未保存的改动」，
      // 而不是在磁盘满、权限失效时一直以为存上了。
      saveState: { kind: 'idle' },
      undoDepth: history.undoDepth,
      redoDepth: history.redoDepth,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    })
    scheduleSave()
  }

  /**
   * 把撤回/重做拿到的快照装回界面。选中的条目可能已经不在了，得让位。
   *
   * `ctx` 是那一步发生在哪个页面：把画面也切回去。少了这一步，撤回发生在
   * 别的页面上时屏幕一动不动 —— 数据退了，作者却看不出来。
   *
   * 顺带把 flashKey 加一：即使这一步本来就在当前页面，也让界面闪一下，
   * 眼睛能接住「这里刚刚变了」。
   */
  const restoreSnapshot = (target: Novel, ctx?: UndoContext) => {
    const sel = get().selectedId
    set((s) => ({
      novel: target,
      index: reindex(target),
      selectedId: sel && target.entities.some((e) => e.id === sel) ? sel : null,
      ...(ctx ? { view: ctx.view } : {}),
      flashKey: s.flashKey + 1,
      saveState: { kind: 'idle' },
      undoDepth: history.undoDepth,
      redoDepth: history.redoDepth,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    }))
    // 撤回也是一次真实改动，必须落盘，否则关掉程序就白撤了
    scheduleSave(120)
  }

  /** 换作品 / 换存储位置 / 接受磁盘版本时调用：不能撤到别的内容里去 */
  const clearHistory = () => {
    history.clear()
    set({ undoDepth: 0, redoDepth: 0, undoLabel: null, redoLabel: null })
  }

  /**
   * 真正落盘一次。
   * 抽成函数而不是内联在计时器里，是因为「保存失败后重试」也要用它。
   */
  const flushSave = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const n = get().novel
    if (!n) return
    const store = getStorage()
    set({ saveState: { kind: 'saving' } })

    const result = await runSave(
      () => store.write(n),
      async () => {
        // 先更新基线再列项目：基线必须在磁盘状态稳定之后取
        await refreshBaseline(n)
        set({ summaries: await refreshSummaries() })
      },
      Date.now(),
    )
    set({ saveState: result })
  }

  /**
   * 作品库列表 = 注册表里的作品文件夹 + 内部存储里的作品。
   *
   * 以前这里是 store.listProjects()：因为那时候一个"小说库根目录"里装着
   * 所有作品，扫一遍就有列表。现在一个文件夹就是一部作品，没有可以扫的
   * 统一目录了，所以列表来自记账 + 内部存储两处。
   */
  /**
   * 同一部作品可能既在注册表里、又还留在内部存储里（早期版本写进浏览器
   * 的那一份）。不按 id 去重的话作品库会出现两张同名卡片，而且其中一张
   * 是旧副本 —— 打开它是看不到新改动的。文件夹版本的优先级更高。
   */
  const dedupe = (rows: ProjectSummary[]): ProjectSummary[] => {
    const seen = new Set<string>()
    const out: ProjectSummary[] = []
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const refreshSummaries = async (): Promise<ProjectSummary[]> => {
    const internal = await new LocalStorageAdapter().listProjects().catch(() => [])
    const folderWorks = loadWorks().filter((w) => w.kind === 'folder')
    const rows: ProjectSummary[] = [
      ...folderWorks.map((w) => ({
        id: w.id,
        title: w.title,
        updatedAt: w.updatedAt,
        entityCount: w.entityCount,
        kind: 'folder' as const,
        location: w.folderName || w.path || '作品文件夹',
        locationPath: w.path,
        locationLabel: w.label,
      })),
      ...internal.map((s) => ({ ...s, kind: 'internal' as const, location: '程序内部存储' })),
    ]
    return dedupe(rows)
  }

  return {
    ready: false,
    summaries: [],
    novel: null,
    index: null,
    selectedId: null,
    view: 'overview',
    /* 一打开就是收起的：左边那栏（搜索 + 词条速览）留给需要时再展开，
       默认先让列表和正文占满宽度。 */
    railCollapsed: true,
    searchQuery: '',
    searchOpen: false,
    storageMode: 'localStorage',
    rootName: null,
    canUseFilesystem: supportsFileSystem() || isTauri(),
    diskChange: null,
    saveState: { kind: 'idle' },
    undoDepth: 0,
    redoDepth: 0,
    undoLabel: null,
    redoLabel: null,
    flashKey: 0,

    init: async () => {
      /* 一进来永远是作品库。
         现在没有"小说库根目录"这个概念了：一个文件夹就是一部作品，
         列表来自两处 —— 内部存储里的作品（还没选文件夹时用的），
         以及注册表里记着的那几个作品文件夹。 */
      const internal = await new LocalStorageAdapter().listProjects().catch(() => [])
      const folderWorks = loadWorks().filter((w) => w.kind === 'folder')
      const summaries: ProjectSummary[] = [
        ...folderWorks.map((w) => ({
          id: w.id,
          title: w.title,
          updatedAt: w.updatedAt,
          entityCount: w.entityCount,
          // 位置是作品自己的属性，不是"当前打开的那本"
          kind: 'folder' as const,
          location: w.folderName || w.path || '作品文件夹',
          locationPath: w.path,
          locationLabel: w.label,
        })),
        ...internal.map((s) => ({ ...s, kind: 'internal' as const, location: '程序内部存储' })),
      ]
      const sorted = dedupe(summaries)
      set({
        novel: null,
        index: null,
        summaries: sorted,
        storageMode: 'localStorage',
        rootName: null,
        ready: true,
      })
    },

    openProject: async (id) => {
      const ref = loadWorks().find((w) => w.id === id)

      /* 内部存储里的作品：列表项没有 ref，直接走 LocalStorageAdapter */
      if (!ref || ref.kind === 'internal') {
        useLocalStorageFallback()
        const n = await getStorage().read(id)
        if (!n) return
        const adopted = adopt(n)
        clearHistory()
        set({
          novel: adopted.novel,
          index: adopted.index,
          selectedId: null,
          view: 'overview',
          searchQuery: '',
          diskChange: null,
          storageMode: 'localStorage',
          rootName: null,
        })
        await refreshBaseline(n)
        if (adopted.migratedTerms) scheduleSave()
        return
      }

      /* 作品文件夹：按注册表里记的位置把适配器接上 */
      let next: StorageAdapter | null = null
      if (isTauri()) {
        if (!ref.path) return
        next = new TauriStorage(ref.path)
      } else {
        if (!ref.handleKey) return
        const handle = await loadHandle(ref.handleKey).catch(() => null)
        if (!handle) {
          throw new Error('浏览器把这个文件夹的访问权限收回了，请重新「打开作品文件夹」指一次。')
        }
        const perm = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
        const ok = perm === 'granted' ? 'granted' : await handle.requestPermission?.({ mode: 'readwrite' })
        if (ok !== 'granted') throw new Error('需要你允许读写这个文件夹才能打开作品。')
        next = FileStorage.wrap(handle)
      }

      setStorage(next)
      const n = await next.read(id).catch(() => null)
      if (!n) throw new Error('这个文件夹里找不到 novel.json，可能被移动或改名了。')
      const adopted = adopt(n)
      clearHistory()
      set({
        novel: adopted.novel,
        index: adopted.index,
        selectedId: null,
        view: 'overview',
        searchQuery: '',
        diskChange: null,
        storageMode: 'filesystem',
        rootName: next.rootName,
      })
      await refreshBaseline(n)
      if (adopted.migratedTerms) scheduleSave()
    },

    /**
     * 新建作品。
     *
     * 「文件夹即作品」之后，新建 = 先要一个文件夹：
     * 桌面版弹系统对话框，浏览器版弹文件夹选择器。选中的文件夹就是这个
     * 作品的家，novel.json 和各类型目录直接写在它下面。
     * 没有文件夹能力的环境（Firefox/Safari）退回内部存储。
     */
    newProject: async (title) => {
      const project = createProject(title)
      const novel: Novel = { project, entities: [], outline: [], terms: [] }

      if (isTauri()) {
        const picked = await pickLibraryFolder()
        if (!picked) return
        await picked.write(novel)
        rememberRoot(picked.root)
        upsertWork({
          id: project.id,
          kind: 'folder',
          title: project.title,
          folderName: picked.rootName ?? '',
          path: picked.root,
          updatedAt: project.updatedAt ?? Date.now(),
          entityCount: 0,
        })
        setStorage(picked)
      } else if (supportsFileSystem()) {
        const picked = await FileStorage.pick()
        if (!picked) return
        await picked.write(novel)
        const key = await stashHandle(project.id, picked.handle)
        upsertWork({
          id: project.id,
          kind: 'folder',
          title: project.title,
          folderName: picked.rootName ?? '',
          handleKey: key,
          updatedAt: project.updatedAt ?? Date.now(),
          entityCount: 0,
        })
        setStorage(picked)
      } else {
        // 没有文件夹能力：留在内部存储
        useLocalStorageFallback()
        await getStorage().write(novel)
        upsertWork({
          id: project.id,
          kind: 'internal',
          title: project.title,
          folderName: '',
          updatedAt: project.updatedAt ?? Date.now(),
          entityCount: 0,
        })
      }

      clearHistory()
      set({
        novel,
        index: reindex(novel),
        summaries: await refreshSummaries(),
        selectedId: null,
        view: 'overview',
        searchQuery: '',
        storageMode: isTauri() || supportsFileSystem() ? 'filesystem' : 'localStorage',
        rootName: getStorage().rootName,
      })
    },

    /**
     * 从作品库移出。
     *
     * 只移除"列表里的这一条"，**不动磁盘上的文件夹** —— 在「文件夹即作品」
     * 之后，删除列表项和删除作品是两件事，而后者风险太大，不该藏在一个
     * 小垃圾桶图标后面。想真删，去文件管理器里删那个文件夹。
     */
    deleteProject: async (id) => {
      const ref = loadWorks().find((w) => w.id === id)
      if (ref && ref.kind === 'folder') {
        if (ref.handleKey) clearHandle(id)
        dropWork(id)
      } else {
        useLocalStorageFallback()
        await getStorage().remove(id)
        dropWork(id)
      }
      set({
        summaries: await refreshSummaries(),
        novel: get().novel?.project.id === id ? null : get().novel,
        index: get().novel?.project.id === id ? null : get().index,
      })
    },


    backToLibrary: () => {
      clearHistory()
      set({ novel: null, index: null, selectedId: null })
    },

    setView: (view) => set({ view }),
    select: (selectedId) => set({ selectedId }),
    toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
    setSearch: (searchQuery) => set({ searchQuery }),
    setSearchOpen: (searchOpen) => set({ searchOpen }),

    updateProject: (patch) =>
      commit((n) => ({ ...n, project: { ...n.project, ...patch } }), false, '改作品信息'),

    /* ---------- 撤回 / 重做 ---------- */

    /** 关窗 / 换作品前用：不等防抖，立刻写一次 */
    flushNow: () => flushSave(),

    undo: () => {
      const n = get().novel
      if (!n) return
      const prev = history.undo(n)
      if (prev) restoreSnapshot(prev.state, prev.context)
    },

    redo: () => {
      const n = get().novel
      if (!n) return
      const next = history.redo(n)
      if (next) restoreSnapshot(next.state, next.context)
    },

    applyCalendar: (calendar) =>
      commit((n) => ({
        ...n,
        project: { ...n.project, calendar },
        /* 换历法时要把时间里「新历法解释不了」的部分清掉，
           否则会显示出怪东西：旧纪元名在新历法里不存在，
           月名也对不上（「霜月」在农历里没有对应）。
           保留年份是刻意的 —— 它是唯一可能仍然有意义的字段，
           而且作者已经为它付出过输入成本。 */
        entities: n.entities.map((e) => ({
          ...e,
          date: stripForNewCalendar(e.date),
          dateEnd: stripForNewCalendar(e.dateEnd),
        })),
        outline: stripOutlineDates(n.outline),
      }), false, '换纪时方法'),

    addEntity: (type, name, container) => {
      const entity = createEntity(type, name ?? `新${labelOf(type)}`)
      commit((n) => {
        const withEntity: Novel = { ...n, entities: [...n.entities, entity] }
        // 在当前词条夹里新建的，要直接落进这个夹子；否则它会掉到顶层末尾
        if (!container || container === ROOT) return withEntity
        const proj = normalizeOrg(withEntity.project)
        const target = proj.folders.find((f) => f.id === container)
        if (!target) return withEntity
        const placed = moveItemIn(proj, entity.id, container, target.items.length)
        return {
          ...withEntity,
          project: { ...withEntity.project, folders: placed.folders, rootItems: placed.rootItems },
        }
      }, true, '新建条目')
      set({ selectedId: entity.id })
      return entity
    },

    updateEntity: (id, patch) =>
      commit((n) => ({
        ...n,
        entities: n.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      }), true, '编辑条目'),

    addCast: (eventId, name) => {
      const label = name.trim()
      if (!label) return null
      const entity = createEntity('character', label)
      commit((n) => {
        /* 新建的条目不用手动塞进组织树：resolveContainer 会把「没被
           任何夹子认领的条目」按名字补在顶层。 */
        const entities = [...n.entities, entity].map((e) =>
          e.id === eventId
            ? { ...e, links: [...e.links, { to: entity.id, type: '参与' }] }
            : e,
        )
        return { ...n, entities }
      }, true, '新建角色')
      return entity
    },

    deleteEntity: (id) => {
      commit((n) => ({
        ...n,
        // 顺手把它的位置信息也清掉，别在夹子里留下指不到的 id
        project: {
          ...n.project,
          folders: normalizeOrg(n.project).folders.map((f) => ({
            ...f,
            items: f.items.filter((x) => x !== id),
          })),
          rootItems: normalizeOrg(n.project).rootItems.filter((x) => x !== id),
        },
        // 同时清掉指向它的链接，避免留下 dangling 引用
        entities: n.entities
          .filter((e) => e.id !== id)
          .map((e) => ({
            ...e,
            links: e.links.filter((l) => l.to !== id),
            at: e.at === id ? undefined : e.at,
          })),
      }), true, '删除条目')
      if (get().selectedId === id) set({ selectedId: null })
    },

    setOutline: (outline) => commit((n) => ({ ...n, outline }), true, '编辑大纲'),
    setBoards: (boards) =>
      commit((n) => ({ ...n, project: { ...n.project, boards } }), true, '编辑时间线'),

    /* 地图整体换掉（拖动图钉、改区域、删地图都会走到这里）。
       区域被删掉时，指向它的「发生地点」要改写成区域的名字 ——
       具体逻辑在 places.ts 里，这里只负责接上。 */
    setMaps: (maps) =>
      commit((n) => {
        const entities = remapDeletedRegions(n, maps)
        return {
          ...n,
          project: { ...n.project, maps },
          ...(entities ? { entities } : {}),
        }
      }, true, '编辑地图'),

    /* ---------------- 设定页的组织 ---------------- */

    addFolder: (name, container) => {
      const folder = newFolder(name)
      commit((n) => {
        const proj = materializeRoot(normalizeOrg(n.project), n)
        const folders = [...proj.folders, folder]
        // 插到最前面：新建的东西得先让人看见。
        // 手动顺序下界面就是存下来的顺序，所以插哪儿就显示在哪儿。
        const placed = moveItemIn(
          { ...proj, folders, rootItems: proj.rootItems },
          folder.id,
          container,
          0,
        )
        return { ...n, project: { ...n.project, folders: placed.folders, rootItems: placed.rootItems } }
      }, false, '新建词条夹')
      return folder
    },

    updateFolder: (id, patch) =>
      commit(
        (n) => ({
          ...n,
          project: {
            ...n.project,
            folders: normalizeOrg(n.project).folders.map((f) =>
              f.id === id ? { ...f, ...patch } : f,
            ),
          },
        }),
        false,
        '改词条夹',
      ),

    removeFolder: (id) =>
      commit(
        (n) => {
          const proj = normalizeOrg(n.project)
          const next = deleteFolderIn(proj, id)
          return { ...n, project: { ...n.project, ...next } }
        },
        false,
        '删除词条夹',
      ),

    moveOrgItem: (id, toContainer, index, visible, from) =>
      commit(
        (n) => {
          // 先把「补在末尾的」固化进 rootItems，否则拖到中间会落到最前面
          const proj = materializeRoot(normalizeOrg(n.project), n)
          const fromContainer = from ?? containerOf(proj, id)
          /* 同一个容器里换位：index 是相对屏幕那一列算的，
             所以必须用「只重排可见槽位」的方式落回去 ——
             类型筛选会藏起条目，非手动排序会换排法，直接套 index 会错位。 */
          const next =
            fromContainer !== undefined &&
            fromContainer === toContainer &&
            visible &&
            visible.length > 0
              ? reorderVisible(proj, toContainer, visible, id, index)
              : moveItemIn(proj, id, toContainer, index, fromContainer)
          return { ...n, project: { ...n.project, ...next } }
        },
        false,
        '移动条目',
      ),

    /* 「再放一份」：同一个条目在另一个夹子里也显示一份。
       复制的是**位置**，不是数据 —— 内容只有一份，所以不存在同步问题。 */
    placeOrgItem: (id, toContainer) =>
      commit(
        (n) => {
          const proj = normalizeOrg(n.project)
          const next = placeItemIn(proj, id, toContainer)
          return { ...n, project: { ...n.project, ...next } }
        },
        false,
        '再放一份',
      ),

    /* 撤掉某一处摆放。条目本身留着，别处摆的也不动 */
    unplaceOrgItem: (id, fromContainer) =>
      commit(
        (n) => {
          const proj = normalizeOrg(n.project)
          const next = unplaceItemIn(proj, id, fromContainer)
          return { ...n, project: { ...n.project, ...next } }
        },
        false,
        '撤掉一处摆放',
      ),

    /* ---------- 打开一部已有的作品文件夹 ---------- */

    /**
     * 「打开作品文件夹…」：把一个已经存在的作品文件夹登记进作品库并打开。
     *
     * 这是「文件夹即作品」之后的主要入口之一 —— 别人的作品、你以前的
     * 备份、从网盘拷回来的东西，都是指一下这个文件夹就开始用。
     * 判据很简单：这一层里有 novel.json 才算作品。
     */
    /**
     * 重新指定某部作品的位置。
     *
     * 场景：你在资源管理器里把文件夹改了个名/挪到别的盘，程序按老路径
     * 找不到它了。这时候**不要**重新导入、也不要复制 —— 直接指到它现在
     * 待的地方，程序只更新记账，一个字节都不搬。
     *
     * 校验：新文件夹里的 novel.json 必须是同一部作品（id 相同）。id 不同
     * 说明指错了文件夹，宁可拒绝也不要让人把两本书搞混。
     */
    relocateWork: async (id) => {
      const ref = loadWorks().find((w) => w.id === id)
      if (!ref) throw new Error('这部作品没有文件夹记录（它存在程序内部）。先「打开作品文件夹」把它落到磁盘上。')

      let next: StorageAdapter | null = null
      if (isTauri()) {
        next = await pickLibraryFolder()
      } else if (supportsFileSystem()) {
        const handle = await window.showDirectoryPicker!({
          id: 'novel-studio-relocate',
          mode: 'readwrite',
          startIn: 'documents',
        })
        next = FileStorage.wrap(handle)
      } else {
        throw new Error('这个浏览器不支持文件夹访问（Firefox / Safari 尚未实现）。')
      }
      if (!next) return

      const found = await next.read(id).catch(() => null)
      if (!found) {
        throw new Error(
          '这个文件夹里的作品和它不一致（novel.json 里的 id 对不上）。请选它现在所在的那个文件夹。',
        )
      }

      const patch: Partial<{ folderName: string; title: string; updatedAt: number; entityCount: number }> = {
        folderName: next.rootName ?? '',
        title: found.project.title,
        updatedAt: found.project.updatedAt ?? ref.updatedAt,
        entityCount: found.entities.length,
      }
      if (next instanceof TauriStorage) {
        upsertWork({ ...ref, ...patch, kind: 'folder', path: next.root, handleKey: undefined })
        rememberRoot(next.root)
      } else if (next instanceof FileStorage) {
        const key = await stashHandle(id, next.handle)
        upsertWork({ ...ref, ...patch, kind: 'folder', handleKey: key, path: undefined })
      }

      // 正在看这部作品的话，顺手把适配器也切过去，接着用不着再点一次
      if (get().novel?.project.id === id) {
        setStorage(next)
        set({ storageMode: 'filesystem', rootName: next.rootName, diskChange: null })
        await refreshBaseline(found)
      }
      set({ summaries: await refreshSummaries() })
    },

    setWorkLabel: async (id, label) => {
      const ref = loadWorks().find((w) => w.id === id)
      if (!ref) return
      upsertWork({ ...ref, label: label.trim() || undefined })
      set({ summaries: await refreshSummaries() })
    },

    openWorkFolder: async () => {
      const editing = get().novel
      if (editing) await getStorage().write(editing).catch(() => undefined)

      let next: StorageAdapter | null = null
      if (isTauri()) {
        next = await pickLibraryFolder()
      } else if (supportsFileSystem()) {
        const handle = await window.showDirectoryPicker!({
          id: 'novel-studio-open-work',
          mode: 'readwrite',
          startIn: 'documents',
        })
        next = FileStorage.wrap(handle)
      } else {
        throw new Error('这个浏览器不支持文件夹访问（Firefox / Safari 尚未实现）。用桌面版，或换 Edge / Chrome。')
      }
      if (!next) return

      /* 先列一遍拿到真实 id，再按 id 读。
         以前这里用 read('') 去"探测这一层有没有作品"，但磁盘侧是按 id 找作品的，
         空 id 不属于任何作品，于是好好的文件夹会被判成"里面没有 novel.json"。 */
      const found = await next.listProjects().catch(() => [])
      const novel = found.length > 0 ? await next.read(found[0].id).catch(() => null) : null
      if (!novel) {
        throw new Error(
          '这个文件夹里没有 novel.json，不是一部作品。\n' +
            '往里再选一层 —— 选那个直接放着 novel.json、角色/、地点/ 的文件夹。',
        )
      }

      const id = novel.project.id
      const summary = {
        id,
        kind: 'folder' as const,
        title: novel.project.title,
        folderName: next.rootName ?? '',
        updatedAt: novel.project.updatedAt ?? Date.now(),
        entityCount: novel.entities.length,
      }
      if (next instanceof TauriStorage) {
        upsertWork({ ...summary, path: next.root })
        rememberRoot(next.root)
      } else if (next instanceof FileStorage) {
        const key = await stashHandle(id, next.handle)
        upsertWork({ ...summary, handleKey: key })
      }

      setStorage(next)
      const adopted = adopt(novel)
      clearHistory()
      set({
        novel: adopted.novel,
        index: adopted.index,
        summaries: await refreshSummaries(),
        selectedId: null,
        view: 'overview',
        searchQuery: '',
        diskChange: null,
        storageMode: 'filesystem',
        rootName: next.rootName,
      })
      await refreshBaseline(novel)
      if (adopted.migratedTerms) scheduleSave()
    },



    /* ---------- 外部改动检测 ----------
       设计取舍：只检测，不自动覆盖任何一边。
       理由是这个决定应该由作者做 —— 一次错误的自动合并会毁掉设定，
       而多问一句的成本只是点一下。 */

    checkDisk: async () => {
      const novel = get().novel
      const store = getStorage()
      // 只要这个后端能给出指纹、且当前有打开的小说，就值得检测。
      // 不按 kind 写死：浏览器文件夹和桌面版的磁盘都能给指纹。
      if (!novel || !store.signatureOf) return
      // 已经有待处理提示时不重复检测，避免提示堆叠
      if (get().diskChange) return

      const sig = await store.signatureOf(novel).catch(() => null)

      if (sig === null) {
        // 文件夹被移走、改名、删掉，或者权限被浏览器收回了。
        // 这不是"内容被改过"，不要用那套按钮去问作者。
        set({
          diskChange: {
            at: Date.now(),
            kind: 'missing',
            summary: isTauri()
              ? '文件夹可能被移动、改名，或者被删掉了'
              : '文件夹可能被移动或改名，也可能是浏览器收回了授权',
          },
        })
        return
      }

      // 指纹一致 = 没人动过，这是绝大多数情况，直接返回
      if (diskBaseline === null) {
        diskBaseline = sig
        return
      }
      if (sig === diskBaseline) return

      // 指纹变了，才值得去读真正的磁盘内容
      const fromDisk = await store.read(novel.project.id).catch(() => null)
      if (!fromDisk) {
        diskBaseline = sig
        return
      }

      // 内容其实一样（比如只是被重新保存了一次），不必打扰用户
      if (sameContent(fromDisk, novel)) {
        diskBaseline = sig
        return
      }

      const bits = describeDiff(novel, fromDisk)

      set({
        diskChange: {
          at: Date.now(),
          kind: 'changed',
          summary: bits.length > 0 ? bits.join('，') : '文件内容有变化',
        },
      })
    },

    applyDiskVersion: async () => {
      const novel = get().novel
      if (!novel) return
      const store = getStorage()
      const fromDisk = await store.read(novel.project.id)
      set({ diskChange: null })
      if (!fromDisk) return
      // 选中的条目如果在新版本里没了，就取消选中，避免停留在空白编辑器上
      const keepSelection =
        get().selectedId && fromDisk.entities.some((e) => e.id === get().selectedId)
          ? get().selectedId
          : null
      const adopted = adopt(fromDisk)
      // 内容是从磁盘换来的，不是作者在这里改的 —— 撤回栈不能再指着旧内容
      clearHistory()
      set({
        novel: adopted.novel,
        index: adopted.index,
        selectedId: keepSelection,
        summaries: await store.listProjects(),
      })
      await refreshBaseline(fromDisk)
      if (adopted.migratedTerms) scheduleSave()
    },

    keepMemoryVersion: async () => {
      const novel = get().novel
      if (!novel) return
      const store = getStorage()
      // 立刻写回，不走去抖：用户已经明确表态了
      await store.write(novel).catch(() => undefined)
      await refreshBaseline(novel)
      set({ diskChange: null, summaries: await store.listProjects() })
    },

    dismissDiskChange: () => {
      // 记下新基线，这样不会再重复提示同一处改动。
      // 注意下一次自动保存仍然会覆盖磁盘，所以文案里要说清楚。
      void (async () => {
        const novel = get().novel
        if (novel) await refreshBaseline(novel)
      })()
      set({ diskChange: null })
    },

    retrySave: async () => {
      await flushSave()
    },
  }
})

/**
 * 内容比对已抽到 lib/compare.ts，因为它是外部改动检测里最容易出错、
 * 又最容易脱离浏览器测试的一环。
 * 换历法时的时间清理抽到 lib/dates.ts，理由相同。
 */

function labelOf(type: EntityType): string {
  const map: Record<EntityType, string> = {
    character: '角色',
    location: '地点',
    event: '事件',
    faction: '势力',
    item: '物品',
    concept: '概念',
  }
  return map[type]
}

/* ---------------- 大纲树的纯函数工具 ---------------- */

export function mapOutline(
  nodes: OutlineNode[],
  fn: (n: OutlineNode) => OutlineNode,
): OutlineNode[] {
  return nodes.map((n) => fn({ ...n, children: mapOutline(n.children, fn) }))
}

export function updateOutlineNode(
  nodes: OutlineNode[],
  id: string,
  patch: Partial<OutlineNode>,
): OutlineNode[] {
  return nodes.map((n) =>
    n.id === id
      ? { ...n, ...patch }
      : { ...n, children: updateOutlineNode(n.children, id, patch) },
  )
}

export function removeOutlineNode(nodes: OutlineNode[], id: string): OutlineNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: removeOutlineNode(n.children, id) }))
}

export function insertOutlineNode(
  nodes: OutlineNode[],
  parentId: string | null,
  node: OutlineNode,
): OutlineNode[] {
  if (parentId === null) return [...nodes, node]
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: [...n.children, node] }
      : { ...n, children: insertOutlineNode(n.children, parentId, node) },
  )
}

export function findOutlineNode(
  nodes: OutlineNode[],
  id: string,
): OutlineNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n
    const hit = findOutlineNode(n.children, id)
    if (hit) return hit
  }
  return undefined
}

/** 同级内重排 */
export function moveOutlineNode(
  nodes: OutlineNode[],
  id: string,
  delta: number,
): OutlineNode[] {
  const idx = nodes.findIndex((n) => n.id === id)
  if (idx !== -1) {
    const target = idx + delta
    if (target < 0 || target >= nodes.length) return nodes
    const next = [...nodes]
    const [item] = next.splice(idx, 1)
    next.splice(target, 0, item)
    return next
  }
  return nodes.map((n) => ({ ...n, children: moveOutlineNode(n.children, id, delta) }))
}

export function newOutlineNode(kind: OutlineNode['kind'], title: string): OutlineNode {
  return {
    id: uid('out'),
    kind,
    title,
    summary: '',
    status: 'idea',
    plotlines: [],
    cast: [],
    children: [],
  }
}