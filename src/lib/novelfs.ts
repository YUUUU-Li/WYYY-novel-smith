/* ============================================================
   文件布局：一份小说如何摊成一个文件夹

   这是「文件即真相」的具体形状。抽成纯函数模块的原因：
   1. 现在给浏览器版的导出和真实文件夹写入共用
   2. 将来套 Tauri 壳时，Rust 侧按同一份布局读写，不需要重新设计

   目录约定：
     小说库/
       铁砧/
         novel.json          项目元信息 + 历法 + 关系词表 + 地图
         角色/林昭.md
         角色苏无咎.md
         地点/北境要塞.md
         事件/北境要塞陷落.md
         势力/北境军团.md
         物品/寒刃.md
         概念/冰息.md
         大纲.json
         词条.json
         历史/2026-09-29T22-30-00.json   自动版本快照

   为什么实体也要落成单个 Markdown 文件，而不是整包 JSON：
   单个文件才能被 Git 逐行 diff，才能在编辑器里单独打开，
   才能在你自己手改之后再被正确读回来。
   ============================================================ */

import type { EntityType, Novel, OutlineNode, Term } from './types'
import { parseEntity, safeFileName, serializeEntity } from './frontmatter'

export const ENTITY_DIR: Record<EntityType, string> = {
  character: '角色',
  location: '地点',
  event: '事件',
  faction: '势力',
  item: '物品',
  concept: '概念',
}

export const NOVELS_ROOT = '小说'
export const META_FILE = 'novel.json'
export const OUTLINE_FILE = '大纲.json'
export const TERMS_FILE = '词条.json'
export const HISTORY_DIR = '历史'

/** 文件名冲突时追加序号，保证同一目录下不会互相覆盖 */
function uniqueName(base: string, used: Set<string>): string {
  const name = safeFileName(base)
  if (!used.has(name)) {
    used.add(name)
    return `${name}.md`
  }
  let i = 2
  while (used.has(`${name}-${i}`)) i++
  used.add(`${name}-${i}`)
  return `${name}-${i}.md`
}

/**
 * 把一份小说摊成「路径 → 内容」的列表。
 * root 是相对于小说库根目录的前缀，导出时可以换成书名的文件夹名。
 */
export function novelToFiles(
  novel: Novel,
  root = `${NOVELS_ROOT}/${safeFileName(novel.project.title)}`,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []

  files.push({
    path: `${root}/${META_FILE}`,
    content: JSON.stringify(novel.project, null, 2) + '\n',
  })

  // 逐类型分配文件名，同类型内去重
  for (const [type, dir] of Object.entries(ENTITY_DIR) as Array<[EntityType, string]>) {
    const list = novel.entities.filter((e) => e.type === type)
    if (list.length === 0) continue
    const used = new Set<string>()
    for (const e of list) {
      files.push({
        path: `${root}/${dir}/${uniqueName(e.name, used)}`,
        content: serializeEntity(e),
      })
    }
  }

  files.push({
    path: `${root}/${OUTLINE_FILE}`,
    content: JSON.stringify(novel.outline, null, 2) + '\n',
  })
  files.push({
    path: `${root}/${TERMS_FILE}`,
    content: JSON.stringify(novel.terms, null, 2) + '\n',
  })

  return files
}

/** 一份小说在当前布局下会写出的实体文件路径集合，用于清理过期文件 */
export function entityFilePaths(novel: Novel): Set<string> {
  const out = new Set<string>()
  for (const [type, dir] of Object.entries(ENTITY_DIR) as Array<[EntityType, string]>) {
    const list = novel.entities.filter((e) => e.type === type)
    const used = new Set<string>()
    for (const e of list) {
      out.add(`${dir}/${uniqueName(e.name, used)}`)
    }
  }
  return out
}

/* ---------------- 读回来 ---------------- */

interface DirLike {
  values(): AsyncIterableIterator<{ kind: string; name: string }>
}

interface RootLike {
  values(): AsyncIterableIterator<{
    kind: string
    name: string
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirLike>
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileLike>
  }>
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirLike>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileLike>
}

interface FileLike {
  getFile(): Promise<File>
}

async function readDirFiles(dir: DirLike): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = []
  for await (const entry of dir.values()) {
    if (entry.kind !== 'file') continue
    const fh = await (dir as unknown as RootLike).getFileHandle(entry.name)
    const file = await fh.getFile()
    out.push({ name: entry.name, text: await file.text() })
  }
  return out
}

function parseJSON<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    // 解析失败绝不能吞掉数据：退回默认值，让上层能看到「这一项读不出来」
    return fallback
  }
}

/**
 * 从一个小说文件夹读回完整对象。
 * 只读实体目录下的 .md，忽略历史目录；大纲和词条缺失时按空处理，
 * 这样半成品文件夹也能打开，而不是报错拒绝。
 */
export async function novelFromDir(root: RootLike): Promise<Novel> {
  const metaTxt = await (await (await root.getFileHandle(META_FILE)).getFile()).text()
  const project = parseJSON(metaTxt, null as never)
  if (!project || typeof project !== 'object') {
    throw new Error('novel.json 无法解析，这个文件夹可能不是 吾又一言 的小说')
  }

  const entities = []
  for (const dirName of Object.values(ENTITY_DIR)) {
    let dir: DirLike
    try {
      dir = await root.getDirectoryHandle(dirName)
    } catch {
      continue // 这个类型一条都没有，正常
    }
    for (const f of await readDirFiles(dir)) {
      if (!f.name.toLowerCase().endsWith('.md')) continue
      const e = parseEntity(f.text, { file: `${dirName}/${f.name}` })
      // id 是链接的锚点，没有 id 的文件无法参与关系网
      if (e.id) entities.push(e)
    }
  }

  let outline: OutlineNode[] = []
  try {
    outline = parseJSON<OutlineNode[]>(
      await (await (await root.getFileHandle(OUTLINE_FILE)).getFile()).text(),
      [],
    )
  } catch {
    outline = []
  }

  let terms: Term[] = []
  try {
    terms = parseJSON<Term[]>(
      await (await (await root.getFileHandle(TERMS_FILE)).getFile()).text(),
      [],
    )
  } catch {
    terms = []
  }

  return { project, entities, outline, terms }
}
