/* ============================================================
   生成《吾又一言 · A 档桌面化改造计划》的 .docx

   为什么不走 Word COM：这台机器上 Documents.Add() 直接抛
   「Word 未能引发事件」（Word 16 在这台机器上被某些加载项/许可状态挡住）。
   而 .docx 本来就是一个 zip + 一组 OOXML，自己写反而稳：
   不依赖 Office、可重复生成、CI 里也能跑。

   输出两个：scripts/../.release/plan-doc/（XML 片段）→ 再由
   make-plan-doc.cmd 用 ZipFile 打包成 .docx。
   也可以直接 npm run doc:plan。
   ============================================================ */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '.release', 'plan-doc')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, '_rels'), { recursive: true })
mkdirSync(join(outDir, 'word'), { recursive: true })
mkdirSync(join(outDir, 'word', '_rels'), { recursive: true })
mkdirSync(join(outDir, 'docProps'), { recursive: true })

/* ---------------- 小工具 ---------------- */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** 把 **加粗** 拆成 run；其余按普通文字 */
function runs(text, extraRPr = '') {
  const out = []
  const parts = String(text).split(/(\*\*[^*]+\*\*)/)
  for (const p of parts) {
    if (!p) continue
    const bold = p.startsWith('**') && p.endsWith('**')
    const body = esc(bold ? p.slice(2, -2) : p)
    const rPr = [extraRPr, bold ? '<w:b/>' : ''].filter(Boolean).join('')
    out.push(
      `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${body}</w:t></w:r>`,
    )
  }
  return out.join('')
}

/* 注意 OOXML 里 pPr 的子元素是**有顺序**的（spacing 必须在 ind 前面），
   顺序错了 Word 可能直接说"文件已损坏"。 */
