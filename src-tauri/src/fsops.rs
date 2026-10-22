//! 吾又一言 的磁盘操作
//!
//! 这个模块刻意**不依赖 Tauri**，这样可以用 `cargo test` 直接验证，
//! 不需要启动窗口也不需要图形环境。所有与磁盘格式有关的规则都放这里，
//! 命令层（commands.rs）只做参数转换。
//!
//! 关键约束：这里的规则必须和浏览器版（`src/lib/`）完全一致，
//! 否则同一个小说文件夹会被两种实现用不同格式读写，数据看起来时有时无。
//! 对应的期望值在 `src/lib` 里由 `scripts/disk-format-test.ts` 钉死，
//! 本模块的 `tests.rs` 是它的镜像。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/* ============================================================
   路径常量
   必须与 TypeScript 侧一致：novelfs.ts 的 ENTITY_DIR / HISTORY_DIR（一个文件夹就是一部作品）
   ============================================================ */

// 已经没有容器层了；留着这个常量只为了让旧文件仍然能编译（不再使用）
pub const META_FILE: &str = "novel.json";
pub const OUTLINE_FILE: &str = "大纲.json";
pub const TERMS_FILE: &str = "词条.json";
pub const HISTORY_DIR: &str = "历史";

/// 快照保留上限。超过就从最旧的开始删。
pub const HISTORY_LIMIT: usize = 60;

/// 实体类型 → 目录名
pub fn entity_dir(type_name: &str) -> Option<&'static str> {
    match type_name {
        "character" => Some("角色"),
        "location" => Some("地点"),
        "event" => Some("事件"),
        "faction" => Some("势力"),
        "item" => Some("物品"),
        "concept" => Some("概念"),
        _ => None,
    }
}

/// 全部实体目录名，用于遍历
pub fn all_entity_dirs() -> [&'static str; 6] {
    ["角色", "地点", "事件", "势力", "物品", "概念"]
}

/* ============================================================
   文件名转义
   ============================================================ */

/// Windows 非法字符的替换目标。
/// 用一个中西文都常见、且不在非法集合里的字符，而不是下划线 ——
/// 下划线在中文文件名里会显得像程序生成的。
const REPLACEMENT: char = '·';

/// 把任意名字转成安全的文件名。
///
/// 规则必须与 TypeScript 侧的 `safeFileName` 完全一致：
///   1. 把 \ / : * ? " < > | 替换成 ·
///   2. 连续空白折叠成一个空格
///   3. 去掉首尾空白
///   4. 截断到 60 个字符（按字符数，不是字节数）
///   5. 结果为空则用「未命名」
pub fn safe_file_name(name: &str) -> String {
    const ILLEGAL: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

    let mut replaced = String::with_capacity(name.len());
    for ch in name.chars() {
        if ILLEGAL.contains(&ch) {
            replaced.push(REPLACEMENT);
        } else {
            replaced.push(ch);
        }
    }

    // 折叠空白：连续空白只保留一个空格
    let mut collapsed = String::with_capacity(replaced.len());
    let mut last_was_space = false;
    for ch in replaced.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                collapsed.push(' ');
                last_was_space = true;
            }
        } else {
            collapsed.push(ch);
            last_was_space = false;
        }
    }

    let trimmed = collapsed.trim();
    let truncated: String = trimmed.chars().take(60).collect();
    if truncated.is_empty() {
        "未命名".to_string()
    } else {
        truncated
    }
}

/* ============================================================
   时间戳
   ============================================================ */

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SnapshotEnvelope {
    pub saved_at: String,
    pub project: String,
    pub entities: usize,
    pub novel: serde_json::Value,
}

/// 把当前时间转成快照文件名用的时间戳。
///
/// 格式必须与 TypeScript 侧一致：
///   new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
/// 例如 2026-09-29T14:22:42.123Z → 2026-09-29T14-22-42
///
/// 这个格式有个必要的性质：**按文件名排序就等于按时间排序**，
/// 所以清理旧快照时不需要解析时间，直接排序取前 N 个即可。
pub fn snapshot_stamp(now_iso: &str) -> String {
    now_iso
        .chars()
        .take(19)
        .map(|c| if c == ':' || c == '.' { '-' } else { c })
        .collect()
}

