/* ============================================================
   发行前自查：别把自己的东西发出去

   这个仓库是**程序**，不是作品。程序可以公开，你写的小说不行。
   这个脚本只做一件事：把工作区里所有文本文件过一遍，找出
   「一看就是我本机的东西」和「一看就是凭据」的痕迹，然后告诉你
   在第几行。

   跑法：
     npm run check:publish
     npm run check:publish -- 战国记 云京 北境行省

     后面跟的词会额外扫描一遍 —— 把你自己小说里的专有名词写上去，
     它们出现在代码/文档/测试数据里就该被拦下来。

   它拦不住的东西（这些只能靠你自己看一眼）：
   · 图片里的字（截图、底图）
   · git 历史里已经提交过的东西（提交过就等于公开过，得改写历史）
   ============================================================ */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

/** 不扫的目录：依赖、构建产物、缓存、VCS */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'target',
  '.git',
  '.npm-cache',
  '.shots',
  'gen',
])

/** 不扫的后缀：二进制和压缩包，扫了也读不出字 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.icns',
  '.woff', '.woff2', '.ttf', '.otf',
  '.zip', '.gz', '.7z', '.exe', '.dll', '.node', '.wasm',
  '.pdf', '.mp3', '.mp4',
])

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt',
  '.html', '.css', '.toml', '.rs', '.cmd', '.bat', '.ps1', '.sh',
  '.yml', '.yaml', '.svg', '.gitignore', '.gitattributes',
])

/** 一看就是我本机 / 我的账号 */
const RULES = [
  { id: '本机用户路径', re: /[A-Za-z]:\\+Users\\+[^\\\s"']+/g },
  { id: 'macOS 家目录', re: /\/Users\/[A-Za-z0-9._-]+\//g },
  { id: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g },
  { id: '疑似 GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: '疑似 API key', re: /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { id: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
]

const extra = process.argv.slice(2).filter(Boolean)
const extraRules = extra.map((w) => ({
  id: `你的词：${w}`,
  // 纯字面匹配，别把作者的词当正则（里面可能有括号、方括号）
  re: new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
}))

const allRules = [...RULES, ...extraRules]

/** 白名单：这些是合法的、公开的地址，不该被当成隐私 */
const ALLOW = [
  /127\.0\.0\.1/,
  /localhost/,
  /example\.(com|org|net)/,
  /C:\\+Program Files/i,
  /C:\\+Windows/i,
  /noreply@/,
  // 图标文件名（128x128@2x.png）长得像邮箱，别误报
  /@\d+x\./,
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      walk(full, out)
      continue
    }
    // 测试打包产物（npm test 生成、已被 .gitignore 排除），不扫
    if (/^\..*-bundle\.mjs$/.test(name)) continue
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
    if (SKIP_EXT.has(ext)) continue
    // 没有后缀的文本文件（启动.cmd 之类）也扫一遍
    if (ext && !TEXT_EXT.has(ext) && name !== '.gitignore') continue
    if (st.size > 4 * 1024 * 1024) continue
    out.push(full)
  }
  return out
}

const findings = []
let scanned = 0

for (const file of walk(ROOT)) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue // 二进制
  scanned++

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 2000) continue
    for (const rule of allRules) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(line)) !== null) {
        const hit = m[0]
        if (ALLOW.some((a) => a.test(hit))) continue
        findings.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line: i + 1,
          rule: rule.id,
          hit,
        })
      }
    }
  }
}

const label = extra.length > 0 ? `（含 ${extra.length} 个自定义词）` : ''
console.log('')
console.log(`扫了 ${scanned} 个文本文件${label}`)

if (findings.length === 0) {
  console.log('结论：没找到本机路径、邮箱、凭据，也没找到你点名的那几个词。')
  console.log('      可以提交了 —— 但图片里的字它看不见，截图自己再瞄一眼。')
  process.exit(0)
}

const byFile = new Map()
for (const f of findings) {
  const list = byFile.get(f.file) ?? []
  list.push(f)
  byFile.set(f.file, list)
}

console.log(`\n找到 ${findings.length} 处，分在 ${byFile.size} 个文件里：\n`)
for (const [file, list] of byFile) {
  console.log(`  ${file}`)
  for (const f of list.slice(0, 8)) {
    console.log(`    ${String(f.line).padStart(4)}  [${f.rule}] ${f.hit}`)
  }
  if (list.length > 8) console.log(`    …… 还有 ${list.length - 8} 处`)
}

console.log('')
console.log('结论：这些东西别提交。改掉，或者把它们挪到 .gitignore 覆盖的位置。')
process.exit(1)
