/* ============================================================
   设定页的组织结构：词条夹树 + 手写顺序

   这一层刻意做成纯函数、不碰 React，因为它的坏法都很隐蔽：
   把夹子拖进自己的子孙里、删掉夹子后里面的东西凭空消失、
   两个夹子同时声称拥有同一个条目……这些都不崩溃，只是「东西不见了」。
   放进纯函数就能一条条钉住。

   只讲三件事：
     1. 一个容器（顶层或某个夹子）里的东西，按显示顺序列出来
     2. 把一个东西从 A 挪到 B 的第 n 位
     3. 删掉一个夹子之后，里面的东西去哪
   ============================================================ */

import type { Entity, EntityFolder, Novel, Project } from './types'

export const ROOT = '__root__'

export type ContainerId = string // ROOT 或某个夹子的 id

export type OrgItem =
  | { kind: 'folder'; id: string; folder: EntityFolder }
  | { kind: 'entity'; id: string; entity: Entity }

/** 某个夹子（含不存在的）里的原始 id 列表 */
export function rawItems(project: Project, containerId: ContainerId): string[] {
  if (containerId === ROOT) return project.rootItems ?? []
  const f = (project.folders ?? []).find((x) => x.id === containerId)
  return f ? f.items : []
}

/** 一个 id 是不是词条夹 */
export function isFolderId(project: Project, id: string): boolean {
  return (project.folders ?? []).some((f) => f.id === id)
}

/** 找夹子 */
export function findFolder(project: Project, id: string): EntityFolder | undefined {
  return (project.folders ?? []).find((f) => f.id === id)
}

/** 某个夹子的所有子孙夹 id（不含自己） */
export function descendantFolderIds(project: Project, id: string): Set<string> {
  const out = new Set<string>()
  const walk = (containerId: string) => {
    for (const child of rawItems(project, containerId)) {
      if (!isFolderId(project, child) || out.has(child)) continue
      out.add(child)
      walk(child)
    }
  }
  walk(id)
  return out
}

/**
 * 某个夹子的祖先链，从顶层往下（不含自己）。
 * 不含顶层那个哨兵 —— 界面要显示「全部」那一级时自己补。
 */
export function ancestorPath(project: Project, id: ContainerId): string[] {
  if (id === ROOT) return []
  const parentOf = new Map<string, string>()
  const walk = (containerId: string) => {
    for (const child of rawItems(project, containerId)) {
      if (!isFolderId(project, child)) continue
      if (!parentOf.has(child)) {
        parentOf.set(child, containerId)
        walk(child)
      }
    }
  }
  walk(ROOT)

  const chain: string[] = []
  let cur = parentOf.get(id)
  const seen = new Set<string>([id])
  while (cur && cur !== ROOT && !seen.has(cur)) {
    seen.add(cur)
    chain.unshift(cur)
    cur = parentOf.get(cur)
  }
  return chain
}

/**
 * 把一个东西塞进某个容器，会不会形成环。
 * 规则：夹子不能进自己，也不能进自己的子孙。
 */
export function wouldCycle(project: Project, id: string, toContainer: ContainerId): boolean {
  if (!isFolderId(project, id)) return false
  if (id === toContainer) return true
  return descendantFolderIds(project, id).has(toContainer)
}

/** 这个条目 / 夹子现在待在哪个容器里；找不到就是 undefined。
    **条目可能摆在不止一处**，所以这个只回答「第一处」——
    要知道全部的用 containersOf。 */
export function containerOf(project: Project, id: string): ContainerId | undefined {
  if (rawItems(project, ROOT).includes(id)) return ROOT
  for (const f of project.folders ?? []) {
    if (f.items.includes(id)) return f.id
  }
  return undefined
}

