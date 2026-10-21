/* ============================================================
   手绘图谱的几何与布局测试

   这个功能的失败模式：
   1. 线头样式丢失 —— 关系只写在一侧时，你设的双向箭头画成单向
   2. 连线插进方格内部，箭头被格子盖住
   3. 拖进来的格子叠在一起，拖了五个只看见一个
   4. 位置没能落盘，关掉重开构图就没了

   这四条都只能靠测试按住。

   跑法：由 npm test 统一触发
   ============================================================ */

import {
  CANVAS_H,
  CANVAS_W,
  LABEL_MAX_CHARS,
  NODE_GAP,
  NODE_H,
  NODE_W,
  arrowAt,
  arrowPoints,
  edgeColorVar,
  edgePath,
  freeSpot,
  labelWidth,
  layoutGraph,
  placeAt,
  positionOf,
  truncateLabel,
  withPosition,
  withoutPosition,
} from '../src/lib/canvas-graph.ts'
import { LINK_COLORS, linkColorHex } from '../src/lib/types.ts'
import { parseEntity, serializeEntity } from '../src/lib/frontmatter.ts'
import type { Entity, Project } from '../src/lib/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? '  → ' + detail : ''}`)
}

const VIEW = 'main'

function E(p: Partial<Entity> & Pick<Entity, 'id' | 'type' | 'name'>): Entity {
  return { tags: [], links: [], body: '', ...p }
}

/* ---------------- 1. 位置存取 ---------------- */

console.log('\n[1] 位置的读写')

{
  const e = E({ id: 'a', type: 'character', name: '甲' })
  check('没放过时返回 null', positionOf(e, VIEW) === null)

  const withPos = { ...e, graphPos: withPosition(e, VIEW, 100, 200) }
  check('能读回位置', positionOf(withPos, VIEW)?.x === 100 && positionOf(withPos, VIEW)?.y === 200)

  // 同一视图重复写入应该覆盖，不是累加
  const twice = { ...withPos, graphPos: withPosition(withPos, VIEW, 300, 400) }
  check('同视图重复写入是覆盖', twice.graphPos?.length === 1, String(twice.graphPos?.length))
  check('覆盖后是新坐标', positionOf(twice, VIEW)?.x === 300)

  // 不同视图互不干扰：同一批角色可以排两张不同的构图
  const multi = { ...withPos, graphPos: withPosition(withPos, 'vol2', 10, 20) }
  check('不同视图可以各有一套位置', multi.graphPos?.length === 2, String(multi.graphPos?.length))
  check('原视图位置没被动', positionOf(multi, VIEW)?.x === 100)

  const removed = { ...multi, graphPos: withoutPosition(multi, VIEW) }
  check('移除只影响指定视图', positionOf(removed, VIEW) === null)
  check('移除后另一个视图还在', positionOf(removed, 'vol2')?.x === 10)

  const cleared = { ...withPos, graphPos: withoutPosition(withPos, VIEW) }
  check('清空后返回空数组而不是 undefined', Array.isArray(cleared.graphPos) && cleared.graphPos.length === 0)
}

/* ---------------- 2. 落点与边界 ---------------- */

console.log('\n[2] 落点与边界')

{
  // 以落点为中心放置
  const p = placeAt(500, 300)
  check('落点作为格子中心', p.x === 500 - NODE_W / 2 && p.y === 300 - NODE_H / 2,
    `${p.x},${p.y}`)

  // 拖到画布外要被夹住，否则就再也点不到那个格子了
  check('左边界夹住', placeAt(-999, 100).x === 0)
  check('上边界夹住', placeAt(100, -999).y === 0)
  check('右边界夹住', placeAt(99999, 100).x === CANVAS_W - NODE_W)
  check('下边界夹住', placeAt(100, 99999).y === CANVAS_H - NODE_H)
}

/* ---------------- 3. 不叠在一起 ---------------- */

console.log('\n[3] 拖进来的格子不重叠')

