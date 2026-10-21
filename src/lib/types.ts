/* ============================================================
   吾又一言 — 核心数据模型
   
   设计原则：
   1. 实体 + 链接 是全系统唯一的一等公民。设定管理、词条字典、
      人物图谱、时间线、地图 —— 全都是这份数据的五种画法。
   2. id 与文件名分离。改标题、改文件名、挪文件夹都不会断链接。
   3. 链接只单向书写，反向链接由程序推导。永不手工维护两遍。
   4. 日期用结构化对象，不用字符串。虚构世界需要自定义历法。
   ============================================================ */

/* ---------- 实体类型 ---------- */

export const ENTITY_TYPES = [
  'character',
  'location',
  'event',
  'faction',
  'item',
  'concept',
] as const

export type EntityType = (typeof ENTITY_TYPES)[number]

/** 每种实体一个固定色相。这是内容语义色，不是 UI 强调色。 */
export const ENTITY_META: Record<
  EntityType,
  { label: string; plural: string; cssVar: string; glyph: string }
> = {
  character: {
    label: '角色',
    plural: '角色',
    cssVar: '--color-e-character',
    glyph: '人',
  },
  location: {
    label: '地点',
    plural: '地点',
    cssVar: '--color-e-location',
    glyph: '地',
  },
  event: { label: '事件', plural: '事件', cssVar: '--color-e-event', glyph: '事' },
  faction: {
    label: '势力',
    plural: '势力',
    cssVar: '--color-e-faction',
    glyph: '势',
  },
  item: { label: '物品', plural: '物品', cssVar: '--color-e-item', glyph: '物' },
  concept: {
    label: '概念',
    plural: '概念',
    cssVar: '--color-e-concept',
    glyph: '念',
  },
}

/* ---------- 虚构历法 ---------- */

/**
 * 结构化的世界内日期。
 * 用对象而不是字符串，因为「第三纪元 421 年 霜月 12 日」这种东西
 * 没法用 Date 表达，也没法排序。排序时按字段字典序逐级比较。
 */
export interface NovelDate {
  era?: string
  year: number
  /** 世界内的月份名或序号，如 "霜月" */
  month?: string
  monthIndex?: number
  day?: number
  /** 排序用的小数偏移，处理「同一天但分先后」 */
  order?: number
}

export interface CalendarMonth {
  name: string
  days: number
}

export interface CalendarEra {
  name: string
  abbr: string
}

/**
 * 纪元的显示方式。
 *
 * 为什么需要它：不是所有纪时法都有「年号」这个层级。
 *  · fictional —— 虚构年号，如「天和 421 年」。纪元名来自 eras 列表。
 *  · prefix    —— 前缀式，如「公元前 287 年」。前缀是固定的，不用逐年手打。
 *  · suffix    —— 后缀式，如「民国 38 年」（纪元名在后）。
 *  · none      —— 无纪元，如「287 年」。西方公元前的「前」就靠这个 + yearLabel 表达。
 */
export type EraDisplay = 'fictional' | 'prefix' | 'suffix' | 'none'

/**
 * 年份的显示方式。解决的是「公元前的『前』字怎么来」。
 *  · plain —— 直接写数字
 *  · ce    —— 正数加「公元」前缀，0 或负数加「公元前」
 */
export type YearDisplay = 'plain' | 'ce'

export interface CalendarSystem {
  name: string
  /** 纪元显示方式。缺省按 fictional 处理，兼容老数据 */
  eraDisplay?: EraDisplay
  /** prefix / suffix 模式下纪元的位置标签，如「公元前」 */
  eraLabel?: string
  /** 年份显示方式。缺省 plain */
  yearDisplay?: YearDisplay
  eras: CalendarEra[]
  /** 纪元的先后顺序，用于跨纪元排序 */
  eraOrder: string[]
  /** 每个纪元的年数上限。用于把虚构历法的年份排序对齐到统一时间轴 */
  eraSpans?: number[]
  months: CalendarMonth[]
}

/* ---------- 链接 ---------- */

/**
 * 关系线的方向样式。
 * 存在链接本身上，所以同一条关系无论出现在哪些视图里，画法都一致。
 * 这是「一条关系该怎么看」的信息，不是某个视图的偏好。
 */
export type LinkDirection =
  /** 无箭头，纯连线 */
  | 'none'
  /** 单向箭头（默认）*/
  | 'forward'
  /** 双向箭头 */
  | 'both'

export type LinkDash = 'solid' | 'dashed'

/**
 * 连线的颜色。
 *
 * 存的是语义名而不是色值 —— 和实体类型色同样的思路：
 * 数据里写 'cinnabar' 而不是 '#9c3f30'，这样调色板以后可以整体调整，
 * 而不用去改每一个文件。手改 Markdown 时也一眼能读懂。
 *
 * 六个颜色都是低饱和的传统色，和纸墨、朱砂同一体系。
 * 它们只用来区分线条，不做强调 —— 强调色始终是朱砂。
 */