const p = (text, { style, ind = 0, spaceAfter = 120, extraRPr = '' } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : '<w:pStyle w:val="Normal"/>'}${
    `<w:spacing w:after="${spaceAfter}" w:line="360" w:lineRule="auto"/>`
  }${ind ? `<w:ind w:left="${ind}" w:hanging="220"/>` : ''}</w:pPr>${runs(text, extraRPr)}</w:p>`

const bullet = (text) => p(`• ${text}`, { style: 'Normal', ind: 300, spaceAfter: 60 })

const code = (text) => {
  const lines = String(text).replace(/\t/g, '  ').split('\n')
  return lines
    .map(
      (line, i) =>
        `<w:p><w:pPr><w:pStyle w:val="Code"/>${
          i === 0 ? '<w:spacing w:before="120"/>' : ''
        }${i === lines.length - 1 ? '<w:spacing w:after="180"/>' : ''}</w:pPr>` +
        `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr>` +
        `<w:t xml:space="preserve">${esc(line) || ' '}</w:t></w:r></w:p>`,
    )
    .join('')
}

/** 表格：第一行当表头（加粗 + 灰底） */
function table(rows, widths) {
  const total = 9360 // A4 去页边距后的可用宽度（twips）
  const w = widths ?? rows[0].map(() => Math.floor(total / rows[0].length))
  const border = (n) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="D0D0D0"/>`
  const head = rows
    .map((row, ri) => {
      const cells = row
        .map(
          (cell, ci) =>
            `<w:tc><w:tcPr><w:tcW w:w="${w[ci]}" w:type="dxa"/>${
              ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''
            }</w:tcPr><w:p><w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="40" w:line="288" w:lineRule="auto"/></w:pPr>${runs(
              ri === 0 ? `**${cell}**` : cell,
            )}</w:p></w:tc>`,
        )
        .join('')
      return `<w:tr>${cells}</w:tr>`
    })
    .join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border('top')}${border(
    'left',
  )}${border('bottom')}${border('right')}${border('insideH')}${border('insideV')}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>${head}</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`
}

/* ============================================================
   正文内容
   ============================================================ */

const B = []
const h1 = (t) => B.push(p(`**${t}**`, { style: 'Heading1' }))
const h2 = (t) => B.push(p(`**${t}**`, { style: 'Heading2' }))
const h3 = (t) => B.push(p(`**${t}**`, { style: 'Heading3' }))
const t = (text) => B.push(p(text))

h1('0. 一句话结论')
t(
  '**A 档一共六件事，预计 2–4 个工作日。**不需要服务器、不需要账号、不联网。做完之后：双击图标直接出窗口，不弹黑框、不挂在浏览器里；重复双击只会把已有窗口提到前面；关掉重开会回到上次的窗口位置；托盘里能右键打开/退出；可以设开机自启；「关于」里能看到版本号和数据位置。',
)
t(
  '**A 档真正的门槛不在代码，而在两件事上：**一是 Windows 代码签名证书（不买就会被 SmartScreen 拦一句"未知发布者"），二是打磨细节的耐心。',
)

h1('1. 什么算做完（验收标准）')
t('这一节就是验收清单。下面每一项都能用眼睛验证，不需要看代码。')
B.push(
  table(
    [
      ['用户动作', '期望结果', '现状'],
      ['双击桌面图标', '直接出现程序窗口：无控制台黑框、无浏览器地址栏、无标签页', '已做到'],
      ['已经开着一个窗口时再双击', '不出现第二个实例，已有窗口被提到最前面', '缺'],
      ['点窗口右上角 ×', '按选定策略：A1 直接退出 / A2 缩到托盘常驻（二选一，不能含糊）', '缺'],
      ['右键托盘图标', '菜单里有「打开主窗口」「退出」两项，且都能用', '缺'],
      ['勾选「开机自启」后重启电脑', '登录后窗口自己起来，不需要点任何东西', '缺'],
      ['挪动窗口、调整大小后退出，再打开', '回到上次的位置和大小（跨显示器也要正常）', '缺'],
      ['打开「关于」', '显示版本号、数据目录（可一键打开）、许可说明', '缺'],
      ['装完卸载', '能干净卸掉：程序文件清掉，小说数据不删（数据不在安装目录）', '基本具备'],
    ],
    [2200, 5100, 2060],
  ),
)

h1('2. 现状盘点')
t('先说已经有、不用重做的，避免重复劳动。')
h3('已完成')
bullet('Tauri 2 桌面壳：src-tauri/ 已写好，Rust 侧 17 项测试全过')
bullet('NSIS 安装包：npx tauri build 产出「吾又一言_0.1.0_x64-setup.exe」（约 2.5 MB）')
bullet('真窗口：不依赖浏览器，窗口标题、尺寸、最小尺寸已配好')
bullet('文件存储：桌面版与浏览器版共用同一个小说文件夹格式')
bullet('崩溃可见：panic 会写 crash.log 并弹消息框（不再是无声的 0xC0000409）')
h3('还缺（就是 A 档要补的）')
bullet('单实例、关窗策略、托盘图标、窗口位置记忆、开机自启、「关于」')

h1('3. 六项任务：做什么、怎么做、怎么验收')

h2('3.1 单实例：第二次双击不再开新窗口')
t(
  '**为什么：**「双击了两次」是用户最常见的行为。没有单实例时，第二个进程会和第一个抢同一个 WebView2 数据目录，直接报 0x800700AA —— 之前那个"一启动就崩"的极端版就是它。',
)
t('**怎么做：**')
bullet('Rust 依赖加 tauri-plugin-single-instance = "2"')
bullet('在 Builder 上最先注册 tauri_plugin_single_instance::init(...)，它必须排在其它插件前面')
bullet('回调里做三件事：找到主窗口 → unminimize → set_focus（Windows 上 set_focus 前一般要先 show）')
bullet('开发模式（npm run tauri dev）也生效；调试多开时记得临时注释掉')
t('**验收：**连点两次图标，任务管理器里只有一组进程；第二次点击后已有窗口跳到最前。')
B.push(
  code(`// src-tauri/src/lib.rs（示意）
tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }))
    .plugin(tauri_plugin_dialog::init())`),
)

h2('3.2 托盘图标：常驻一个图标，右键能关')
t(
  '**为什么：**常驻类软件（输入法、笔记、下载器）都在托盘留一个入口。它同时解决"关掉窗口以后怎么再打开"和"怎么退出"两个问题。',
)
t('**怎么做：**')
bullet('Cargo.toml 打开 tauri 的 tray-icon feature：tauri = { version = "2", features = ["tray-icon"] }')
bullet('用 TrayIconBuilder 建图标，菜单用 MenuItem / MenuBuilder 加「打开主窗口」「退出」')
bullet('图标资源别用相对路径：打包后源文件不在。用 app.default_window_icon()，或 include_bytes! 编进二进制')
bullet('on_menu_event 里区分 id：打开 → show + set_focus；退出 → app.exit(0)')
bullet('Windows 托盘图标建议 16×16 / 32×32；高分屏要提供大尺寸，否则会糊')
t('**验收：**托盘出现图标；右键两个菜单项都能用；图标不显示成白块。')
B.push(
  code(`// src-tauri/src/lib.rs（示意）
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;

let open = MenuItemBuilder::with_id("open", "打开主窗口").build(app)?;
let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;

TrayIconBuilder::with_id("main")
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, ev| match ev.id().as_ref() {
        "open" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;`),
)

h2('3.3 关窗行为：先定一件事，再写代码')
t('**这是个产品决策，不是技术问题。**两种方案，选一个，别含糊。')
B.push(
  table(
    [
      ['方案', '用户点 × 之后', '优点', '代价'],
      ['A1 直接退出', '程序完全退出，托盘图标也消失', '行为简单；不会被误以为"没关掉"；不占内存', '下次打开要重新点图标'],
      ['A2 缩到托盘', '窗口隐藏，进程继续跑，托盘图标还在', '再打开是瞬间的；写作类工具常这样', '用户可能以为已经关了；必须给显眼的「退出」；要和开机自启一起想清楚'],
    ],
    [1500, 2600, 2600, 2660],
  ),
)
t(
  '**建议：**写作工具选 A2（缩到托盘），但必须满足三条 —— 托盘菜单有明确的「退出」、第一次关窗时提示一句"已缩到托盘，右键可退出"、设置里可以改回"关窗即退出"。',
)
B.push(
  code(`// 关窗 = 缩到托盘（示意）
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
            api.prevent_close();
            let _ = window.hide();
        }
    }
})`),
)

h2('3.4 窗口位置与大小记忆')
t('**为什么：**写作工具通常是"固定姿势"打开的，位置每次重拖一遍会烦。')
t('**怎么做：**')
bullet('加 tauri-plugin-window-state = "2"，注册 .plugin(tauri_plugin_window_state::Builder::default().build())')
bullet('插件按窗口 label 自动记住位置 / 大小 / 最大化状态，几乎不用写代码')
bullet('拔掉外接显示器后窗口可能在屏幕外：插件有可见性判断，但仍要手动验证一次（最常见的翻车点）')
bullet('不要同时在自己代码里 set_size / set_position，会和插件打架')
t('**验收：**挪窗口 → 退出 → 重开，位置一致；换成只有一个屏幕的状态再开一次，窗口出现在可见范围内。')

h2('3.5 开机自启')
t('**为什么：**一次配好，之后永远不用找图标。属于成熟桌面软件的默认能力。')
t('**怎么做：**')
bullet('Rust 依赖 tauri-plugin-autostart = "2"；注册时传 MacosLauncher::LaunchAgent（Windows 用不到，但 API 要这个参数）')
bullet('前端开关用 @tauri-apps/plugin-autostart 的 enable() / disable() / isEnabled()')
bullet('要放权限：capabilities 里加 autostart:allow-enable、autostart:allow-disable、autostart:allow-is-enabled')
bullet('别自己写注册表 Run 键：卸载时容易留垃圾；插件会跟着安装包一起清')
t('**验收：**勾上 → 重启电脑 → 窗口自己出现；取消 → 重启不再出现。')
t(
  '**注意：**如果同时选了"关窗 = 缩到托盘"，开机自启就会常驻内存。要么两者不并存，要么在设置里给一句说明。',
)

h2('3.6 「关于」+ 版本信息')
t('**为什么：**出问题时用户第一句要说的就是"我这是哪个版本"。这也是唯一的署名位置。')
t('**怎么做：**')
bullet('加一个 Rust 命令 app_meta，返回 { version: env!("CARGO_PKG_VERSION"), dataDir, tauri: tauri::VERSION }')
bullet('前端在侧栏底部或托盘菜单里放「关于」，用已有的 dialog 插件弹信息框即可，不必做新页面')
bullet('顺手把"打开数据目录"做成按钮：出问题时让用户一键找到自己的文件，这是这个工具最大的卖点')
t('**验收：**显示 v0.1.0 + 数据目录，点"打开目录"能在资源管理器里看到小说文件夹。')

h2('3.7 收尾打磨（决定"像不像软件"的地方）')
bullet('启动白屏：窗口配置 visible: false，前端 ready 后再 show，避免先看到一片白')
bullet('任务栏分组：Windows 上设置 AppUserModelID（安装包里带），否则可能和别的应用归到一组')
bullet('单实例与"窗口已隐藏"的配合：第二次双击时窗口是隐藏的要 show 出来，不能只 set_focus')
bullet('托盘 tooltip：写「吾又一言」，不要空白')
bullet('安装包 Publisher 名称：不填会显示"未知发布者"，更明显的还是 SmartScreen（见第 6 节）')

h1('4. 需要改的文件清单')
B.push(
  table(
    [
      ['文件', '改什么'],
      ['src-tauri/Cargo.toml', '加 4 个依赖：single-instance、window-state、autostart；给 tauri 打开 tray-icon feature'],
      ['src-tauri/src/lib.rs', '注册 4 个插件；建托盘与菜单；拦 CloseRequested；加 app_meta 命令'],
      ['src-tauri/tauri.conf.json', '窗口 visible:false、title、最小尺寸；安装包 productName / publisher'],
      ['src-tauri/capabilities/default.json', '补 autostart 与 window-state 的权限条目'],
      ['src/ 前端（侧栏底部或设置区）', '开机自启开关、「关于」入口、首次关窗提示'],
      ['package.json', '如果前端用 JS 插件，加 @tauri-apps/plugin-autostart 等依赖'],
    ],
    [3000, 6360],
  ),
)

h1('5. 建议的实施顺序与工时')
t('顺序有讲究：先解决"不能多开"，再解决"关不掉"，最后才是锦上添花。')
B.push(
  table(
    [
      ['顺序', '任务', '工时', '风险'],
      ['1', '单实例', '半天', '开发模式下也生效，调试时容易迷惑'],
      ['2', '关窗策略（定 A1 / A2）', '半天', '产品决策要先定，否则后面全要改'],
      ['3', '托盘图标 + 菜单', '半天到一天', '图标资源路径；高分屏发糊'],
      ['4', '窗口位置记忆', '半天', '多显示器拔插'],
      ['5', '开机自启', '半天', '和"缩到托盘"的语义冲突'],
      ['6', '关于 + 启动白屏 + 收尾', '半天到一天', '没有技术风险，纯打磨'],
    ],
    [900, 2900, 1600, 3960],
  ),
)
t(
  '**合计 2–4 个工作日**（含每项的真机验证与一次完整打包）。如果只做前三项（单实例 + 关窗策略 + 托盘），一天半就能明显感到"这就是个软件"。',
)

h1('6. 坑与注意事项')
h3('6.1 SmartScreen：不签名就会被拦')
bullet('任何人下载你的 setup.exe，Windows 都会弹"Windows 已保护你的电脑 / 未知发布者"')
bullet('解决办法只有买代码签名证书（一年几百到上千元），或用 Azure Trusted Signing（便宜些，但要资质审核）')
bullet('不买也能发：用户点"更多信息 → 仍要运行"。对公开小工具来说可以接受，但要提前知道')
h3('6.2 自启的路径问题')
bullet('自启记录的是当前 exe 的绝对路径；以后换了安装位置，自启会指向一个不存在的文件')
bullet('所以自启只应该由安装后的程序来设置，别在开发目录里勾')
h3('6.3 单实例与多会话')
bullet('插件按"同一用户会话"判断。远程桌面 / 切换用户时各开一份是正常的，不算 bug')
h3('6.4 托盘与打包')
bullet('托盘图标必须能从二进制里拿到（default_window_icon 或 include_bytes!），不能读源文件')
bullet('打包后再测一遍：开发时能显示的图标，打包后经常丢')
h3('6.5 别把 A 档做成"关不掉的常驻"')
bullet('"关窗缩托盘"必须配一个显眼的「退出」，否则用户会觉得中了病毒')
h3('6.6 升级时数据别丢')
bullet('安装包用 NSIS currentUser 模式（已配置），数据在用户目录 / 小说库文件夹里，升级只替换程序文件')
bullet('升级前先备份一次小说库文件夹，这是唯一的保险')

h1('7. 明确不做的（把边界写下来）')
bullet('不做自动更新 —— 那是 B 档，需要 tauri-plugin-updater + GitHub Releases 的签名配置')
bullet('不做云同步、账号、多端 —— 那是 C 档，需要一个后端服务，成本是数量级差别')
bullet('不做自定义标题栏 —— 用系统原生标题栏才"像软件"，自绘反而廉价')
bullet('不做插件系统 —— 这个工具的复杂度已经够了')

h1('8. 附：怎么验证（照着做）')
h3('打包并安装')
B.push(
  code(`cd novel-studio
