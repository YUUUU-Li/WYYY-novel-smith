/* ============================================================
   生成《吾又一言 v0.1.4 · 下载与安装说明》的 .docx

   为什么手写 OOXML 而不用 Word COM：
   这台机器上 Documents.Add() 会卡在「Word 未能引发事件」（加载项/许可状态），
   而 .docx 本来就是一个 zip + 一撮 XML，自己写反而稳：不依赖 Office、
   可以重复生成、内容全在版本库里。

   产物：.release/classmate-doc/（XML 片段）→ 由 PowerShell 打包成 .docx
   跑法：node scripts/make-classmate-doc.mjs
   ============================================================ */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '.release', 'classmate-doc')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, '_rels'), { recursive: true })
mkdirSync(join(outDir, 'word'), { recursive: true })
mkdirSync(join(outDir, 'word', '_rels'), { recursive: true })
mkdirSync(join(outDir, 'docProps'), { recursive: true })

/* ---------------- 小工具 ---------------- */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 把 **加粗** 拆成 run；其余按普通文字 */
function runs(text, extraRPr = '') {
  const out = []
  const parts = String(text).split(/(\*\*[^*]+\*\*)/)
  for (const part of parts) {
    if (!part) continue
    const bold = part.startsWith('**') && part.endsWith('**')
    const body = esc(bold ? part.slice(2, -2) : part)
    const rPr = [extraRPr, bold ? '<w:b/>' : ''].filter(Boolean).join('')
    out.push(
      `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${body}</w:t></w:r>`,
    )
  }
  return out.join('')
}

/* OOXML 的 pPr 子元素有顺序要求（spacing 必须在 ind 之前），顺序错了 Word 会报"文件已损坏" */
const p = (text, { style, ind = 0, spaceAfter = 120, extraRPr = '' } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : '<w:pStyle w:val="Normal"/>'}` +
  `<w:spacing w:after="${spaceAfter}" w:line="360" w:lineRule="auto"/>` +
  `${ind ? `<w:ind w:left="${ind}" w:hanging="220"/>` : ''}</w:pPr>${runs(text, extraRPr)}</w:p>`

const bullet = (text) => p(`• ${text}`, { style: 'Normal', ind: 300, spaceAfter: 60 })

const code = (text) => {
  const lines = String(text).replace(/\t/g, '  ').split('\n')
  return lines
    .map(
      (line, i) =>
        `<w:p><w:pPr><w:pStyle w:val="Code"/>` +
        `${i === 0 ? '<w:spacing w:before="120"/>' : ''}` +
        `${i === lines.length - 1 ? '<w:spacing w:after="180"/>' : ''}</w:pPr>` +
        `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr>` +
        `<w:t xml:space="preserve">${esc(line) || ' '}</w:t></w:r></w:p>`,
    )
    .join('')
}

/** 表格：第一行当表头（加粗 + 灰底） */
function table(rows, widths) {
  const total = 9360
  const w = widths ?? rows[0].map(() => Math.floor(total / rows[0].length))
  const border = (n) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="D0D0D0"/>`
  const head = rows
    .map((row, ri) => {
      const cells = row
        .map(
          (cell, ci) =>
            `<w:tc><w:tcPr><w:tcW w:w="${w[ci]}" w:type="dxa"/>` +
            `${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}` +
            `</w:tcPr><w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="40" w:line="288" w:lineRule="auto"/></w:pPr>` +
            `${runs(ri === 0 ? `**${cell}**` : cell)}</w:p></w:tc>`,
        )
        .join('')
      return `<w:tr>${cells}</w:tr>`
    })
    .join('')
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border('top')}${border('left')}` +
    `${border('bottom')}${border('right')}${border('insideH')}${border('insideV')}</w:tblBorders>` +
    `<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>` +
    `<w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `${head}</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`
  )
}

/* ============================================================
   正文
   ============================================================ */

const B = []
const h1 = (t) => B.push(p(`**${t}**`, { style: 'Heading1' }))
const h2 = (t) => B.push(p(`**${t}**`, { style: 'Heading2' }))
const h3 = (t) => B.push(p(`**${t}**`, { style: 'Heading3' }))
const t = (text) => B.push(p(text))

