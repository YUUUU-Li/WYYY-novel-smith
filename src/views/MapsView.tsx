/* ============================================================
   地图设计

   核心机制：图钉与区域的坐标用 0~1 的归一化比例存储，不用像素。
   这样换成更高清的底图、或换一张完全不同的画风时，
   所有图钉和区域都会自动落在原来的相对位置，不会全部错位。

   关键一条：**归一化的参照物必须是「地图平面」，不是「画布」**。
   画布会随窗口大小变，地图平面不会。平面按地图自己的宽高比铺开
   （image 上传时记下 naturalWidth/naturalHeight），底图正好铺满它，
   于是「点在图片上的哪个位置」和「存下来的比例」永远是一回事。
   早期版本把比例算在了画布上，底图被 object-contain 留了白，
   结果是窗口一改大小，图钉就整体漂到图外面去。

   底图可以是任何一张图片（手绘扫描、AI 生成、网上找的都行），
   也可以完全没有底图，那样会画一张程序生成的经纬底纹，
   至少让坐标有意义，而不是一片黑。
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  CrosshairSimple,
  ImageSquare,
  MapPin,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react'
import { useStore } from '../store/useNovel'
import {
  ENTITY_META,
  LINK_COLORS,
  linkColorHex,
  type Entity,
  type LinkColor,
  type MapPin as Pin,
  type WorldMap,
} from '../lib/types'
import { ConfirmButton, Empty, SectionLabel, TypeDot } from '../components/ui'
import { clamp } from '../lib/util'

type Tool = 'pan' | 'pin' | 'region'

/** 没有底图时的默认平面尺寸 */
const DEFAULT_W = 1600
const DEFAULT_H = 1000

/* 底图大小上限。
   底图目前是当作 dataURL 存进 novel.json 的，而浏览器本地存储总共只有
   几 MB —— 一张 5 MB 的手机照片存进去会让整次保存失败（而且是静默失败：
   内存里看着好好的，刷新一下全没了）。所以上传时先缩到可存的大小。
   2048px 长边对着一张世界地图绰绰有余，坐标是归一化的，将来换更高清的
   底图也不会错位。 */
const MAX_EDGE = 2048
/** dataURL 字符数上限。本地存储按 UTF-16 记，总量约 260 万字符，
    留出余量给正文与多个条目。 */
const MAX_DATA_URL = 900_000

/** React 的 onWheel 是被动监听，拦不住页面滚动，所以要自己挂一个 */
const preventWheel = (e: WheelEvent) => e.preventDefault()

/** 图钉的本地 id。只用来当列表的键，不进磁盘格式的任何约定 */
function newPinId(): string {
  return `pin_${Math.random().toString(36).slice(2, 9)}`
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读不出这个文件'))
    r.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这不是一张能显示的图片'))
    img.src = src
  })
}

interface PreparedImage {
  image: string
  width: number
  height: number
  /** 给人看的说明；没有压缩就是 undefined */
  note?: string
}

/** 把上传的图缩到可存的大小，并回报实际存下来的尺寸 */
async function prepareImage(file: File): Promise<PreparedImage> {
  const raw = await readAsDataURL(file)
  const img = await loadImage(raw)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (nw === 0 || nh === 0) throw new Error('这张图没有有效的尺寸')

  const long = Math.max(nw, nh)
  const shrink = long > MAX_EDGE ? MAX_EDGE / long : 1
  const cw = Math.max(1, Math.round(nw * shrink))
  const ch = Math.max(1, Math.round(nh * shrink))

  // 够小就原样用，别动它（PNG 线稿重新编码会糊）
  if (shrink === 1 && raw.length <= MAX_DATA_URL) {
    return { image: raw, width: nw, height: nh }
  }

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return { image: raw, width: nw, height: nh }
  // JPEG 没有透明通道，不铺白底的话透明区域会变成黑块
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cw, ch)
  ctx.drawImage(img, 0, 0, cw, ch)

  let out = canvas.toDataURL('image/png')
  if (out.length > MAX_DATA_URL) out = canvas.toDataURL('image/jpeg', 0.85)
  if (out.length > MAX_DATA_URL) out = canvas.toDataURL('image/jpeg', 0.7)

  const mb = (raw.length / 1048576).toFixed(1)
  return {
    image: out,
    width: cw,
    height: ch,
    note:
      out.length > MAX_DATA_URL
        ? `底图压到 ${cw}×${ch} 还是偏大，可能存不进小说文件。建议换一张更小的图。`
        : `原图 ${mb} MB，已压到 ${cw}×${ch} 以便存进小说文件。`,
  }
}