export type LinkColor =
  | 'ink'
  | 'xuan'
  | 'slate'
  | 'cinnabar'
  | 'rouge'
  | 'rust'
  | 'ochre'
  | 'moss'
  | 'jade'
  | 'pine'
  | 'indigo'
  | 'violet'

/**
 * 十二色。排序刻意排成一条光谱：三个中性色 → 暖色 → 绿 → 冷色，
 * 这样色板扫过去是有顺序的，而不是一堆随机色块。
 *
 * 挑色的约束有两条：饱和度都压得很低（否则纸面会花），
 * 以及**任意两色都分得开** —— canvas-graph-test 里有一条断言在量
 * 两两 RGB 距离，不许出现「两个看着一样的色」这种废选项。
 */
export const LINK_COLORS: Array<{ value: LinkColor; label: string; hex: string }> = [
  { value: 'ink', label: '墨', hex: '#4a463c' },
  { value: 'xuan', label: '玄', hex: '#2b2724' },
  { value: 'slate', label: '灰', hex: '#7a7568' },
  { value: 'cinnabar', label: '朱砂', hex: '#9c3f30' },
  { value: 'rouge', label: '胭脂', hex: '#8e4a5e' },
  { value: 'rust', label: '赭', hex: '#96603a' },
  { value: 'ochre', label: '缃', hex: '#b08430' },
  { value: 'moss', label: '苔', hex: '#6b6b3a' },
  { value: 'jade', label: '苍绿', hex: '#4a6b52' },
  { value: 'pine', label: '松绿', hex: '#2a5a52' },
  { value: 'indigo', label: '群青', hex: '#3d5a80' },
  { value: 'violet', label: '紫檀', hex: '#6b4f7a' },
]

export function linkColorHex(c: LinkColor | undefined): string | null {
  if (!c) return null
  return LINK_COLORS.find((x) => x.value === c)?.hex ?? null
}

export interface EntityLink {
  to: string
  type: string
  note?: string
  /** 关系强度 1-5，图谱里用线宽/透明度表达 */
  weight?: number
  /** 线的方向样式，缺省按 forward 处理 */
  dir?: LinkDirection
  /** 实线或虚线 */
  dash?: LinkDash
  /** 线的颜色，缺省时按关系名自动分配 */
  color?: LinkColor
}

export const LINK_DIRECTIONS: Array<{ value: LinkDirection; label: string }> = [
  { value: 'none', label: '无线头' },
  { value: 'forward', label: '单向箭头' },
  { value: 'both', label: '双向箭头' },
]

export const LINK_DASHES: Array<{ value: LinkDash; label: string }> = [
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
]

/* ---------- 手绘图谱的节点位置 ---------- */

/**
 * 一个条目的手工摆放位置。
 *
 * 为什么是「按视图」而不是「一个全局位置」：
 * 同一批角色可以排两次完全不同的构图（比如一卷一张图），
 * 互相不应该覆盖。
 *
 * x/y 是画布坐标的一个固定虚拟坐标系（见 lib/canvas-graph.ts 的 CANVAS），
 * 不用屏幕像素 —— 换窗口大小或换设备时构图不会跑偏。
 */
export interface GraphPosition {
  viewId: string
  x: number
  y: number
}

/* ---------- 实体 ---------- */

export interface Entity {
  id: string
  type: EntityType
  name: string
  tags: string[]
  summary?: string
  links: EntityLink[]
  /** 世界内时间点（角色生卒、事件发生等） */
  date?: NovelDate
  /** 世界内时间段，用于时间线的跨度条 */
  dateEnd?: NovelDate
  /**
   * 事件的发生地点。
   *
   * 可以装三种东西，由 `lib/places.ts` 统一解析：
   *   - 地点条目的 id（最正规，跟着条目改名，条目删掉时被清掉）
   *   - 地图区域的 id（在「地图」页画个区域就能直接用，不必先建条目）
   *   - 一句自由文字（「城南渡口」这种当场想起来的名字）
   *
   * 刻意保持成一个字符串而不是 { kind, id }：磁盘上已经写出去的
   * .md 不必迁移，解析放在读的时候做。
   *
   * 这个字段以前也给角色表示「当前所在地」，但那一栏已经删掉了 ——
   * 角色的位置用「参与了哪个事件」推出来就够了，单独维护一个
   * 「现在在哪」既容易过期，又会和事件里的说法打架。
   * 盘上仍然读它（老文件里可能写着），所以不要删掉这个字段。
   */
  at?: string
  /**
   * 手绘图谱里的摆放位置。放在这里而不是项目里，
   * 是因为位置属于「这个条目在图上长什么样」，跟着条目走更好读。
   * 一个条目可以在不同 viewId 下有多套位置。
   */
  graphPos?: GraphPosition[]
  status?: string
  /** 自定义字段，按类型定义的表单 */
  fields?: Record<string, string>
  /** 实体正文，Markdown */
  body: string
  /** 源文件相对路径，Web 形态下是虚拟路径，将来是真实路径 */
  file?: string
}