/* ============================================================
   路径拼装
   ============================================================ */

/// 取当前时间的 ISO 8601 UTC 字符串，例如 2026-09-29T14:22:42.123Z
///
/// 手写而不引入 chrono：这里只需要一个固定格式的 UTC 时间戳，
/// 为它拉一个日期库进来不划算。算法是标准的 civil-from-days。
pub fn now_iso_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d,
        Err(_) => return "1970-01-01T00:00:00.000Z".to_string(),
    };
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);

    let (y, m, d) = civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hh, mm, ss, millis
    )
}

/// 把「1970-01-01 起的天数」转成 (年, 月, 日)。
/// 用的是 Howard Hinnant 的 civil_from_days 算法（公共领域）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 一部作品的文件夹——就是用户选中的那一层本身。
///
/// 以前是 `root/小说/<书名>/`，于是作者看到"我的战国记在 战国记/小说/战国记
/// 里面"，既看不懂也没法整包拷走。现在：**一个文件夹就是一部作品**，
/// 拷走它 = 备份这部作品。`title` 保留在签名里只是为了不再改所有调用点。
pub fn novel_dir(root: &Path, _title: &str) -> PathBuf {
    root.to_path_buf()
}

/// 枚举某个小说目录下的全部实体文件名（只含 .md，跳过隐藏文件与临时文件）
pub fn list_entity_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // 跳过程序自己写的临时文件与系统杂项
        if name.starts_with('.') || name.ends_with(".tmp") {
            continue;
        }
        let is_md = name.to_lowercase().ends_with(".md");
        if path.is_file() && is_md {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// 这个文件夹里有哪些作品。
///
/// 「文件夹即作品」之后最多只有一部：`root` 自己。返回空字符串表示
/// "root 本身就是那部作品"，调用方按 `root.join("")` 直接落在这一层。
pub fn list_novel_folders(root: &Path) -> Vec<String> {
    if root.join(META_FILE).is_file() {
        vec![String::new()]
    } else {
        Vec::new()
    }
}

/// 读取 novel.json 里的 id 与 title，用于列表与按 id 定位
pub fn read_meta(dir: &Path) -> Option<(String, String, String, usize)> {
    let text = std::fs::read_to_string(dir.join(META_FILE)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = v.get("id")?.as_str()?.to_string();
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("未命名")
        .to_string();
    let logline = v
        .get("logline")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let updated = v
        .get("updatedAt")
        .and_then(|t| t.as_u64())
        .unwrap_or(0) as usize;
    Some((id, title, logline, updated))
}

/// 清掉不属于当前实体集合的文件。
///
/// 为什么要传「应当保留的文件名集合」而不是自己判断：
/// 文件名由实体名决定，改名和改类型都会留下孤儿文件。
/// 让调用方把应该存在文件名算好，这里只负责删多余的 ——
/// 规则集中在一处，两边实现才不容易分叉。
pub fn prune_entity_files(dir: &Path, keep: &[String]) -> usize {
    let mut removed = 0;
    for path in list_entity_files(dir) {
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !keep.contains(&name) {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// 把历史目录裁到上限，删掉最旧的。
/// 依赖「文件名排序即时间排序」这个性质。
pub fn trim_history(dir: &Path, limit: usize) -> usize {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(e) => e
            .flatten()
            .filter_map(|x| x.file_name().to_str().map(|s| s.to_string()))
            .collect(),
        Err(_) => return 0,
    };
    names.sort();
    if names.len() <= limit {
        return 0;
    }
    let mut removed = 0;
    for name in names.iter().take(names.len() - limit) {
        if std::fs::remove_file(dir.join(name)).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 原子写入：先写临时文件再改名，避免写一半断电留下半个文件
pub fn write_string_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    // Windows 上 rename 到已存在的目标会失败，所以先删目标
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
// 不写路径标注的话，Rust 会去找 src/fsops/tests.rs（子目录形式），
// 但测试文件是 src/tests.rs（同级）。这里显式指明。
#[path = "tests.rs"]
mod tests;