npm run build
npx tauri build
# 产物：src-tauri\\target\\release\\bundle\\nsis\\吾又一言_0.1.0_x64-setup.exe`),
)
h3('单实例')
bullet('双击图标 → 出现窗口；再双击一次 → 不出现第二个窗口，第一个跳到最前')
bullet('任务管理器 → 详细信息 → 搜 novel-studio.exe，应该只有 1 个')
h3('托盘')
bullet('托盘里有「吾又一言」图标，不是白块')
bullet('右键 →「打开主窗口」→ 窗口出现；右键 →「退出」→ 进程消失')
h3('关窗策略')
bullet('点 × → 若是 A2：窗口消失、托盘图标还在、任务管理器里进程还在')
bullet('再双击图标 → 窗口回来（不是新开一个）')
h3('窗口记忆')
bullet('把窗口拖到右下角、拉大 → 退出 → 重开 → 位置和大小一致')
h3('开机自启')
bullet('设置里勾上 → 注销或重启 → 登录后窗口自己出现；取消勾选 → 重启不再出现')

h1('9. 如果你不想自己动手')
t(
  '六个任务的代码量都不大，难点全在"打包之后才暴露"的那几个坑：图标路径、多显示器、单实例与隐藏窗口的配合、SmartScreen。所以更省时间的做法是：把这份文档当成验收清单，让实现的人按第 8 节逐条演示给你看 —— 只要每一条都能当场演示，A 档就算做完了。',
)

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
<dc:title>吾又一言 · A 档桌面化改造计划</dc:title>
<dc:subject>把吾又一言做成"看起来、用起来就是普通软件"的桌面程序</dc:subject>
<dc:creator>吾又一言</dc:creator>
<cp:keywords>A档;Tauri;桌面化;单实例;托盘;开机自启</cp:keywords>
</cp:coreProperties>`

writeFileSync(join(outDir, '[Content_Types].xml'), contentTypes, 'utf8')
writeFileSync(join(outDir, '_rels', '.rels'), rootRels, 'utf8')
writeFileSync(join(outDir, 'word', 'document.xml'), documentXml, 'utf8')
writeFileSync(join(outDir, 'word', 'styles.xml'), stylesXml, 'utf8')
writeFileSync(join(outDir, 'word', '_rels', '.rels'), docRels, 'utf8')
writeFileSync(join(outDir, 'docProps', 'core.xml'), coreXml, 'utf8')

// 目录名：生成一个文件，交给下一步打包
const plain = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 80)
console.log(`OOXML 片段已写出：${outDir}`)
console.log(`段落数：${(body.match(/<w:p>/g) ?? []).length}，表格数：${(body.match(/<w:tbl>/g) ?? []).length}`)
console.log(`开头：${plain}`)