h1('吾又一言 v0.1.4 · 下载与安装说明')
t(
  '**吾又一言是一个写长篇小说的"设定工作台"。**人物、地点、事件、势力、物品、概念，加上关系网、时间线、地图、大纲，全放在一处。纯离线使用：不用注册、不用登录、不联网。',
)
t(
  '你写下的东西不是存在某个黑盒子里，而是一堆**能直接用记事本打开、能随手拷走的纯文本文件**。这一点在下面第 4 节还会再说一次，因为它决定了你怎么备份。',
)

h1('1. 下载')
t('打开这个页面（浏览器里输入或点链接）：')
B.push(code('https://github.com/YUUUU-Li/WYYY-novel-smith/releases'))
t('找到最新的那个版本 **吾又一言 v0.1.4**，展开下面的 Assets（附件），里面有四个文件，**你只需要第一个**：')
B.push(
  table(
    [
      ['文件名', '是什么', '要不要下'],
      ['WYYY-v0.1.4-installer-x64.exe', '安装程序，只有 2.5 MB。下它就够了', '**下这个**'],
      [
        'WYYY-v0.1.4-portable-desktop-x64.zip',
        '免安装版：解压后直接双击里面的「吾又一言.exe」，不用安装',
        '可选（想放 U 盘带走才需要）',
      ],
      [
        'WYYY-v0.1.4-web-launcher-x64.zip',
        '网页版，**不是 exe**。解压后双击「启动.vbs」，靠 Edge 开一个窗口',
        '不用下',
      ],
      ['发布说明.md / Source code', '文字说明和源码，不装软件', '不用下'],
    ],
    [3400, 3800, 2160],
  ),
)
t(
  '**附件名是英文的，不是我写错了。** GitHub 会把中文文件名里的汉字替换成短横线，以前出现过 `-v0.1.1-.zip` 这种完全看不懂的名字，所以统一用英文名。',
)

h1('2. 安装')
h3('系统要求')
bullet('Windows 10 或 Windows 11，64 位')
bullet('需要系统里有 WebView2 运行时：Win11 自带；Win10 一般随 Edge 已经装好了')
h3('步骤')
bullet('双击下载好的 **WYYY-v0.1.4-installer-x64.exe**')
bullet(
  '如果 Windows 弹出蓝色窗口提示"Windows 已保护你的电脑 / 未知发布者"：点 **更多信息** → **仍要运行**。这个包没有购买代码签名证书，出现这个提示是正常的，不是中毒。',
)
bullet('安装向导里点「安装」，等几秒完成')
bullet('开始菜单里会出现 **吾又一言**，桌面上也会有图标（安装时那个复选框默认是勾上的）')
bullet('点图标打开')

h1('3. 第一次打开')
t('第一次打开，你看到的是一个**空的作品库**，上面写着「新建小说」。往下还有一行「已经有作品了？」。')
h3('两种情况')
bullet(
  '**新写一本**：在上面输入书名，回车。接着会弹一个选文件夹的窗口 —— 选一个你放稿子的地方（比如 D 盘新建一个「小说」文件夹里再选一层）。',
)
bullet(
  '**手里已经有作品文件夹了**（别人给你的、或者从旧电脑拷来的，里面有 novel.json）：点「打开作品文件夹」，指到那个文件夹就行，不用重新导入。',
)
t(
  '**为什么要让你选文件夹？** 因为程序不把稿子藏在内部，而是直接写到你选的那个文件夹里。选完之后，那个文件夹就是这本书。',
)

h1('4. 它把你的稿子存成什么')
t('一个文件夹就是一部作品，里面全是纯文本：')
B.push(
  code(`战国记\\
  novel.json      作品信息（书名、关系类型、字段模板、历法……）
  大纲.json
  词条.json
  角色\\林昭.md    每个条目一个 Markdown 文件
  地点\\...
  事件\\...
  历史\\           每次保存留一份快照，只保留最近 60 份`),
)
bullet('**备份 = 把这个文件夹整个拷走。** 拷到 U 盘、网盘、另一台电脑都行。')
bullet('换电脑：把那文件夹拷过去，在新电脑上「打开作品文件夹」指一下就能接着写。')
bullet('想看自己写了什么、想搜关键词：直接用记事本或任何编辑器打开那些 .md 文件都行。')
bullet('程序没有隐藏数据库，删掉程序也不会删掉你的稿子（稿子不在程序目录里）。')