/**
 * 这个条目摆在哪些容器里（可能是好几个）。
 *
 * 为什么允许一个条目放在多处：像「齐国伐宋」这种事，既是齐国的事，
 * 也是宋国的事，作者会想在这两个夹子里都看到它。
 * 允许的两个做法里，**复制数据**是错的那个 —— 两份很快就不同步，
 * 改了一边另一边还是旧的，图谱里还会冒出两个同名条目。
 * 所以这里允许的是「同一个条目、摆几个位置」，
 * 内容只有一份，天然就不会不同步。
 *
 * 夹子不在此列：夹子只能有一个位置，否则子树会被数两遍。
 */
export function containersOf(project: Project, id: string): ContainerId[] {
  const out: ContainerId[] = []
  if (rawItems(project, ROOT).includes(id)) out.push(ROOT)
  for (const f of project.folders ?? []) {
    if (f.items.includes(id)) out.push(f.id)
  }
  return out
}

/**
 * 一个容器里到底有哪些东西，按显示顺序。
 *
 * 两个兜底，都是为了「东西不会凭空消失」：
 *   · 数组里指向不存在的东西 → 跳过
 *   · 存在于小说里、但没被任何容器列过的条目 → 只挂在顶层的末尾（按名称）
 */
export function resolveContainer(
  project: Project,
  novel: Pick<Novel, 'entities'>,
  containerId: ContainerId,
): OrgItem[] {
  const folders = project.folders ?? []
  const byId = new Map(novel.entities.map((e) => [e.id, e]))
  const out: OrgItem[] = []
  const seen = new Set<string>()

  for (const id of rawItems(project, containerId)) {
    if (seen.has(id)) continue
    const folder = folders.find((f) => f.id === id)
    if (folder) {
      seen.add(id)
      out.push({ kind: 'folder', id, folder })
      continue
    }
    const entity = byId.get(id)
    if (entity) {
      seen.add(id)
      out.push({ kind: 'entity', id, entity })
    }
    // 指不到东西的 id：静默跳过，但数据还留着（可能是刚删掉的条目）
  }

  if (containerId !== ROOT) return out

  /* 顶层补上「没被任何夹子认领」的东西。
     新条目、老文件里的条目、以及被手工改坏的引用，都会落到这里。 */
  const claimed = new Set<string>()
  for (const f of folders) for (const id of f.items) claimed.add(id)
  for (const id of rawItems(project, ROOT)) claimed.add(id)

  const orphans = novel.entities
    .filter((e) => !claimed.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  for (const e of orphans) out.push({ kind: 'entity', id: e.id, entity: e })

  const strayFolders = folders
    .filter((f) => !claimed.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  for (const f of strayFolders) out.push({ kind: 'folder', id: f.id, folder: f })

  return out
}

/** 这个容器里有没有夹子（用来决定要不要显示「先建个夹子」的提示） */
export function hasSubfolder(project: Project, containerId: ContainerId): boolean {
  return rawItems(project, containerId).some((id) => isFolderId(project, id))
}

/**
 * 把顶层「现在看见的顺序」固化进 rootItems。
 *
 * 为什么必须有这一步：没被任何容器列过的条目（新建的、老文件里的）
 * 是**追加**在顶层末尾显示的。所以在它们之间插一个东西时，
 * 如果只把那个东西写进 rootItems，它会跑到最前面，而排在它后面的
 * 那些「没登记的」又会被追加到更后面 —— 拖到第 3 位会变成第 1 位。
 *
 * 落点 index 是从「看见的顺序」算出来的，所以下笔之前先把看见的顺序
 * 变成真的顺序，index 才有确定的意义。
 */
export function materializeRoot(
  project: Project,
  novel: Pick<Novel, 'entities'>,
): Project {
  const ids = resolveContainer(project, novel, ROOT).map((i) => i.id)
  const cur = rawItems(project, ROOT)
  if (ids.length === cur.length && ids.every((id, i) => id === cur[i])) return project
  return { ...project, rootItems: ids }
}

/**
 * 把「看得见的那一串」按新顺序放回它们原来的槽位，看不见的原地不动。
 *
 * visible **必须包含被拖的那一项**（就是屏幕上那一列的原样），
 * index 是「先把它摘掉之后」要插到第几位。函数自己负责把它从原槽位摘掉。
 *
 * 为什么需要它：拖动算出来的 index 是相对**屏幕上那一列**的，可是
 * order 要落到**存起来的那一份**里。两者不一定一样 ——
 * 类型筛选会藏起一部分条目，非手动排序又会换一个排法。
 * 直接把 index 用到底层数组上，就会出现「拖到第 2 位却落在第 3 位」。
 *
 * 做法是只重排可见的那些槽位：既不会把被筛掉的条目弄丢，
 * 也不会把它们的位置搞乱。
 */
export function reorderVisible(
  project: Project,
  container: ContainerId,
  visible: string[],
  id: string,
  index: number,
): Pick<Project, 'folders' | 'rootItems'> {
  const stored = [...rawItems(project, container)]
  const rest = visible.filter((x) => x !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  const nextVisible = [...rest]
  nextVisible.splice(at, 0, id)

  /* 把可见的那一串按槽位放回去。
     pool 用的是**完整的可见集合**（含被拖的那一项）：
     凡是 stored 里「看得见」的槽位，都按 nextVisible 的顺序重新填一遍。
     其中被拖的那一项原来的槽位也会被填掉，它只会出现在新的位置上。

     这里踩过一个坑：如果 pool 里少了被拖的那一项（比如调用方先把 id 滤掉了），
     它原来的槽位就会被保留下来，而 nextVisible 里那个 id 又会被填进另一个槽位 ——
     同一个 id 在数组里出现两次，夹子上的条目数于是凭空变大。 */
  const pool = new Set(visible)
  let k = 0
  const rebuilt = stored.map((x) => (pool.has(x) ? (nextVisible[k++] ?? x) : x))
  /* 兜底：确实还有没安置的才追加，而且**绝不追加已经在里面的**。
     一个 id 出现两次会让计数直接错掉，这种错不值得靠「理论上不会发生」。 */
  while (k < nextVisible.length) {
    const x = nextVisible[k++]
    if (!rebuilt.includes(x)) rebuilt.push(x)
  }

  if (container === ROOT) return { folders: project.folders, rootItems: rebuilt }
  return {
    folders: (project.folders ?? []).map((f) =>
      f.id === container ? { ...f, items: rebuilt } : f,
    ),
    rootItems: project.rootItems,
  }
}

/**
 * 把 id 挪到 toContainer 的第 index 位。
 * 返回新的 folders / rootItems（不改原对象）。
 *
 * `from` 是「这一张卡片原本在哪个容器」。给了它就只把**那一个位置**搬走，
 * 条目在别处摆的其它份不动 —— 这才是「拖动一张卡片」的直觉。
 * 不给的话会从所有容器里摘干净（夹子必须走这条路：夹子只能有一处）。
 */
export function moveItem(
  project: Project,
  id: string,
  toContainer: ContainerId,
  index: number,
  from?: ContainerId,
): Pick<Project, 'folders' | 'rootItems'> {
  if (wouldCycle(project, id, toContainer)) {
    return { folders: project.folders, rootItems: project.rootItems }
  }

  const folders = (project.folders ?? []).map((f) => ({ ...f, items: [...f.items] }))
  const rootItems = [...rawItems(project, ROOT)]

  const pullFrom = (container: ContainerId) => {
    const arr = container === ROOT ? rootItems : folders.find((f) => f.id === container)?.items
    const i = arr ? arr.indexOf(id) : -1
    if (arr && i !== -1) arr.splice(i, 1)
  }

  if (from !== undefined && !isFolderId(project, id)) {
    pullFrom(from)
  } else {
    pullFrom(ROOT)
    for (const f of folders) pullFrom(f.id)
  }

  // 2. 插到目标位置
  const target = toContainer === ROOT ? rootItems : folders.find((f) => f.id === toContainer)?.items
  if (!target) return { folders: project.folders, rootItems: project.rootItems }
  const at = Math.max(0, Math.min(index, target.length))
  if (!target.includes(id)) target.splice(at, 0, id)

  return { folders, rootItems }
}

/**
 * 再摆一份：把同一个条目放进某个容器，**不搬走原来那份**。
 *
 * 这一步只改组织结构，不复制条目本身 —— 名字、正文、关系、出现过的场合
 * 全都只有一份，所以在哪个夹子里改都是改同一件事。
 * 夹子不能这样放（会数两遍子树），已经在里面的也不会重复加。
 */
export function placeItem(
  project: Project,
  id: string,
  toContainer: ContainerId,
  index?: number,
): Pick<Project, 'folders' | 'rootItems'> {
  const unchanged = { folders: project.folders, rootItems: project.rootItems }
  if (isFolderId(project, id)) return unchanged
  if (toContainer !== ROOT && !findFolder(project, toContainer)) return unchanged

  const cur = rawItems(project, toContainer)
  if (cur.includes(id)) return unchanged

  const at = Math.max(0, Math.min(index ?? cur.length, cur.length))
  const next = [...cur]
  next.splice(at, 0, id)

  if (toContainer === ROOT) return { folders: project.folders, rootItems: next }
  return {
    folders: (project.folders ?? []).map((f) =>
      f.id === toContainer ? { ...f, items: next } : f,
    ),
    rootItems: project.rootItems,
  }
}

/** 把某一份摆放撤掉（条目本身留着，别处摆的也不动） */
export function unplaceItem(
  project: Project,
  id: string,
  fromContainer: ContainerId,
): Pick<Project, 'folders' | 'rootItems'> {
  const cur = rawItems(project, fromContainer)
  if (!cur.includes(id)) return { folders: project.folders, rootItems: project.rootItems }
  const next = cur.filter((x) => x !== id)

  if (fromContainer === ROOT) return { folders: project.folders, rootItems: next }
  return {
    folders: (project.folders ?? []).map((f) =>
      f.id === fromContainer ? { ...f, items: next } : f,
    ),
    rootItems: project.rootItems,
  }
}

/**
 * 删掉一个词条夹。里面的东西**不删**，上交给它的上级 ——
 * 删夹子顺手删掉里面的角色，是这类工具最不能犯的错。
 * 交上去时插在被删夹子原来的位置，所以视觉上是「夹子散了，东西留在原地」。
 */
export function deleteFolder(
  project: Project,
  folderId: string,
): Pick<Project, 'folders' | 'rootItems'> {
  const folder = findFolder(project, folderId)
  if (!folder) return { folders: project.folders, rootItems: project.rootItems }

  const parent = containerOf(project, folderId) ?? ROOT
  const folders = (project.folders ?? []).map((f) => ({ ...f, items: [...f.items] }))
  const rootItems = [...rawItems(project, ROOT)]

  // 从父容器里摘掉这个夹子，记住它原来在第几位
  const parentArr = parent === ROOT ? rootItems : folders.find((f) => f.id === parent)?.items
  const at = parentArr ? parentArr.indexOf(folderId) : -1
  if (parentArr && at !== -1) parentArr.splice(at, 1)

  // 把它里面的东西接到同一个位置。
  // 不筛「还存在吗」—— 指不到的 id 留着也无害（列出时会跳过），
  // 万一那个条目只是暂时读不到，位置还在。
  // 但已经在父容器里的不再塞一遍：条目可以摆在多处，同一个夹子里放两份没意义。
  const survivors = folder.items.filter((x) => !(parentArr ?? []).includes(x))
  if (parentArr && at !== -1) parentArr.splice(at, 0, ...survivors)

  return {
    folders: folders.filter((f) => f.id !== folderId),
    rootItems,
  }
}

/** 统计一个夹子里面（含子孙）有多少条目。
    同一个条目在子树里摆了两份也只算一次 —— 这里回答的是「有几个东西」。 */
export function countEntities(project: Project, novel: Pick<Novel, 'entities'>, folderId: string): number {
  const ids = new Set(novel.entities.map((e) => e.id))
  const seen = new Set<string>()
  const counted = new Set<string>()
  const walk = (containerId: string) => {
    // 数据被手工改坏成环时不至于把界面卡死
    if (seen.has(containerId)) return
    seen.add(containerId)
    for (const id of rawItems(project, containerId)) {
      if (isFolderId(project, id)) walk(id)
      else if (ids.has(id) && !counted.has(id)) {
        counted.add(id)
      }
    }
  }
  walk(folderId)
  return counted.size
}

/**
 * 只算这个夹子**直接**装着的条目，不含子孙夹子。
 *
 * 为什么要单独一个：夹子上显示的是继承后的总数，可是「为什么是 7 不是 4」
 * 这个问题，光看总数答不出来。有它就能写成「7 条（自己 4）」。
 */
export function countOwnEntities(
  project: Project,
  novel: Pick<Novel, 'entities'>,
  folderId: string,
): number {
  const ids = new Set(novel.entities.map((e) => e.id))
  return rawItems(project, folderId).filter((id) => ids.has(id)).length
}

/** 建一个新的词条夹。id 只用来当键，不进磁盘格式的任何约定 */
export function newFolder(name: string): EntityFolder {
  return {
    id: `f_${Math.random().toString(36).slice(2, 10)}`,
    name,
    items: [],
  }
}

/**
 * 老文件兼容：novel.json 里可能没有 folders / rootItems，字段也可能被
 * 手工改坏。每次从磁盘读回来都过一遍，界面上就不用到处写 ?? []。
 *
 * 已经正常时**原样返回同一个对象**：这样它可以被放心地到处调用，
 * 不会每次都造出新引用、拖着整棵树重渲染。
 */
export function normalizeOrg(project: Project): Project {
  const rawFolders = Array.isArray(project.folders) ? project.folders : []
  const rawRoot = Array.isArray(project.rootItems) ? project.rootItems : []

  let dirty = !Array.isArray(project.folders) || !Array.isArray(project.rootItems)

  /* 顺手修两种坏数据：
       · 同一个 id 在**同一个容器**里出现两次（曾经有个 bug 会写出这种数据，
         症状是「夹子里的条目数比实际多」）
       · 同一个**词条夹**横跨两个容器（子树会被数两遍）
     条目在多个夹子里各摆一份是合法的，所以跨容器不查重。 */
  const folderIds = new Set(
    rawFolders.filter((f) => f && typeof f.id === 'string').map((f) => f.id),
  )
  const claimedFolders = new Set<string>()
  const take = (arr: string[]): { out: string[]; changed: boolean } => {
    const out: string[] = []
    const seen = new Set<string>()
    let changed = false
    for (const x of arr) {
      if (typeof x !== 'string') {
        changed = true
        continue
      }
      if (seen.has(x)) {
        changed = true
        continue
      }
      if (folderIds.has(x)) {
        if (claimedFolders.has(x)) {
          changed = true
          continue
        }
        claimedFolders.add(x)
      }
      seen.add(x)
      out.push(x)
    }
    return { out, changed }
  }

  const folders: EntityFolder[] = []
  for (const f of rawFolders) {
    if (!f || typeof f.id !== 'string') {
      dirty = true
      continue
    }
    const name = typeof f.name === 'string' ? f.name : '未命名词条夹'
    if (name !== f.name) dirty = true
    const rawItems0 = Array.isArray(f.items) ? f.items.filter((x) => typeof x === 'string') : []
    if (!Array.isArray(f.items) || rawItems0.length !== f.items.length) dirty = true
    const { out, changed } = take(rawItems0)
    if (changed) dirty = true
    folders.push({ ...f, name, items: out })
  }

  const rawRootSafe = rawRoot.filter((x) => typeof x === 'string')
  if (rawRootSafe.length !== rawRoot.length) dirty = true
  const root = take(rawRootSafe)
  if (root.changed) dirty = true

  if (!dirty) return project
  return { ...project, folders, rootItems: root.out }
}