/* ---------- 大纲 ---------- */

export type OutlineKind = 'volume' | 'chapter' | 'scene'
export type OutlineStatus = 'idea' | 'drafting' | 'done'

export interface OutlineNode {
  id: string
  kind: OutlineKind
  title: string
  summary: string
  status: OutlineStatus
  /** 剧情线标签，如「主线」「支线：北境」 */
  plotlines: string[]
  /** 涉及的角色 id */
  cast: string[]
  /** 字数目标 */
  target?: number
  /** 剧情内时间，用于反向校对时间线 */
  date?: NovelDate
  children: OutlineNode[]
}

/* ---------- 词条 ---------- */

export interface Term {
  id: string
  /** 自造词原文 */
  term: string
  /** 读音 / 罗马字，方便你记住怎么念 */
  pronunciation?: string
  /** 直译 */
  gloss?: string
  definition: string
  /** 关联实体 */
  links: EntityLink[]
}

/* ---------- 地图 ---------- */

export interface MapPin {
  /** 稳定的本地 id。老数据可能没有，界面上会退回用 条目+序号 当键 */
  id?: string
  entity: string
  /** 归一化坐标 0~1，相对地图平面（不是画布），换更高清的底图也不会错位 */
  x: number
  y: number
  /** 这枚图钉自己的名字。不填就跟着条目名走 */
  label?: string
  /** 自己挑的颜色。不填就跟着条目类型走 */
  color?: LinkColor
}

/** 区域多边形，同样用归一化坐标 */
export interface MapRegion {
  id: string
  name: string
  points: Array<{ x: number; y: number }>
  entity?: string
  /** 区域自己的颜色。不填就是默认的墨色 */
  color?: LinkColor
  /** 对这个区域的一段自由说明 */
  desc?: string
}

export interface WorldMap {
  id: string
  name: string
  /** 底图。Web 形态下是 dataURL 或 URL，将来是本机图片路径 */
  image?: string
  width: number
  height: number
  pins: MapPin[]
  regions: MapRegion[]
  /** 是否在地图上画出各区域自己的颜色。不填按「画」算 */
  showRegionColors?: boolean
}

/* ---------- 时间线板 ---------- */

/** 板上的竖线：作者自己定义「列」是什么意思（国家、战场、人物线……） */
export interface TimelineGuide {
  id: string
  name: string
  /** 归一化横坐标 0~1，相对「事件区」的宽度。换窗口大小不会跑位 */
  x: number
}

/**
 * 时间线上的一格。
 *
 * 只存横坐标：**行是算出来的**（这个事件发生在哪一年哪一月），
 * 所以改事件的时间，它会自己挪到对应那一行；
 * 存下来的只有「作者把它摆在左边还是右边」。
 */
export interface TimelineItem {
  entity: string
  x: number
}

/**
 * 一张时间线。
 *
 * 和「事件轴 / 轨道 / 在场」那三种视图的区别：那三种是**自动生成**的，
 * 把所有事件铺开；这一种是**手工摆的**，放哪些、怎么对齐由作者决定。
 */
export interface TimelineBoard {
  id: string
  name: string
  /**
   * 板子有多宽，单位是「几个视口宽」（1 = 不横向滚动）。
   *
   * 为什么要这个：同一时间的事一多，一屏横向就摆不下了。
   * x 存的是归一化坐标（相对这块板的总宽度），所以把板子放宽
   * 等于把画布放大 —— 原来的相对位置不动，只是空出了更多地方。
   */
  width?: number
  guides: TimelineGuide[]
  items: TimelineItem[]
}

/* ---------- 词条夹：设定页上的文件夹 ---------- */

/**
 * 一个词条夹。可以装条目，也可以装别的词条夹（任意层数）。
 *
 * 为什么用「夹子里存一个有序数组」而不是「每个条目记自己的父夹 + 序号」：
 * 前者只有一个真相 —— 一个东西在哪个夹子、排第几，全看它在哪个数组里、
 * 排在第几位。后者有两个真相（父指针 + 序号），改一次要动两个地方，
 * 而且很容易出现「父指针说在 A、A 的数组里却没有它」这种半坏状态。
 *
 * items 里存的是**id**，可能是条目 id，也可能是另一个词条夹的 id。
 * 顶层不是一个真的词条夹，顺序单独放在 project.rootItems 里。
 */