h1('5. 常见问题')
h3('Q1：提示"未知发布者"，是不是有问题？')
t('不是。这个项目没有花钱买代码签名证书，Windows 对没有签名的程序都会这么提示。点「更多信息 → 仍要运行」即可。')
h3('Q2：双击没反应，或者窗口一闪就没了？')
t(
  '极少数情况下，上一次没退出干净的界面进程会把缓存目录占住。按顺序试：① 重启电脑（最省事）；② 任务管理器里把所有 **msedgewebview2.exe** 结束掉再打开；③ 打开后如果报错，它会弹一个消息框说明原因，记录写在 `%LOCALAPPDATA%\\com.novelstudio.desktop\\crash.log`。',
)
h3('Q3：点窗口右上角的 × 关不掉？')
t(
  '正常情况下是秒关的。万一真遇到：任务管理器 → 找到「吾又一言」→ 结束任务。**不会丢稿子**，因为改动最多 250 毫秒就会写一次盘，窗口失去焦点时也会立刻存。',
)
h3('Q4：词条拖不进关系网 / 时间线？')
t('先确认版本号是 **v0.1.4**。早期桌面版有个缺陷，从左边列表把词条拖进画布会没反应，v0.1.4 已修好。')
h3('Q5：网页版和桌面版可以混着用吗？')
t(
  '可以，但**不要同时开**。两个版本都能打开同一个作品文件夹，数据格式完全一样；只是别一边开着桌面版、一边又用网页版改同一个文件夹，那样会互相覆盖。',
)
h3('Q6：能装在 U 盘里带走吗？')
t('能。下那个 portable 的 zip，解压到 U 盘，双击里面的「吾又一言.exe」就跑，不写注册表、不留快捷方式。')
h3('Q7：以后出新版怎么升？')
t('直接下新的安装包，覆盖安装就行。你的作品文件夹和作品库列表都不会动。')

h1('6. 卸载')
t(
  'Windows 设置 → 应用 → 已安装的应用 → 找到 **吾又一言** → 卸载。卸载只删程序，**你的作品文件夹还在原地**，里面的稿子一个字节都不会少。',
)

h1('7. 想核对下载有没有坏（可选）')
t('在下载文件夹里按住 Shift 右键 → 「在此处打开 PowerShell」，然后：')
B.push(code('Get-FileHash .\\WYYY-v0.1.4-installer-x64.exe -Algorithm SHA256'))
t('应该输出这一串：')
B.push(code('D026CE264F51B2F08C019322D839353A6F4B928AA261F3CC708A8E0134455D19'))
t('对得上就说明文件完整、没被篡改。对不上就重新下一次。')

t('')
t('最后一句话：这是个纯本地的小工具，最坏的情况也就是程序起不来 —— 你的稿子始终是磁盘上那几个能直接打开的文件。')
t('—— 有问题直接找我。')

/* ============================================================
   组装 OOXML
   ============================================================ */

const body = B.join('\n')
const sectPr = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1360" w:right="1360" w:bottom="1250" w:left="1470" w:header="720" w:footer="720" w:gutter="0"/><w:docGrid w:linePitch="312"/></w:sectPr>`

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body}
${sectPr}
</w:body>
</w:document>`

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
  <w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑" w:cs="Microsoft YaHei"/>
  <w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="1F1B16"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="9C3F30"/><w:sz w:val="27"/><w:szCs w:val="27"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F5F1"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="240"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>
</w:styles>`

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>吾又一言 v0.1.4 · 下载与安装说明</dc:title>
<dc:subject>给同学的下载、安装与使用说明</dc:subject>
<dc:creator>吾又一言</dc:creator>
<cp:keywords>吾又一言;v0.1.4;下载;安装;说明书</cp:keywords>
</cp:coreProperties>`

writeFileSync(join(outDir, '[Content_Types].xml'), contentTypes, 'utf8')
writeFileSync(join(outDir, '_rels', '.rels'), rootRels, 'utf8')
writeFileSync(join(outDir, 'word', 'document.xml'), documentXml, 'utf8')
writeFileSync(join(outDir, 'word', 'styles.xml'), stylesXml, 'utf8')
writeFileSync(join(outDir, 'word', '_rels', '.rels'), docRels, 'utf8')
writeFileSync(join(outDir, 'docProps', 'core.xml'), coreXml, 'utf8')

console.log(`OOXML 片段已写出：${outDir}`)
console.log(`段落数：${(body.match(/<w:p>/g) ?? []).length}，表格数：${(body.match(/<w:tbl>/g) ?? []).length}`)