/* ============================================================
   地图这一栏：先看有哪些地图，再进一张

    为什么要有这一层：
    底图、图钉、区域都是**一张地图**内部的事。一部长篇往往不止一张图 ——
    世界总图、某座城的街区图、一条行军路线的示意图。以前只有「一张都没
    有的时候」能新建，建完第一张，界面上就再没有地方能加第二张了。

    现在第一屏是列表（缩略图、图钉数、区域数、有没有底图），点进去才是
    那张图的界面，顶上的名字就地能改 —— 和时间线那一栏同一个形状。
   ============================================================ */

export function MapsSection() {
  const novel = useStore((s) => s.novel)
  /** null = 还在列表 */
  const [openId, setOpenId] = useState<string | null>(null)

  const maps = novel?.project.maps ?? []
  const open = openId ? maps.find((m) => m.id === openId) : undefined

  /* 这张地图被删掉之后，别停在一个空壳上 */
  if (openId && !open) return <MapList onOpen={setOpenId} />
  if (open) return <MapEditor mapId={open.id} onBack={() => setOpenId(null)} />
  return <MapList onOpen={setOpenId} />
}

/** 新地图。宽高先按默认平面给，传了底图之后会改成底图的真实比例 */
function newMap(name: string): WorldMap {
  return {
    id: `map_${Math.random().toString(36).slice(2, 8)}`,
    name,
    width: DEFAULT_W,
    height: DEFAULT_H,
    pins: [],
    regions: [],
  }
}

/* ============================================================
   列表
   ============================================================ */