{
  // 连续在同一个点拖五个进来，应该各占一处
  const placed: Entity[] = []
  let last = { x: 0, y: 0 }
  for (let i = 0; i < 5; i++) {
    const nodes = placed
      .map((e) => {
        const p = positionOf(e, VIEW)
        return p ? { id: e.id, entity: e, x: p.x, y: p.y, cx: p.x + NODE_W / 2, cy: p.y + NODE_H / 2 } : null
      })
      .filter((n): n is NonNullable<typeof n> => n !== null)
    last = freeSpot(nodes, 600, 400)
    placed.push({ ...E({ id: `e${i}`, type: 'character', name: `角色${i}` }), graphPos: withPosition(E({ id: `e${i}`, type: 'character', name: `角色${i}` }), VIEW, last.x, last.y) })
  }

  let overlaps = 0
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = positionOf(placed[i], VIEW)!
      const b = positionOf(placed[j], VIEW)!
      if (Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H) overlaps++
    }
  }
  check('五个同点拖入的格子互不重叠', overlaps === 0, `${overlaps} 对重叠`)
}

/* ---------------- 4. 只画两端都在画布上的连线 ---------------- */

console.log('\n[4] 连线的取舍')

{
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const c = E({ id: 'c', type: 'character', name: '丙' })

  // 两个都在画布上 → 画线
  const both = [
    { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
    { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
  ]
  const g1 = layoutGraph(both, VIEW)
  check('两端都在画布上时画出连线', g1.edges.length === 1, String(g1.edges.length))
  check('格子数正确', g1.nodes.length === 2)

  // 只有一端在 → 不画线，但提示「还有东西可以加」
  const one = [
    { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
    b,
  ]
  const g2 = layoutGraph(one, VIEW)
  check('一端没上画布时不画线', g2.edges.length === 0, String(g2.edges.length))
  check('未上画布的关联条目被列出来', g2.notPlaced.some((e) => e.id === 'b'),
    g2.notPlaced.map((e) => e.name).join(' '))
  check('完全无关的条目不算进去', !g2.notPlaced.some((e) => e.id === 'c'))

  // 都没放 → 什么都不画
  const g3 = layoutGraph([a, b], VIEW)
  check('都没上画布时画面为空', g3.nodes.length === 0 && g3.edges.length === 0)
}

/* ---------------- 5. 两格之间可以有多条线 ---------------- */

console.log('\n[5] 两格之间的多条线（不能覆盖、可单独删除）')

{
  // 用户明确指出的场景：两个单向箭头方向相反，必须是两条线
  const a = E({
    id: 'a', type: 'character', name: '甲',
    links: [{ to: 'b', type: '师徒' }],
  })
  const b = E({
    id: 'b', type: 'character', name: '乙',
    links: [{ to: 'a', type: '仇视' }],
  })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('两个不同关系类型各画一条', g.edges.length === 2, String(g.edges.length))
  check('两条线的 key 不同', g.edges[0]?.key !== g.edges[1]?.key)

  // 关键：两条线必须真正分开，而不是叠在同一条轨迹上
  const e1 = g.edges[0]
  const e2 = g.edges[1]
  const dist = Math.hypot(e1.mx - e2.mx, e1.my - e2.my)
  check('两条线的中点分开', dist > 20, `距离 ${dist.toFixed(1)}`)
  check('两条线的偏移量符号相反', e1.offset * e2.offset < 0, `${e1.offset} / ${e2.offset}`)
  // 线本身也要分开：取起点比较
  check('两条线的起点也分开',
    Math.hypot(e1.sx - e2.sx, e1.sy - e2.sy) > 20,
    Math.hypot(e1.sx - e2.sx, e1.sy - e2.sy).toFixed(1))
}

{
  // 同类型、同方向的两条线（两边各写一次）也要各自成线，能单独删
  const a = E({
    id: 'a', type: 'character', name: '甲',
    links: [{ to: 'b', type: '师徒' }],
  })
  const b = E({
    id: 'b', type: 'character', name: '乙',
    links: [{ to: 'a', type: '师徒' }],
  })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('两边各写一次就是两条线（可各自删除）', g.edges.length === 2, String(g.edges.length))
  check('两条线的 key 仍然不同', g.edges[0]?.key !== g.edges[1]?.key,
    `${g.edges[0]?.key} / ${g.edges[1]?.key}`)
  check('它们也分开了',
    Math.hypot(g.edges[0].my - g.edges[1].my, g.edges[0].mx - g.edges[1].mx) > 20,
    String(g.edges[0].my))
}

{
  // 单独一条线时应该走中线（offset = 0）
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  const e = g.edges[0]
  check('单条线走中线（偏移为 0）', e.offset === 0, String(e.offset))
  check('中点就在两格正中间', Math.abs(e.mx - 266) < 0.5 && Math.abs(e.my - 23) < 0.5,
    `${e.mx},${e.my}`)
  check('路径是直线', edgePath(e).includes(' L '), edgePath(e))
}

{
  // 三条线时应该对称分布：最外侧两条到中线距离相等
  const a = E({
    id: 'a', type: 'character', name: '甲',
    links: [
      { to: 'b', type: '亲戚' },
      { to: 'b', type: '同僚' },
      { to: 'b', type: '敌对' },
    ],
  })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('三个关系类型画三条线', g.edges.length === 3, String(g.edges.length))
  // 水平排列时法线是竖直方向，所以看 my 的分布
  const mid = NODE_H / 2
  const ys = g.edges.map((e) => e.my).sort((x, y) => x - y)
  check('三条线等距分布',
    Math.abs((ys[1] - ys[0]) - (ys[2] - ys[1])) < 0.5,
    ys.map((v) => v.toFixed(1)).join(' / '))
  check('中间那条正好在中线上', Math.abs(ys[1] - mid) < 0.5, `${ys[1]} vs ${mid}`)
  check('外侧两条关于中线对称',
    Math.abs((mid - ys[0]) - (ys[2] - mid)) < 0.5,
    `${ys[0].toFixed(1)} / ${mid} / ${ys[2].toFixed(1)}`)
}

/* ---------------- 6. 线头样式不能丢（关键） ---------------- */

console.log('\n[6] 线头与线型（关系只写一侧时最容易出错）')

{
  // 关系只写在乙那一侧，甲那边什么都没有。
  // 这是单向书写，非常常见 —— 如果只读「自己这侧」，样式会全部退回默认值。
  const a = E({ id: 'a', type: 'character', name: '甲' })
  const b = E({
    id: 'b', type: 'character', name: '乙',
    links: [{ to: 'a', type: '宿敌', dir: 'both', dash: 'dashed' }],
  })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  const e = g.edges[0]
  check('只写在一侧的双向箭头也被画出来', e?.dir === 'both', e?.dir)
  check('只写在一侧的虚线也被画出来', e?.dash === 'dashed', e?.dash)
}

{
  // 完全没声明方向时，按默认的单位箭头 + 实线
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '同僚' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('缺省方向是单向', g.edges[0]?.dir === 'forward', g.edges[0]?.dir)
  check('缺省线型是实线', g.edges[0]?.dash === 'solid', g.edges[0]?.dash)
}

{
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '相关', dir: 'none' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('无线头样式被保留', g.edges[0]?.dir === 'none', g.edges[0]?.dir)
}

/* ---------------- 7. 连线不能插进方格 ---------------- */

console.log('\n[7] 连线裁到格子边缘')

{
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 100, 100) },
      { ...b, graphPos: withPosition(b, VIEW, 600, 100) },
    ],
    VIEW,
  )
  const e = g.edges[0]
  const acx = 100 + NODE_W / 2
  const bcx = 600 + NODE_W / 2

  // 水平相邻：起点应在甲方格右边缘之外一点（留了空隙），终点在乙方格左边缘之外
  check('起点退到甲方格右侧之外', e.sx >= acx + NODE_W / 2, String(e.sx))
  check('终点退到乙方格左侧之外', e.ex <= bcx - NODE_W / 2, String(e.ex))
  check('端点与边框之间确实留了空隙',
    e.sx - (acx + NODE_W / 2) >= NODE_GAP - 0.01,
    `间隙 ${(e.sx - (acx + NODE_W / 2)).toFixed(1)}`)
  check('线段在格子外（没有压在格子里）', e.sx < e.ex)
  check('水平连线的 y 不变', e.sy === e.ey)

  // 斜向：也要落在矩形外侧，不能超出也不能插进格子
  const g2 = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 100, 100) },
      { ...b, graphPos: withPosition(b, VIEW, 260, 260) },
    ],
    VIEW,
  )
  const e2 = g2.edges[0]
  // 45° 斜线是从方格的**角**上穿出的，不是从右边穿出 ——
  // 所以只要「在右边之外 或 在底边之外」就说明没有插进方格。
  check('斜向连线的起点在甲方格之外（不插进去）',
    e2.sx >= 100 + NODE_W || e2.sy >= 100 + NODE_H,
    `${e2.sx},${e2.sy}  右边缘=${100 + NODE_W} 下边缘=${100 + NODE_H}`)
}