export interface EntityFolder {
  id: string
  name: string
  desc?: string
  /** 按显示顺序排列的子项：条目 id 或词条夹 id */
  items: string[]
}

/* ---------- 项目 ---------- */

export interface Project {
  id: string
  title: string
  author?: string
  logline?: string
  /** 关系类型的受控词表。不控制的话半年后会同时出现
      「宿敌」「仇人」「死对头」三种同义连线，图谱直接烂掉。 */
  linkTypes: string[]
  /** 每个实体类型可用的自定义字段 */
  fieldSchemas: Partial<Record<EntityType, Array<{ key: string; label: string }>>>
  calendar: CalendarSystem
  maps: WorldMap[]
  /**
   * 手工摆的时间线。老文件里没有这一栏，读的时候补成空数组。
   * 和 maps 一样放在 novel.json 里：它描述的是「这份稿子怎么排」，
   * 不属于任何一个条目。
   */
  boards: TimelineBoard[]
  /**
   * 设定页的词条夹。老文件里没有这个字段，读的时候会补成空数组。
   *
   * 刻意放在 novel.json 而不是每个条目的 frontmatter 里：
   * 拖一下卡片如果写进条目文件，一次拖动就要重写几十个 .md，
   * 而且会把「排第几」这种数字灌进本该是人能读的正文文件里。
   */
  folders: EntityFolder[]
  /** 顶层的东西，按显示顺序。没被列在任何夹子里的条目排在它后面（按名称） */
  rootItems: string[]
  createdAt: number
  updatedAt: number
}

/* ---------- 全量快照：一份小说的完整内容 ---------- */

export interface Novel {
  project: Project
  entities: Entity[]
  outline: OutlineNode[]
  terms: Term[]
}

/* ---------- 派生结构：不是数据，是算出来的 ---------- */

export interface Backlink {
  fromId: string
  fromName: string
  fromType: EntityType
  type: string
  note?: string
}

export interface NovelIndex {
  byId: Map<string, Entity>
  /** 正向 + 反向，查一次拿到一个实体的全部关系 */
  linksOf: Map<string, Backlink[]>
  /** 所有 dangling 链接：指向了不存在的 id，需要提示用户 */
  dangling: Array<{ fromId: string; to: string; type: string }>
  /** 标签 → 实体 id */
  byTag: Map<string, string[]>
  /** 名字与标签的模糊搜索 */
  search: (query: string) => Entity[]
}

/* ---------- 默认值工厂 ---------- */

export const DEFAULT_LINK_TYPES = [
  '亲属',
  '盟友',
  '敌对',
  '师徒',
  '同僚',
  '爱慕',
  '效忠',
  '出生地',
  '常驻',
  '参与',
]

export const DEFAULT_CALENDAR: CalendarSystem = {
  name: '标准历',
  eras: [{ name: '第一纪元', abbr: 'E1' }],
  eraOrder: ['第一纪元'],
  months: [
    { name: '一月', days: 30 },
    { name: '二月', days: 30 },
    { name: '三月', days: 30 },
    { name: '四月', days: 30 },
    { name: '五月', days: 30 },
    { name: '六月', days: 30 },
    { name: '七月', days: 30 },
    { name: '八月', days: 30 },
    { name: '九月', days: 30 },
    { name: '十月', days: 30 },
    { name: '十一月', days: 30 },
    { name: '十二月', days: 30 },
  ],
}

export function createProject(title: string): Project {
  const now = Date.now()
  return {
    id: `proj_${now.toString(36)}`,
    title,
    linkTypes: [...DEFAULT_LINK_TYPES],
    fieldSchemas: {
      character: [
        { key: '外貌', label: '外貌' },
        { key: '能力', label: '能力' },
        { key: '动机', label: '核心动机' },
      ],
      location: [
        { key: '地貌', label: '地貌' },
        { key: '气候', label: '气候' },
      ],
      event: [{ key: '后果', label: '后果' }],
      faction: [
        { key: '宗旨', label: '宗旨' },
        { key: '实力', label: '实力' },
      ],
      item: [{ key: '来历', label: '来历' }],
      concept: [{ key: '规则', label: '规则' }],
    },
    calendar: structuredClone(DEFAULT_CALENDAR),
    maps: [],
    boards: [],
    folders: [],
    rootItems: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createEntity(type: EntityType, name: string): Entity {
  return {
    id: `e_${Math.random().toString(36).slice(2, 10)}`,
    type,
    name,
    tags: [],
    links: [],
    body: '',
  }
}

let seq = 0
export function uid(prefix = 'n'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`
}
