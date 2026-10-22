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
  getStorage,
  setStorage,
  supportsFileSystem,
  useLocalStorageFallback,
  type ProjectSummary,
  type StorageAdapter,
} from '../lib/storage'

/* 桌面版的存储层。装在 Tauri 壳里时它会接管「选文件夹」和读写磁盘；
   在浏览器里 isTauri() 是 false，这些函数一个都不会被调用。 */
import {
  TauriStorage,
  forgetRoot,
  isTauri,
  pickLibraryFolder,
  rememberRoot,
  restoreTauriStorage,
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
  /** 上次用过但需要重新授权的文件夹名（浏览器安全边界） */
  pendingRoot: string | null
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

  init: () => Promise<void>
  openProject: (id: string) => Promise<void>
  newProject: (title: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  backToLibrary: () => void

  chooseFolder: () => Promise<void>
  resumeFolder: () => Promise<void>
  disconnectFolder: () => void

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
  const history = new UndoStack<Novel>(40, 700)

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
    history.record(cur, label)
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

  /** 把撤回/重做拿到的快照装回界面。选中的条目可能已经不在了，得让位 */
  const restoreSnapshot = (target: Novel) => {
    const sel = get().selectedId
    set({
      novel: target,
      index: reindex(target),
      selectedId: sel && target.entities.some((e) => e.id === sel) ? sel : null,
      saveState: { kind: 'idle' },
      undoDepth: history.undoDepth,
      redoDepth: history.redoDepth,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    })
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
        set({ summaries: await store.listProjects() })
      },
      Date.now(),
    )
    set({ saveState: result })
  }

  /** 切换持久化后端之后，把列表和当前项目重新读一遍 */
  const reloadAll = async () => {
    const store = getStorage()
    const summaries = await store.listProjects()
    const cur = get().novel
    let novel = cur
    if (cur) {
      // 换后端后原项目可能不存在，此时退回列表里的第一本
      const stillThere = summaries.some((s) => s.id === cur.project.id)
      novel = stillThere ? cur : summaries[0] ? await store.read(summaries[0].id) : null
    }
    set({
      summaries,
      novel,
      index: novel ? reindex(novel) : null,
      storageMode: store.kind === 'localStorage' ? 'localStorage' : 'filesystem',
      rootName: store.rootName,
      pendingRoot: null,
      selectedId: null,
    })
    clearHistory()
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
    pendingRoot: null,
    canUseFilesystem: supportsFileSystem() || isTauri(),
    diskChange: null,
    saveState: { kind: 'idle' },
    undoDepth: 0,
    redoDepth: 0,
    undoLabel: null,
    redoLabel: null,

    init: async () => {
      /* 一进来永远是作品库，不自动打开任何一本。
         以前是「打开最近更新的那本，省掉一次点击」，但那样每次启动都被
         直接丢进正文里：既看不到自己有哪些作品，也会让人以为程序只认得
         一本。作者的心智模型是"先看到书架，再拿一本下来"。
         自动打开留一条理由也站不住 —— 想继续写的人，点一下卡片就行，
         而那一刻正好能看见它的标题和进度。 */
      /* ── 桌面版先走这条路 ──
         桌面版手里有真实路径，不需要用户每次点一下授权，
         所以能直接接着上次的小说库开。这是它比浏览器版省事的地方。
         只有一种情况不切过去：那个文件夹不见了、或者里面已经空了。
         那时候宁可停在内部存储上 —— 换成空列表会让人以为稿子没了。 */
      if (isTauri()) {
        const restored = restoreTauriStorage()
        if (restored) {
          const summaries = await restored.listProjects().catch(() => [])
          if (summaries.length > 0) {
            setStorage(restored)
            set({
              novel: null,
              index: null,
              summaries,
              storageMode: 'filesystem',
              rootName: restored.rootName,
              ready: true,
            })
            return
          }
        }
      } else {
        /* 先把上次用过的文件夹静默接回来：如果浏览器还留着授权，
           就直接接着用，不再让作者每开一次点一次。
           接不回来（授权已退回 prompt）才显示那一条「继续使用」。 */
        const silent = await FileStorage.restore().catch(() => null)
        if (silent) {
          setStorage(silent)
          set({ storageMode: 'filesystem', rootName: silent.rootName })
        } else {
          const lastRoot = await FileStorage.hasSaved().catch(() => null)
          if (lastRoot) set({ pendingRoot: lastRoot })
        }
      }

      const store = getStorage()
      const summaries = await store.listProjects()
      if (summaries.length === 0) {
        // 一本书都没有：直接停在作品库，让作者自己新建。
        // 不再播种演示小说 —— 一打开就看到别人的角色和势力是干扰，
        // 作者要的是干净的空本子。
        set({ novel: null, index: null, summaries: [], ready: true })
        return
      }
      // 有作品也只列出来，不替你打开。「字典 → 概念」的迁移推迟到真正
      // 打开某一本时再做（openProject 里会做），不会因此漏掉。
      set({ novel: null, index: null, summaries, ready: true })
    },

    openProject: async (id) => {
      const n = await getStorage().read(id)
      if (!n) return
      const adopted = adopt(n)
      // 换了一本书：撤回栈必须清空，否则会撤到上一本书的内容里
      clearHistory()
      set({
        novel: adopted.novel,
        index: adopted.index,
        selectedId: null,
        view: 'overview',
        searchQuery: '',
        diskChange: null,
      })
      await refreshBaseline(n)
      if (adopted.migratedTerms) scheduleSave()
    },

    newProject: async (title) => {
      const project = createProject(title)
      const novel: Novel = { project, entities: [], outline: [], terms: [] }
      const store = getStorage()
      await store.write(novel)
      clearHistory()
      set({
        novel,
        index: reindex(novel),
        summaries: await store.listProjects(),
        selectedId: null,
        view: 'overview',
        searchQuery: '',
      })
    },

    deleteProject: async (id) => {
      const store = getStorage()
      await store.remove(id)
      clearHistory()
      const summaries = await store.listProjects()
      if (get().novel?.project.id === id) {
        const next = summaries[0] ? await store.read(summaries[0].id) : null
        set({
          novel: next,
          index: next ? reindex(next) : null,
          selectedId: null,
          summaries,
        })
      } else {
        set({ summaries })
      }
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

    undo: () => {
      const n = get().novel
      if (!n) return
      const prev = history.undo(n)
      if (prev) restoreSnapshot(prev)
    },

    redo: () => {
      const n = get().novel
      if (!n) return
      const next = history.redo(n)
      if (next) restoreSnapshot(next)
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

    /* ---------- 持久化位置切换 ---------- */

    /**
     * 选一个文件夹当小说库。
     * 切换前先把内存里正在编辑的那本写回去，避免切换瞬间丢改动。
     */
    chooseFolder: async () => {
      const current = getStorage()
      const editing = get().novel
      if (editing) await current.write(editing).catch(() => undefined)

      /* 桌面版和浏览器版走两个不同的对话框：
         桌面版是系统自带的选文件夹窗口，选完就拿到真实路径、永久可用；
         浏览器版是 File System Access API，权限每次启动都要重新点。 */
      let next: StorageAdapter | null = null
      if (isTauri()) {
        next = await pickLibraryFolder()
      } else {
        next = await FileStorage.pick().catch((err: unknown) => {
          // 用户取消选择也会走到这里，不该当成错误
          if ((err as { name?: string })?.name === 'AbortError') return null
          throw err
        })
      }
      if (!next) return

      // 把内部存储里的作品也搬过去，否则用户会以为自己的东西没了
      for (const s of await current.listProjects()) {
        const n = await current.read(s.id)
        if (n) await next.write(n).catch(() => undefined)
      }

      /* 最后再把内存里正在编辑的那份写进去。
         顺序很重要：这条路径也可能是从「找不到文件夹」点过来的，
         那时磁盘读不到内容，只有内存里才是最新的。
         放在最后 = 内存版本不会被上面的旧副本盖掉。 */
      if (editing) await next.write(editing).catch(() => undefined)

      // 桌面版把路径记下来，下次启动直接恢复，不用再选一次
      if (next instanceof TauriStorage) rememberRoot(next.root)

      setStorage(next)
      await reloadAll()
    },

    /**
     * 重新授权上次用过的文件夹（必须在用户点击事件里调用）。
     *
     * 这里刻意不把内存里的副本写回磁盘。原因：文件夹在断开期间
     * 很可能被用户在外部编辑过（这正是「文件优先」的意义所在），
     * 一旦先写回，就会用陈旧的内存副本覆盖掉磁盘上更新的内容。
     * 所以顺序是「先读磁盘，让磁盘赢」，然后 reloadAll 会把
     * 当前项目替换成磁盘版本。
     */
    resumeFolder: async () => {
      const next = await FileStorage.reauthorize()
      if (!next) return
      setStorage(next)
      await reloadAll()
    },

    disconnectFolder: () => {
      // 桌面版要把记住的路径一起丢掉，否则下次启动又会自动跳回那个文件夹
      if (isTauri()) forgetRoot()
      useLocalStorageFallback()
      void FileStorage.forget()
      diskBaseline = null
      void reloadAll()
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