export function MapList({ onOpen }: { onOpen: (id: string) => void }) {
  const novel = useStore((s) => s.novel)
  const setMaps = useStore((s) => s.setMaps)
  const [confirm, setConfirm] = useState<string | null>(null)

  if (!novel) return null
  const maps = novel.project.maps

  const create = () => {
    const map = newMap(`地图 ${maps.length + 1}`)
    setMaps([...maps, map])
    onOpen(map.id)
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-[760px]">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[17px] font-semibold">地图</h2>
          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {maps.length} 张
          </span>
          <span className="flex-1" />
          <button type="button" className="btn btn-primary" onClick={create}>
            <Plus size={12} />
            新建地图
          </button>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: 'var(--color-ink-soft)' }}>
          一张地图是一块地方：世界总图、某座城的街区、一条行军路线，各建一张。
          图钉和区域都钉在自己的那张图上，换底图不会挪位置。
        </p>

        <div className="mt-5 flex flex-col gap-2">
          {maps.map((m) => (
            <div
              key={m.id}
              data-map={m.id}
              className="ns-card panel flex items-center gap-3 px-3 py-2.5"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => onOpen(m.id)}
                title="打开这张地图"
              >
                {/* 缩略图：有底图就真的是那张图，没有就画一块底纹 —— 光看名字
                    分不出「世界总图」和「街区图」，图能。 */}
                <span
                  aria-hidden
                  className="relative flex-none overflow-hidden"
                  style={{
                    width: 84,
                    height: 52,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-line)',
                    background:
                      'repeating-linear-gradient(45deg, var(--color-base) 0 6px, var(--color-surface) 6px 12px)',
                  }}
                >
                  {m.image && (
                    <img
                      src={m.image}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{m.name}</span>
                  <span
                    className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11.5px]"
                    style={{ color: 'var(--color-ink-faint)' }}
                  >
                    <span className="t-num">{m.pins.length} 个图钉</span>
                    <span className="t-num">{m.regions.length} 个区域</span>
                    {!m.image && <span>没有底图</span>}
                  </span>
                </span>
              </button>
              {confirm === m.id ? (
                <span className="flex flex-none items-center gap-1.5">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      setMaps(maps.filter((x) => x.id !== m.id))
                      setConfirm(null)
                    }}
                    title="删掉这张地图（图钉和区域一起走，条目本身不动）"
                  >
                    删掉这张
                  </button>
                  <button type="button" className="btn btn-plain" onClick={() => setConfirm(null)}>
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-plain flex-none"
                  style={{ padding: 4 }}
                  onClick={() => setConfirm(m.id)}
                  title="删掉这张地图（条目本身不动）"
                >
                  <Trash size={12} />
                </button>
              )}
            </div>
          ))}

          {maps.length === 0 && (
            <div
              className="px-4 py-10 text-center text-[12px] leading-relaxed"
              style={{ color: 'var(--color-ink-soft)' }}
            >
              还没有地图。点右上角「新建地图」，然后把地点和角色钉上去 ——
              写某场戏时能立刻确认谁在哪、离谁多远。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   一张地图
   ============================================================ */

function MapEditor({ mapId, onBack }: { mapId: string; onBack: () => void }) {
  const novel = useStore((s) => s.novel)
  const index = useStore((s) => s.index)
  const select = useStore((s) => s.select)
  const setMaps = useStore((s) => s.setMaps)

  const maps = novel?.project.maps ?? []
  const active = maps.find((m) => m.id === mapId)

  /** 地图平面：归一化坐标的参照物，也是底图实际铺开的区域 */
  const planeW = active?.width || DEFAULT_W
  const planeH = active?.height || DEFAULT_H

  const pins = useMemo(() => active?.pins ?? [], [active])
  const regions = useMemo(() => active?.regions ?? [], [active])
  /** 区域颜色开关，默认开。关掉就全部退回墨色描边 */
  const showRegionColors = active?.showRegionColors !== false

  // 视图变换
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<Tool>('pan')
  const [hoverPin, setHoverPin] = useState<number | null>(null)
  const [pendingRegion, setPendingRegion] = useState<Array<{ x: number; y: number }>>([])

  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 地图平面。归一化坐标的参照物是它，不是画布 ——
      画布随窗口变，平面只随地图自己的宽高比变。 */
  const planeRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    kind: 'pan' | 'pin'
    startX: number
    startY: number
    pinIndex?: number
    origin: { x: number; y: number }
  } | null>(null)

  /** 把地图平面缩放到正好放得进画布，并居中 */
  const fit = useCallback(() => {
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const s = Math.min(r.width / planeW, r.height / planeH)
    setScale(s)
    setOffset({ x: (r.width - planeW * s) / 2, y: (r.height - planeH * s) / 2 })
  }, [planeW, planeH])

  /** 画布用回调 ref 挂上，顺便装滚轮拦截 —— 用 useRef + useEffect([]) 的话，
      视图先于小说数据挂载时监听器就永远装不上了 */
  const attachStage = useCallback((el: HTMLDivElement | null) => {
    if (stageRef.current) stageRef.current.removeEventListener('wheel', preventWheel)
    stageRef.current = el
    if (el) el.addEventListener('wheel', preventWheel, { passive: false })
  }, [])

  useEffect(() => () => {
    if (stageRef.current) stageRef.current.removeEventListener('wheel', preventWheel)
  }, [])

  /* 打开地图、切地图、换底图时自动适应窗口 */
  useEffect(() => {
    fit()
  }, [fit, active?.id, active?.image])

  const updateMap = useCallback(
    (patch: Partial<WorldMap>) => {
      if (!active) return
      setMaps(maps.map((m) => (m.id === active.id ? { ...m, ...patch } : m)))
    },
    [active, maps, setMaps],
  )

  /** 屏幕坐标 → 相对「地图平面」的归一化坐标 0~1。
      平面的 getBoundingClientRect 已经含了平移与缩放，所以直接除即可。 */
  const toNorm = useCallback((clientX: number, clientY: number) => {
    const el = planeRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { x: 0, y: 0 }
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }
  }, [])

  /* ---------------- 指针交互 ---------------- */

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active) return
    const targetEl = e.target as HTMLElement
    /* 图钉的可见方块和名字都是它的子元素，e.target 往往是那些 span，
       所以要往上找最近的 [data-pin]，否则按住图钉会被当成「拖动画布」。 */
    const pinEl = targetEl.closest('[data-pin]') as HTMLElement | null

    if (tool === 'pin' && !pinEl) {
      const pos = toNorm(e.clientX, e.clientY)
      if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) return
      // 新建图钉时必须挂到一个实体上，否则图钉没有意义
      const first = novel?.entities[0]
      if (!first) return
      updateMap({ pins: [...pins, { id: newPinId(), entity: first.id, x: pos.x, y: pos.y }] })
      return
    }

    if (tool === 'region' && !pinEl) {
      const pos = toNorm(e.clientX, e.clientY)
      if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) return
      setPendingRegion((r) => [...r, pos])
      return
    }

    if (pinEl) {
      // 平移模式下按住图钉 = 挪这枚图钉。打点模式下也一样，
      // 免得想在图上微调位置时反而多出一个新图钉。
      const i = Number(pinEl.dataset.pin)
      dragRef.current = {
        kind: 'pin',
        startX: e.clientX,
        startY: e.clientY,
        pinIndex: i,
        origin: { x: pins[i].x, y: pins[i].y },
      }
    } else {
      dragRef.current = {
        kind: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        origin: offset,
      }
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || !active) return
    if (d.kind === 'pan') {
      setOffset({
        x: d.origin.x + (e.clientX - d.startX),
        y: d.origin.y + (e.clientY - d.startY),
      })
      return
    }
    if (d.kind === 'pin' && d.pinIndex !== undefined) {
      const el = planeRef.current
      if (!el) return
      // 除以平面自身的尺寸（已含缩放），得到的就是平面内的比例
      const r = el.getBoundingClientRect()
      const dx = (e.clientX - d.startX) / r.width
      const dy = (e.clientY - d.startY) / r.height
      const next = pins.map((p, i) =>
        i === d.pinIndex
          ? { ...p, x: clamp(d.origin.x + dx, 0, 1), y: clamp(d.origin.y + dy, 0, 1) }
          : p,
      )
      updateMap({ pins: next })
    }
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    // 只缩放不滚动页面。光标位置保持不动，符合直觉。
    e.preventDefault()
    const el = stageRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const next = clamp(scale * (e.deltaY > 0 ? 0.9 : 1.1), 0.1, 6)
    const k = next / scale
    setOffset({ x: mx - k * (mx - offset.x), y: my - k * (my - offset.y) })
    setScale(next)
  }

  /* ---------------- 底图上传 ---------------- */

  const [uploadNote, setUploadNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onUpload = async (file: File) => {
    setBusy(true)
    setUploadNote(null)
    try {
      const prepared = await prepareImage(file)
      updateMap({
        image: prepared.image,
        width: prepared.width,
        height: prepared.height,
      })
      setUploadNote(prepared.note ?? null)
    } catch (err) {
      setUploadNote(err instanceof Error ? err.message : '底图读取失败')
    } finally {
      setBusy(false)
    }
  }

  if (!novel || !index) return null
  /* 列表那边保证进来时这张图还在；万一刚好被删了，别停在一个空壳上 */
  if (!active) {
    return (
      <Empty
        title="这张地图不在了"
        hint="可能刚被删掉。回到列表看看还有哪些。"
        action={
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            回到地图列表
          </button>
        }
      />
    )
  }

  /** 只有「连底图都还没有、也没打任何点」时才提示空白。有底图就是有内容。 */
  const isBlank =
    !active?.image && pins.length === 0 && regions.length === 0 && pendingRegion.length === 0

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具栏 */}
        <div
          className="flex-none flex flex-wrap items-center gap-2 px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--color-line)' }}
        >
          <button type="button" className="btn btn-plain flex-none" onClick={onBack} title="回到地图列表">
            <ArrowLeft size={13} />
          </button>

          <input
            className="input"
            style={{ width: 160, flex: 'none' }}
            value={active.name}
            onChange={(e) => updateMap({ name: e.target.value })}
            placeholder="给这张地图起个名字"
            title="点进去就能改名"
          />

          <div
            style={{ width: 1, height: 18, background: 'var(--color-line)' }}
            aria-hidden
          />

          {/* 工具切换。选中态用朱砂下划线，不用方框 —— 工具是长期选中的东西 */}
          {(
            [
              ['pan', '平移', CrosshairSimple],
              ['pin', '打点', MapPin],
              ['region', '圈区域', Plus],
            ] as Array<[Tool, string, typeof MapPin]>
          ).map(([t, label, Icon]) => (
            <button
              key={t}
              type="button"
              className="tool-tab"
              aria-pressed={tool === t}
              onClick={() => {
                setTool(t)
                if (t !== 'region') setPendingRegion([])
              }}
            >
              <Icon size={13} weight={tool === t ? 'fill' : 'regular'} />
              {label}
            </button>
          ))}

          <div className="flex-1" />

          <span className="t-num" style={{ color: 'var(--color-ink-faint)' }}>
            {Math.round(scale * 100)}%
          </span>
          <button type="button" className="btn btn-plain" onClick={fit} title="缩放到正好放得下">
            适应窗口
          </button>

          <label className="btn btn-ghost cursor-pointer">
            <ImageSquare size={13} />
            {busy ? '处理中…' : '底图'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onUpload(f)
                e.target.value = ''
              }}
            />
          </label>

          {active?.image && (
            <button
              type="button"
              className="btn btn-plain"
              onClick={() => updateMap({ image: undefined })}
              title="移除底图"
            >
              <X size={12} />
            </button>
          )}

          <ConfirmButton
            confirmLabel="删除这张地图？"
            onConfirm={() => {
              setMaps(maps.filter((m) => m.id !== active.id))
              // 删掉的正是眼前这张：退回列表，别停在一张已经不存在的图
              onBack()
            }}
          >
            <Trash size={12} />
          </ConfirmButton>
        </div>

        {/* 提示条：告诉作者当前工具怎么用，避免「点了没反应」。
            底图被压缩过的话也在这儿说一声 —— 存进小说文件是有大小上限的。 */}
        <div
          className="flex-none flex items-center gap-2 px-4 py-1.5 text-[11px]"
          style={{
            background: 'var(--color-sunken)',
            borderBottom: '1px solid var(--color-line-soft)',
            color: 'var(--color-ink-faint)',
          }}
        >
          <span className="min-w-0 flex-1">
            {tool === 'pan' && '拖动平移，滚轮缩放，拖动图钉可移动位置。'}
            {tool === 'pin' &&
              (novel.entities.length === 0
                ? '图钉必须挂在一个条目上，但这本小说还没有任何条目 —— 先去「设定」建一个角色或地点。'
                : '在地图上点击落一个图钉，然后在下方面板里指定它代表哪个条目。')}
            {tool === 'region' &&
              (pendingRegion.length === 0
                ? '依次点击几个点围出一个区域，至少三个点后可以封口。'
                : `已放置 ${pendingRegion.length} 个顶点。`)}
          </span>
          {uploadNote && (
            <span className="flex-none" style={{ color: 'var(--color-accent)' }}>
              {uploadNote}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => setUploadNote(null)}
              >
                知道了
              </button>
            </span>
          )}
        </div>

        {/* 画布 */}
        <div
          ref={attachStage}
          data-stage="map"
          className="relative min-h-0 flex-1 overflow-hidden"
          style={{
            background: 'var(--color-sunken)',
            cursor: tool === 'pan' ? (dragRef.current ? 'grabbing' : 'grab') : 'crosshair',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          {/* 地图平面：尺寸 = 地图自己的宽高，底图正好铺满它。
              所有归一化坐标都是相对这个平面，所以窗口怎么改都不会错位。 */}
          <div
            ref={planeRef}
            data-plane="1"
            className="absolute origin-top-left"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              width: planeW,
              height: planeH,
            }}
          >
            {/* 底图 或 程序生成的底纹 */}
            {active?.image ? (
              <img
                src={active.image}
                alt={active.name}
                draggable={false}
                className="absolute inset-0 h-full w-full select-none object-fill"
              />
            ) : (
              <BaseTexture />
            )}

            {/* 区域 */}
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              style={{ pointerEvents: 'none' }}
            >
              {regions.map((r) => {
                /* 关掉「显示区域颜色」时，所有区域一律用墨色描边，
                   这样底图本身看得清，但形状还在、还找得到。 */
                const color = showRegionColors
                  ? (linkColorHex(r.color) ?? 'var(--color-ink-soft)')
                  : 'var(--color-ink-soft)'
                return (
                  <g key={r.id}>
                    <polygon
                      points={r.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                      fill={color}
                      fillOpacity={showRegionColors ? 0.18 : 0.05}
                      stroke={color}
                      strokeOpacity={showRegionColors ? 0.9 : 0.3}
                      strokeWidth={0.25}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                )
              })}
              {/* 正在绘制的区域 */}
              {pendingRegion.length > 0 && (
                <polyline
                  points={pendingRegion.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                  fill="var(--color-accent)"
                  fillOpacity={0.08}
                  stroke="var(--color-accent)"
                  strokeWidth={0.25}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>

            {/* 图钉 */}
            {pins.map((pin, i) => {
              const ent = index.byId.get(pin.entity)
              if (!ent) return null
              const meta = ENTITY_META[ent.type]
              return (
                <button
                  key={`${pin.entity}-${i}`}
                  type="button"
                  data-pin={i}
                  onClick={(e) => {
                    e.stopPropagation()
                    select(ent.id)
                  }}
                  onPointerEnter={() => setHoverPin(i)}
                  onPointerLeave={() => setHoverPin(null)}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${pin.x * 100}%`,
                    top: `${pin.y * 100}%`,
                    cursor: 'grab',
                  }}
                  title={pin.label ? `${pin.label}（${ent.name}）` : ent.name}
                >
                  <span
                    className="block transition-transform"
                    style={{
                      width: hoverPin === i ? 13 : 10,
                      height: hoverPin === i ? 13 : 10,
                      borderRadius: 'var(--radius-xs)',
                      // 挑过颜色就用自己的，没挑就跟着条目类型
                      background: linkColorHex(pin.color) ?? `var(${meta.cssVar})`,
                      border: '1.5px solid var(--color-base)',
                      boxShadow: '0 1px 3px rgb(0 0 0 / 0.6)',
                    }}
                  />
                  {(hoverPin === i || scale > 1.6) && (
                    <span
                      className="absolute top-full left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
                      style={{
                        marginTop: 4,
                        background: 'var(--color-overlay)',
                        border: '1px solid var(--color-line-strong)',
                        color: 'var(--color-ink)',
                        // 反向缩放，让标签在任何缩放级别下都保持可读
                        transform: `translateX(-50%) scale(${1 / scale})`,
                        transformOrigin: 'top center',
                      }}
                    >
                      {/* 图钉自己起过名字就用它，条目名退成附注 */}
                      {pin.label || ent.name}
                      {pin.label && (
                        <span style={{ color: 'var(--color-ink-faint)' }}>
                          {' '}
                          · {ent.name}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* 空图提示，压在画布上而不是替换画布。
              只有「没底图、没图钉、没区域」时才算空 —— 有底图就绝不提示。 */}
          {active && isBlank && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div
                className="rounded-[var(--radius-lg)] px-4 py-3 text-center"
                style={{
                  background: 'color-mix(in oklab, var(--color-base) 82%, transparent)',
                  border: '1px solid var(--color-line)',
                  backdropFilter: 'blur(6px)',
                }}
              >
                <div className="text-[12.5px] font-medium">这张地图还没有底图</div>
                <div
                  className="mt-1 max-w-[34ch] text-[11.5px] leading-relaxed"
                  style={{ color: 'var(--color-ink-soft)' }}
                >
                  {novel.entities.length === 0
                    ? '先在「设定」里建几个地点和角色，再把它们钉到这儿。'
                    : '上传一张底图（手绘、AI 生成、网上找的都可以），或者直接在暗纹上打点。'}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 圈区域时的收尾按钮 */}
        {tool === 'region' && pendingRegion.length >= 3 && (
          <div
            className="flex-none flex items-center gap-2 px-4 py-2"
            style={{ borderTop: '1px solid var(--color-line)' }}
          >
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                updateMap({
                  regions: [
                    ...regions,
                    {
                      id: `reg_${Math.random().toString(36).slice(2, 8)}`,
                      name: `区域 ${regions.length + 1}`,
                      points: pendingRegion,
                    },
                  ],
                })
                setPendingRegion([])
              }}
            >
              封口成区域
            </button>
            <button
              type="button"
              className="btn btn-plain"
              onClick={() => setPendingRegion([])}
            >
              放弃
            </button>
          </div>
        )}
      </div>

      {/* 右侧：图钉与区域清单 */}
      <div
        className="flex-none min-h-0 overflow-y-auto px-4 py-4"
        style={{ width: 260, borderLeft: '1px solid var(--color-line)' }}
      >
        {/* key 绑在地图 id 上：换地图时整块重挂，展开状态自动清空 */}
        <PinList
          key={`pins-${active?.id ?? ''}`}
          map={active}
          pins={pins}
          entities={novel.entities}
          onChange={(next) => updateMap({ pins: next })}
          onSelect={select}
        />
        <RegionList
          key={`regs-${active?.id ?? ''}`}
          map={active}
          regions={regions}
          showColors={showRegionColors}
          onToggleColors={(v) => updateMap({ showRegionColors: v })}
          onChange={(next) => updateMap({ regions: next })}
        />
      </div>
    </div>
  )
}

/* ---------------- 底纹：无底图时的程序化地形感 ---------------- */

function BaseTexture() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* 经纬网 */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <pattern id="ns-grid" width="5%" height="8%" patternUnits="objectBoundingBox">
            <path
              d="M 100 0 L 0 0 0 100"
              fill="none"
              stroke="var(--color-line-soft)"
              strokeWidth="0.5"
              opacity="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ns-grid)" />
      </svg>
      {/* 等高线：几条安静的手绘感曲线，让空地图不显得是坏的 */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        aria-hidden
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <path
            key={i}
            d={`M -5 ${12 + i * 7} C 15 ${6 + i * 7}, 30 ${20 + i * 6}, 52 ${13 + i * 7} S 82 ${
              4 + i * 7
            }, 108 ${14 + i * 6}`}
            fill="none"
            stroke="var(--color-line)"
            strokeWidth="0.12"
            opacity={0.55 - i * 0.06}
          />
        ))}
      </svg>
    </div>
  )
}

/* ---------------- 颜色：十二个低饱和传统色，和连线同一套 ---------------- */

function ColorSwatches({
  value,
  fallback,
  onChange,
}: {
  value?: LinkColor
  /** 不挑颜色时会跟着什么走，写在「默认」的悬停提示里 */
  fallback: string
  onChange: (color: LinkColor | undefined) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="t-micro">颜色</span>
        <button
          type="button"
          className="btn btn-plain"
          style={{
            padding: '0 3px',
            fontSize: 10,
            lineHeight: 1.4,
            color: value === undefined ? 'var(--color-accent)' : 'var(--color-ink-faint)',
          }}
          aria-pressed={value === undefined}
          onClick={() => onChange(undefined)}
          title={fallback}
        >
          默认
        </button>
      </div>
      {/* 十二个色排成一行。用 1fr 均分，宽度跟着面板走，不会换行也不会溢出 */}
      <div
        className="swatch-row"
        style={{ gridTemplateColumns: `repeat(${LINK_COLORS.length}, minmax(0, 1fr))` }}
      >
        {LINK_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            className="swatch"
            aria-pressed={value === c.value}
            onClick={() => onChange(value === c.value ? undefined : c.value)}
            title={c.label}
            style={{ background: c.hex }}
          />
        ))}
      </div>
    </div>
  )
}

/* ---------------- 开关：方角小方格，不用胶囊 ---------------- */

function Toggle({
  on,
  label,
  title,
  onChange,
}: {
  on: boolean
  label: string
  title: string
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="btn btn-plain flex items-center gap-1.5"
      style={{
        padding: '1px 5px',
        fontSize: 10.5,
        color: on ? 'var(--color-accent)' : 'var(--color-ink-faint)',
      }}
      onClick={() => onChange(!on)}
      title={title}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          display: 'inline-block',
          background: on ? 'var(--color-accent)' : 'transparent',
          border: `1.5px solid ${on ? 'var(--color-accent)' : 'var(--color-line-strong)'}`,
        }}
      />
      {label}
    </button>
  )
}

/* ---------------- 卡片染色 ----------------
   每张方格用自己在地图上的那个颜色染一遍：底色掺一点，边框掺得多一点。
   这样收起状态下不用额外的色点，看方格的色就知道它对应地图上哪一块。 */

function cardTint(tint: string): React.CSSProperties {
  return {
    border: `1px solid color-mix(in srgb, ${tint} 42%, var(--color-base))`,
    background: `color-mix(in srgb, ${tint} 11%, var(--color-base))`,
  }
}

/* ---------------- 清单卡片：平时只露名字，点一下才展开 ---------------- */

/** 每张卡片的展开状态。键是稳定 id，切地图时整体重挂所以会自动清空 */
function useOpenCards() {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  return { open, toggle }
}

/** 收起状态的那一行：只有名字。整行都是展开的点击区 */
function CardHeader({
  name,
  open,
  onToggle,
  right,
}: {
  name: string
  open: boolean
  onToggle: () => void
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onToggle}
        title={open ? '收起' : '展开'}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
      >
        <span
          aria-hidden
          className="flex-none"
          style={{ color: 'var(--color-ink-faint)', lineHeight: 0 }}
        >
          {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[12px]"
          style={{ color: name ? 'var(--color-ink)' : 'var(--color-ink-faint)' }}
        >
          {name || '未命名'}
        </span>
      </button>
      {right}
    </div>
  )
}

/* ---------------- 图钉清单 ---------------- */

function PinList({
  map,
  pins,
  entities,
  onChange,
  onSelect,
}: {
  map?: WorldMap
  pins: Pin[]
  entities: Entity[]
  onChange: (pins: Pin[]) => void
  onSelect: (id: string) => void
}) {
  const { open, toggle } = useOpenCards()
  if (!map) return null

  return (
    <div>
      <SectionLabel>图钉 {pins.length}</SectionLabel>
      {pins.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--color-ink-faint)' }}>
          {entities.length === 0
            ? '还没有任何条目。图钉必须挂在条目上，先去「设定」建一个。'
            : '还没有图钉。切到「打点」工具，在地图上点一下。'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {pins.map((pin, i) => {
            const ent = entities.find((e) => e.id === pin.entity)
            const key = `pin:${pin.id ?? `${pin.entity}-${i}`}`
            const isOpen = open.has(key)
            /** 和地图上那枚圆点同一个色：挑过就用自己的，没挑就跟着条目类型 */
            const tint = linkColorHex(pin.color) ?? `var(${ENTITY_META[ent?.type ?? 'concept'].cssVar})`
            return (
              <div
                key={key}
                data-pin-card={i}
                data-open={isOpen ? 'true' : 'false'}
                data-tint={tint}
                className="rounded-[var(--radius-md)] px-2 py-1.5"
                style={cardTint(tint)}
              >
                <CardHeader
                  name={pin.label || ent?.name || ''}
                  open={isOpen}
                  onToggle={() => toggle(key)}
                  right={
                    isOpen ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-plain"
                          onClick={() => onSelect(pin.entity)}
                          title="去「设定」里看这个条目"
                          style={{ padding: 2 }}
                        >
                          <TypeDot type={ent?.type ?? 'concept'} size={6} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-plain"
                          onClick={() => onChange(pins.filter((_, j) => j !== i))}
                          title="移除图钉"
                          style={{ padding: 2 }}
                        >
                          <X size={11} />
                        </button>
                      </>
                    ) : undefined
                  }
                />

                {isOpen && (
                  <div className="mt-1.5">
                    <select
                      className="input"
                      style={{ fontSize: 11 }}
                      value={pin.entity}
                      title="这枚图钉代表哪个条目"
                      onChange={(e) =>
                        onChange(
                          pins.map((p, j) => (j === i ? { ...p, entity: e.target.value } : p)),
                        )
                      }
                    >
                      {entities.map((e) => (
                        <option key={e.id} value={e.id}>
                          {ENTITY_META[e.type].label}：{e.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input mt-1.5"
                      style={{ fontSize: 11 }}
                      placeholder="这枚图钉叫什么，如：前线指挥部"
                      value={pin.label ?? ''}
                      onChange={(e) =>
                        onChange(pins.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))
                      }
                    />
                    <div className="mt-2" title="图钉的颜色">
                      <ColorSwatches
                        value={pin.color}
                        fallback="不挑颜色：跟着条目类型走"
                        onChange={(color) =>
                          onChange(pins.map((p, j) => (j === i ? { ...p, color } : p)))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------------- 区域清单 ---------------- */

function RegionList({
  map,
  regions,
  showColors,
  onToggleColors,
  onChange,
}: {
  map?: WorldMap
  regions: WorldMap['regions']
  showColors: boolean
  onToggleColors: (v: boolean) => void
  onChange: (regions: WorldMap['regions']) => void
}) {
  const { open, toggle } = useOpenCards()
  if (!map) return null

  return (
    <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--color-line-soft)' }}>
      <SectionLabel
        right={
          <Toggle
            on={showColors}
            label="上色"
            title={
              showColors
                ? '关掉：所有区域都不显示自己的颜色，只留墨色轮廓'
                : '打开：每个区域在地图上显示自己的颜色'
            }
            onChange={onToggleColors}
          />
        }
      >
        区域 {regions.length}
      </SectionLabel>
      {regions.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--color-ink-faint)' }}>
          还没有区域。切到「圈区域」工具，连点几下围出一块地，封口之后可以起名字、挑颜色、写一段说明。
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {regions.map((r) => {
            const key = `reg:${r.id}`
            const isOpen = open.has(key)
            const tint = linkColorHex(r.color) ?? 'var(--color-ink-soft)'
            return (
              <div
                key={key}
                data-region={r.id}
                data-open={isOpen ? 'true' : 'false'}
                data-tint={tint}
                className="rounded-[var(--radius-md)] px-2 py-1.5"
                style={cardTint(tint)}
              >
                <CardHeader
                  name={r.name}
                  open={isOpen}
                  onToggle={() => toggle(key)}
                  right={
                    isOpen ? (
                      <button
                        type="button"
                        className="btn btn-plain"
                        onClick={() => onChange(regions.filter((x) => x.id !== r.id))}
                        title="删除区域"
                        style={{ padding: 2 }}
                      >
                        <X size={11} />
                      </button>
                    ) : undefined
                  }
                />

                {isOpen && (
                  <div className="mt-1.5">
                    <input
                      className="input"
                      style={{ fontSize: 11 }}
                      placeholder="区域名"
                      value={r.name}
                      onChange={(e) =>
                        onChange(
                          regions.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)),
                        )
                      }
                    />
                    <div className="mt-2" title="区域的颜色">
                      <ColorSwatches
                        value={r.color}
                        fallback="不挑颜色：用默认墨色"
                        onChange={(color) =>
                          onChange(regions.map((x) => (x.id === r.id ? { ...x, color } : x)))
                        }
                      />
                    </div>
                    <textarea
                      className="input mt-2 resize-y"
                      style={{ fontSize: 11, minHeight: 52 }}
                      rows={2}
                      placeholder="这个区域是什么？边界怎么划的？"
                      value={r.desc ?? ''}
                      onChange={(e) =>
                        onChange(
                          regions.map((x) => (x.id === r.id ? { ...x, desc: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