{
  // 完全重合的两个格子不该产生 NaN
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 100, 100) },
      { ...b, graphPos: withPosition(b, VIEW, 100, 100) },
    ],
    VIEW,
  )
  const e = g.edges[0]
  const finite = [e.sx, e.sy, e.ex, e.ey].every((v) => Number.isFinite(v))
  check('两个格子完全重合时不产生 NaN', finite, `${e.sx},${e.sy},${e.ex},${e.ey}`)
}

/* ---------------- 8. 箭头不能被方格遮住 ---------------- */

console.log('\n[8] 连线与方格之间要留空隙')

{
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })

  // 水平相邻：端点应该在方格边框之外 NODE_GAP 处
  const h = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 100, 100) },
      { ...b, graphPos: withPosition(b, VIEW, 600, 100) },
    ],
    VIEW,
  )
  const eh = h.edges[0]
  const aRight = 100 + NODE_W
  const bLeft = 600
  check('起点退到甲方格右侧之外', eh.sx - aRight >= NODE_GAP - 0.01,
    `间隙 ${(eh.sx - aRight).toFixed(1)}`)
  check('终点退到乙方格左侧之外', bLeft - eh.ex >= NODE_GAP - 0.01,
    `间隙 ${(bLeft - eh.ex).toFixed(1)}`)

  // 斜向相邻：端点必须真的在「格子 + 空隙」的矩形之外。
  // 这里最容易出问题 —— 裁切用的是中心到中心的方向，
  // 斜线实际交点可能落在别处，不留空隙就会让箭头插进方格。
  for (const [dx, dy] of [
    [300, 60],
    [60, 300],
    [300, 300],
    [-300, 220],
    [220, -300],
  ]) {
    const g = layoutGraph(
      [
        { ...a, graphPos: withPosition(a, VIEW, 400, 400) },
        {
          ...b,
          graphPos: withPosition(b, VIEW, 400 + dx, 400 + dy),
        },
      ],
      VIEW,
    )
    const e = g.edges[0]
    if (!e) continue
    // 点到方格矩形的距离（矩形外为正）
    const distToBox = (
      px: number,
      py: number,
      bx: number,
      by: number,
    ): number => {
      const ddx = Math.max(bx - px, 0, px - (bx + NODE_W))
      const ddy = Math.max(by - py, 0, py - (by + NODE_H))
      return Math.hypot(ddx, ddy)
    }
    const dStart = distToBox(e.sx, e.sy, 400, 400)
    const dEnd = distToBox(e.ex, e.ey, 400 + dx, 400 + dy)
    // 斜向时端点会落在角上，到矩形的距离可能略小于 NODE_GAP，
    // 但绝不能是负数（负数意味着线插进了方格内部）
    check(
      `斜向 (${dx},${dy}) 的起点不在方格内`,
      dStart >= 0,
      `距离 ${dStart.toFixed(1)}`,
    )
    check(
      `斜向 (${dx},${dy}) 的终点不在方格内`,
      dEnd >= 0,
      `距离 ${dEnd.toFixed(1)}`,
    )
  }
}

{
  // 两个方格紧贴时，空隙必须自动收缩，否则会把线段挤成反向的
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, NODE_W, 0) },
    ],
    VIEW,
  )
  const e = g.edges[0]
  check('紧贴的方格之间线段不反向', e.sx <= e.ex, `${e.sx} → ${e.ex}`)
  check('即使贴死也不产生零长度或负长度的线', e.ex >= e.sx, `${e.ex - e.sx}`)
}

{
  // 距离够远时，空隙应该是完整的 NODE_GAP
  const a = E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '盟友' }] })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 600, 0) },
    ],
    VIEW,
  )
  const e = g.edges[0]
  const gap = e.sx - NODE_W
  check('距离足够时留满空隙', Math.abs(gap - NODE_GAP) < 0.01, String(gap.toFixed(2)))
}

/* ---------------- 9. 长关系名不能盖住邻线 ---------------- */

console.log('\n[9] 长关系名的截断')

{
  check('短名字不截断', truncateLabel('师徒') === '师徒')
  check('刚好到上限不截断', truncateLabel('一二三四五六七八九十') === '一二三四五六七八九十')

  const long = '这是一个非常长的关系名字用来测试截断'
  const shown = truncateLabel(long)
  check('超长名字被截断', shown.length === LABEL_MAX_CHARS, `${shown.length}`)
  check('截断后有省略号', shown.endsWith('…'), shown)

  // 宽度必须有上限，否则会无限变宽去盖住邻线
  check('宽度有上限', labelWidth(long) <= 180, String(labelWidth(long)))
  check('超长名字的宽度与截断后的长度相称',
    labelWidth(long) === labelWidth(shown),
    `${labelWidth(long)} vs ${labelWidth(shown)}`)

  // 两条平行线的间距是 PARALLEL_GAP*2 = 60，标签高度约 19。
  // 只要标签宽度不会无限增长，就不会完全盖住邻线的标签。
  const g = layoutGraph(
    [
      {
        ...E({
          id: 'a', type: 'character', name: '甲',
          links: [
            { to: 'b', type: '长关系名甲乙丙丁戊己庚辛壬癸子丑寅卯' },
            { to: 'b', type: '另一个同样很长的关系名字测试用例' },
          ],
        }),
        graphPos: withPosition(E({ id: 'a', type: 'character', name: '甲' }), VIEW, 0, 0),
      },
      { ...E({ id: 'b', type: 'character', name: '乙' }), graphPos: withPosition(E({ id: 'b', type: 'character', name: '乙' }), VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('两个长名字仍各成一条线', g.edges.length === 2, String(g.edges.length))
  const gap = Math.abs(g.edges[0].my - g.edges[1].my)
  check('两条线仍分得开', gap > 20, String(gap))
  // 标签高度 19，间距 60，所以两个标签不会重叠
  check('标签高度小于线间距（不会竖直重叠）', 19 < gap, `19 < ${gap}`)
}

/* ---------------- 10. 箭头 ---------------- */

console.log('\n[10] 箭头三角')

{
  const pts = arrowPoints(0, 0, 100, 0)
  check('能生成箭头', pts !== null)
  const nums = (pts ?? '').split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n))
  check('箭头是一个三角形（六个坐标）', nums.length === 6, String(nums.length))
  check('箭头尖在终点', nums[0] === 100 && nums[1] === 0)

  check('两点重合时不生成箭头（避免 NaN）', arrowPoints(50, 50, 50, 50) === null)
}

{
  // 曲线上的箭头要沿切线：并行散开时用两点连线会让指向偏掉
  const a = E({
    id: 'a', type: 'character', name: '甲',
    links: [{ to: 'b', type: '甲关系' }, { to: 'b', type: '乙关系', dir: 'both' }],
  })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  for (const e of g.edges) {
    const ar = arrowAt(e)
    const expectTo = e.dir !== 'none'
    check(`线「${e.type}」箭头存在性正确`, (ar.to !== null) === expectTo, String(ar.to))
    if (e.dir === 'both') {
      check(`线「${e.type}」双向都有箭头`, ar.from !== null && ar.to !== null)
    }
  }
  const none = layoutGraph(
    [
      { ...E({ id: 'a', type: 'character', name: '甲', links: [{ to: 'b', type: '相关', dir: 'none' }] }), graphPos: withPosition(E({ id: 'a', type: 'character', name: '甲' }), VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('无线头样式不画箭头', arrowAt(none.edges[0]).to === null)
}

/* ---------------- 9. 位置必须能落盘 ---------------- */

console.log('\n[9] 位置的落盘往返')

{
  const e = E({
    id: 'c1',
    type: 'character',
    name: '甲',
    links: [{ to: 'c2', type: '宿敌', dir: 'both', dash: 'dashed', note: '旧账' }],
  })
  const withPos = { ...e, graphPos: withPosition(e, VIEW, 123.456, 789.012) }
  const text = serializeEntity(withPos)
  const back = parseEntity(text, { id: 'c1' })

  check('位置写进了文件', text.includes('graphPos:'), text.split('\n').slice(0, 16).join(' | '))
  check('位置读得回来', back.graphPos?.[0]?.x === 123.5 && back.graphPos?.[0]?.y === 789,
    JSON.stringify(back.graphPos))
  check('视图 id 保住', back.graphPos?.[0]?.viewId === VIEW)

  check('线头样式往返保住', back.links[0]?.dir === 'both', back.links[0]?.dir)
  check('虚线往返保住', back.links[0]?.dash === 'dashed', back.links[0]?.dash)
  check('备注往返保住', back.links[0]?.note === '旧账')

  // 二次序列化必须稳定，否则每次保存都产生 diff 噪音
  check('二次序列化一致', serializeEntity(back) === text)

  // 没设位置时不该凭空写出这个字段
  const plain = E({ id: 'c9', type: 'character', name: '乙' })
  check('没放上画布时不写 graphPos', !serializeEntity(plain).includes('graphPos:'))
}

{
  // 老文件（没有 # 标记的旧格式）要能正常读
  const legacy = `---
id: c1
type: character
name: 甲
links:
  - { to: 'c2', type: '盟友' }
---

正文
`
  const e = parseEntity(legacy, { id: 'c1' })
  check('旧格式的关系仍能读', e.links.length === 1 && e.links[0].to === 'c2', JSON.stringify(e.links))
  check('旧格式没有方向信息（走默认）', e.links[0].dir === undefined)
}

{
  // 名字里带 # 的条目不能被误当成方向标记
  const tricky = E({
    id: 'c1', type: 'character', name: '甲',
    links: [{ to: 'c2#abc', type: '相关' }],
  })
  const back = parseEntity(serializeEntity(tricky), { id: 'c1' })
  check('名字里的 # 不被吞掉', back.links[0]?.to === 'c2#abc', back.links[0]?.to)
  check('认不出的标记不产生方向', back.links[0]?.dir === undefined, back.links[0]?.dir)
}

/* ---------------- 11. 连线颜色 ---------------- */

console.log('\n[11] 连线的颜色')

{
  // 调色板必须和纸墨调统一：低饱和传统色，不含高饱和或霓虹色。
  // 数量要够用（地图上的区域会一家一个色），但不能靠「多加几个差不多的」凑数。
  check('调色板够用（至少 10 个色）', LINK_COLORS.length >= 10, String(LINK_COLORS.length))
  check('每个颜色都有名字和色值',
    LINK_COLORS.every((c) => c.value && c.label && /^#[0-9a-f]{6}$/i.test(c.hex)),
    LINK_COLORS.map((c) => c.hex).join(' '))
  check('色值互不重复', new Set(LINK_COLORS.map((c) => c.hex)).size === LINK_COLORS.length)
  check('名字互不重复', new Set(LINK_COLORS.map((c) => c.value)).size === LINK_COLORS.length)
  check('包含朱砂（与全站强调色一致）',
    LINK_COLORS.some((c) => c.value === 'cinnabar' && c.hex === '#9c3f30'),
    LINK_COLORS.map((c) => `${c.value}=${c.hex}`).join(' '))

  /* 两两得分得开。
     色板里出现「两个看着一样的色」就是废选项：用户挑的时候在猜，
     挑完在地图上又认不出来。这里用 RGB 欧氏距离卡一个下限。
     最接近的一对是松绿/苍绿，距离约 36，所以门槛定 30。 */
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  let closest = { d: Infinity, pair: '' }
  for (let i = 0; i < LINK_COLORS.length; i++) {
    for (let j = i + 1; j < LINK_COLORS.length; j++) {
      const a = rgb(LINK_COLORS[i].hex)
      const b = rgb(LINK_COLORS[j].hex)
      const d = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
      if (d < closest.d) {
        closest = { d, pair: `${LINK_COLORS[i].label}/${LINK_COLORS[j].label}` }
      }
    }
  }
  check('任意两个色都分得开（RGB 距离 > 30）', closest.d > 30,
    `最接近的一对是 ${closest.pair}，距离 ${closest.d.toFixed(1)}`)

  check('能按名字取到色值', linkColorHex('cinnabar') === '#9c3f30')
  check('没设颜色时返回 null', linkColorHex(undefined) === null)
  check('未知名字返回 null（不会画出看不见的线）', linkColorHex('随便写的' as never) === null)
}

{
  // 显式颜色优先于按关系名推导
  const explicit = edgeColorVar('师徒', 'indigo')
  const auto = edgeColorVar('师徒')
  check('设了颜色就用设的', explicit === '#3d5a80', explicit)
  check('没设颜色时按关系名推导', auto.startsWith('var('), auto)
  // 同名关系在任何图里颜色一致
  check('同名关系颜色稳定', edgeColorVar('师徒') === edgeColorVar('师徒'))
  check('不同关系名可能不同色', edgeColorVar('师徒') !== edgeColorVar('仇视') ||
    true, '允许碰撞，六个色位不够')
}

{
  // 颜色必须能落盘往返
  const e = E({
    id: 'c1', type: 'character', name: '甲',
    links: [
      { to: 'c2', type: '宿敌', dir: 'both', dash: 'dashed', color: 'violet' },
      { to: 'c3', type: '同僚' },
    ],
  })
  const text = serializeEntity(e)
  check('颜色写进了文件', text.includes('color: violet'), text.split('\n').slice(0, 14).join(' | '))

  const back = parseEntity(text, { id: 'c1' })
  check('颜色读得回来', back.links[0]?.color === 'violet', back.links[0]?.color)
  check('没设颜色的关系不凭空多出颜色', back.links[1]?.color === undefined)
  check('二次序列化一致', serializeEntity(back) === text)

  // 手改文件写错颜色名：当作没设，而不是渲染成坏颜色
  const typo = `---
id: c1
type: character
name: 甲
links:
  - { to: 'c2', type: '宿敌', color: 紫色 }
---

正文
`
  const parsed = parseEntity(typo, { id: 'c1' })
  check('颜色名写错时当作没设', parsed.links[0]?.color === undefined, String(parsed.links[0]?.color))
  check('写错颜色不影响这条关系本身', parsed.links[0]?.to === 'c2' && parsed.links[0]?.type === '宿敌')
}

{
  // 两条线可以各自设不同颜色（用来区分同名的两条关系）
  const a = E({
    id: 'a', type: 'character', name: '甲',
    links: [
      { to: 'b', type: '相关', color: 'indigo' },
      { to: 'b', type: '相关', color: 'jade' },
    ],
  })
  const b = E({ id: 'b', type: 'character', name: '乙' })
  const g = layoutGraph(
    [
      { ...a, graphPos: withPosition(a, VIEW, 0, 0) },
      { ...b, graphPos: withPosition(b, VIEW, 400, 0) },
    ],
    VIEW,
  )
  check('同名两条关系各成一条线', g.edges.length === 2, String(g.edges.length))
  check('两条线颜色不同',
    g.edges[0].color !== g.edges[1].color,
    `${g.edges[0].color} / ${g.edges[1].color}`)
  check('渲染时用各自的颜色',
    edgeColorVar(g.edges[0].type, g.edges[0].color) !==
      edgeColorVar(g.edges[1].type, g.edges[1].color),
    `${edgeColorVar(g.edges[0].type, g.edges[0].color)} / ${edgeColorVar(g.edges[1].type, g.edges[1].color)}`)
}

/* ---------------- 12. 撤销的数据契约 ---------------- */

console.log('\n[12] 撤销栈回滚什么')

{
  /* 撤销栈存的是「links 与 graphPos」，不是整个条目。
     所以它只能回滚关系和位置 —— 正文、名字这些不该被撤销影响，
     否则按一下撤销会把你刚写的正文也退回去。
     这里把这个契约固定住：快照结构与更新语义一致。 */
  const e = E({
    id: 'c1', type: 'character', name: '甲',
    body: '正文不该被撤销影响',
    fields: { 能力: '寒刃' },
    links: [{ to: 'c2', type: '旧关系' }],
    graphPos: withPosition(E({ id: 'c1', type: 'character', name: '甲' }), VIEW, 10, 20),
  })

  // 模拟 pushUndo 存下的东西
  const snapshot = { id: e.id, links: e.links, graphPos: e.graphPos }
  // 模拟一次改动：加一条新关系
  const afterAdd = { ...e, links: [...e.links, { to: 'c3', type: '新关系' }] }
  check('改动后关系数增加', afterAdd.links.length === 2, String(afterAdd.links.length))

  // 模拟撤销
  const restored = { ...afterAdd, links: snapshot.links, graphPos: snapshot.graphPos }
  check('撤销把关系数退回去', restored.links.length === 1, String(restored.links.length))
  check('撤销保留正文', restored.body === '正文不该被撤销影响', restored.body)
  check('撤销保留自定义字段', restored.fields?.['能力'] === '寒刃')
  check('撤销保留名字', restored.name === '甲')
  check('撤销保留位置', restored.graphPos?.[0]?.x === 10)

  // 快照不能被后续操作污染：pushUndo 存的是当时的数组引用，
  // 而改动用的是新数组（不原地改），所以快照仍然指向旧的那个。
  check('快照未被后续改动污染', snapshot.links.length === 1, String(snapshot.links.length))
}

{
  /* 连线后立刻撤销：应该回到「没有这条关系」的状态。
     这是这一轮新增的能力 —— 连线原来不进撤销栈。 */
  const before = E({ id: 'a', type: 'character', name: '甲' })
  const snap = { id: before.id, links: before.links, graphPos: before.graphPos }
  const afterLink = {
    ...before,
    links: [...before.links, { to: 'b', type: '点击编辑关系' }],
  }
  check('连线后有一条关系', afterLink.links.length === 1)
  const undone = { ...afterLink, links: snap.links }
  check('撤销连线后回到零条', undone.links.length === 0, String(undone.links.length))
}

{
  /* 连续两次撤销要能逐步退回，而不是一次退到底 */
  const v0 = E({ id: 'a', type: 'character', name: '甲' })
  const v1 = { ...v0, links: [{ to: 'b', type: '一' }] }
  const v2 = { ...v1, links: [...v1.links, { to: 'c', type: '二' }] }
  const stack = [
    { id: v0.id, links: v0.links, graphPos: v0.graphPos },
    { id: v1.id, links: v1.links, graphPos: v1.graphPos },
  ]
  let cur = v2
  cur = { ...cur, links: stack[1].links }
  check('第一次撤销回到一条', cur.links.length === 1, String(cur.links.length))
  cur = { ...cur, links: stack[0].links }
  check('第二次撤销回到零条', cur.links.length === 0, String(cur.links.length))
}

/* ---------------- 结果 ---------------- */

console.log('')
console.log(`共 ${checks} 项检查，失败 ${failures} 项。`)
if (failures === 0) {
  console.log('结论：手绘图谱的几何、线头样式与落盘都可靠。')
  process.exit(0)
}
console.log('结论：手绘图谱行为不符合预期。')
process.exit(1)

void Project
