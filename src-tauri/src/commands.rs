//! Tauri 命令层
//!
//! 这一层只做三件事：接参数、调 `fsops`、把错误转成字符串。
//! 所有与磁盘格式有关的规则都在 `fsops` 里，那里有测试。
//!
//! 参数形状刻意用 `serde_json::Value` 而不是精确的结构体：
//! 前端的 `Novel` 类型是唯一的真相来源，在 Rust 里复制一份结构体
//! 只会带来「改了 TS 忘了改 Rust」的漂移。这一层是可信的原生层，
//! 精确校验的价值低于保持一致的价值。

use crate::fsops::*;
use serde::Serialize;
use std::path::PathBuf;

/// 把错误转成人能读的字符串。前端会把它显示在保存状态条上。
fn err_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelSummary {
    id: String,
    title: String,
    logline: String,
    updated_at: u64,
    entity_count: usize,
    /// 每种类型各有多少条，供界面显示构成
    counts: std::collections::BTreeMap<String, usize>,
}

/// 读回一部小说时返回给前端的形状。
///
/// 刻意把「文件路径」和「原始文本」包成 { file, raw } 对象数组：
/// 前端的 `read()` 只认这个形状。如果这里直接返回字符串数组，
/// TS 侧会静默拿到 undefined —— 这种错误编译不报，只有跑起来才炸。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawNovel {
    project: serde_json::Value,
    raw_entities: Vec<RawEntity>,
    outline: serde_json::Value,
    terms: serde_json::Value,
}

#[derive(Serialize)]
pub struct RawEntity {
    file: String,
    raw: String,
}

/// 找出某个 id 对应的小说文件夹。
/// 文件夹名可能被用户改过，所以只能逐个读 novel.json 比对 id。
fn find_folder_by_id(root: &std::path::Path, id: &str) -> Option<PathBuf> {
    for folder in list_novel_folders(root) {
        let dir = root.join(NOVELS_ROOT).join(&folder);
        if let Some((found_id, _, _, _)) = read_meta(&dir) {
            if found_id == id {
                return Some(dir);
            }
        }
    }
    None
}

/// 列出小说库里所有作品
#[tauri::command]
pub fn list_projects(root: String) -> Result<Vec<NovelSummary>, String> {
    let root = PathBuf::from(root);
    let mut out = Vec::new();

    for folder in list_novel_folders(&root) {
        let dir = root.join(NOVELS_ROOT).join(&folder);
        let (id, title, logline, updated) = match read_meta(&dir) {
            Some(m) => m,
            None => continue,
        };

        let mut counts = std::collections::BTreeMap::new();
        let mut total = 0usize;
        for (type_name, dir_name) in [
            ("character", "角色"),
            ("location", "地点"),
            ("event", "事件"),
            ("faction", "势力"),
            ("item", "物品"),
            ("concept", "概念"),
        ] {
            let n = list_entity_files(&dir.join(dir_name)).len();
            if n > 0 {
                counts.insert(type_name.to_string(), n);
            }
            total += n;
        }

        out.push(NovelSummary {
            id,
            title,
            logline,
            updated_at: updated as u64,
            entity_count: total,
            counts,
        });
    }

    // 最近更新的排在前面
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// 读回一整部小说。
///
/// 只读实体目录下的 .md；大纲与词条缺失时按空数组处理，
/// 这样半成品文件夹也能打开，而不是报错拒绝。
#[tauri::command]
pub fn read_novel(root: String, id: String) -> Result<Option<RawNovel>, String> {
    let root = PathBuf::from(root);
    let dir = match find_folder_by_id(&root, &id) {
        Some(d) => d,
        None => return Ok(None),
    };

    let meta_text = std::fs::read_to_string(dir.join(META_FILE))
        .map_err(|e| format!("读不到 {}：{}", META_FILE, err_str(e)))?;
    let project: serde_json::Value = serde_json::from_str(&meta_text)
        .map_err(|e| format!("{} 解析失败：{}", META_FILE, err_str(e)))?;

    let mut raw_entities: Vec<RawEntity> = Vec::new();
    for dir_name in all_entity_dirs() {
        let sub = dir.join(dir_name);
        if !sub.is_dir() {
            continue;
        }
        for path in list_entity_files(&sub) {
            let raw = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue, // 单个文件读不了不该让整次读取失败
            };
            // 正文与 front matter 的分割交给前端做：
            // 那边已经有经过 29 项测试的解析器，在 Rust 里重写一份没有意义。
            let file = format!(
                "{}/{}",
                dir_name,
                path.file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            );
            raw_entities.push(RawEntity { file, raw });
        }
    }

    Ok(Some(RawNovel {
        project,
        raw_entities,
        outline: read_json_or_default(&dir.join(OUTLINE_FILE)),
        terms: read_json_or_default(&dir.join(TERMS_FILE)),
    }))
}

fn read_json_or_default(path: &std::path::Path) -> serde_json::Value {
    match std::fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or(serde_json::json!([])),
        Err(_) => serde_json::json!([]),
    }
}

/// 写回一整部小说。
///
/// 前端已经把每个实体序列化成 Markdown 文本（含 front matter），
/// 这里只负责按布局落盘、清理孤儿文件、留一份快照。
#[tauri::command]
pub fn write_novel(
    root: String,
    project: serde_json::Value,
    entities: Vec<serde_json::Value>,
    outline: serde_json::Value,
    terms: serde_json::Value,
    history_limit: Option<usize>,
) -> Result<(), String> {
    let root_buf = PathBuf::from(&root);
    // 必须 to_string() 拿到自己的一份，不能只借用 project 里的字符串：
    // 后面把 project 移进快照 JSON 时，借用的 &str 还活着，借用检查会拒绝。
    let title = project
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("未命名")
        .to_string();
    let dir = novel_dir(&root_buf, &title);

    // 元信息
    let meta = serde_json::to_string_pretty(&project).map_err(err_str)?;
    write_string_atomic(&dir.join(META_FILE), &(meta + "\n")).map_err(err_str)?;

    // 按目录归类要保留的文件名，落盘的同时收集 keep 集合
    let mut keep_by_dir: std::collections::BTreeMap<&str, Vec<String>> =
        std::collections::BTreeMap::new();
    for d in all_entity_dirs() {
        keep_by_dir.insert(d, Vec::new());
    }

    for ent in &entities {
        let type_name = ent.get("type").and_then(|t| t.as_str()).unwrap_or("concept");
        let dir_name = match entity_dir(type_name) {
            Some(d) => d,
            None => continue,
        };
        let name = ent.get("name").and_then(|t| t.as_str()).unwrap_or("未命名");
        let raw = ent.get("raw").and_then(|t| t.as_str()).unwrap_or("");

        // 同一目录内同名要加序号，否则会互相覆盖
        let base = safe_file_name(name);
        let existing = keep_by_dir.get(dir_name).cloned().unwrap_or_default();
        let file_name = unique_name(&base, &existing);
        keep_by_dir
            .get_mut(dir_name)
            .expect("目录已在上面初始化")
            .push(file_name.clone());

        write_string_atomic(&dir.join(dir_name).join(&file_name), raw).map_err(err_str)?;
    }

    // 清掉改名或改类型留下的孤儿文件
    for (dir_name, keep) in &keep_by_dir {
        prune_entity_files(&dir.join(dir_name), keep);
    }

    // JSON 部分
    let outline_text = serde_json::to_string_pretty(&outline).map_err(err_str)?;
    write_string_atomic(&dir.join(OUTLINE_FILE), &(outline_text + "\n")).map_err(err_str)?;
    let terms_text = serde_json::to_string_pretty(&terms).map_err(err_str)?;
    write_string_atomic(&dir.join(TERMS_FILE), &(terms_text + "\n")).map_err(err_str)?;

    // 快照
    let history = dir.join(HISTORY_DIR);
    let now = now_iso_utc();
    let stamp = snapshot_stamp(&now);
    let envelope = serde_json::json!({
        "savedAt": now,
        "project": title,
        "entities": entities.len(),
        // 这里 project 的所有权被移进快照。前面 title 已经取了自己的一份，
        // 所以不会和借用冲突。
        "novel": { "project": project, "entities": entities, "outline": outline, "terms": terms },
    });
    let env_text = serde_json::to_string_pretty(&envelope).map_err(err_str)?;
    if write_string_atomic(&history.join(format!("{}.json", stamp)), &env_text).is_ok() {
        trim_history(&history, history_limit.unwrap_or(HISTORY_LIMIT));
    }

    Ok(())
}

/// 同一目录内重名时追加序号
fn unique_name(base: &str, taken: &[String]) -> String {
    let first = format!("{}.md", base);
    if !taken.contains(&first) {
        return first;
    }
    let mut i = 2;
    loop {
        let candidate = format!("{}-{}.md", base, i);
        if !taken.contains(&candidate) {
            return candidate;
        }
        i += 1;
    }
}

/// 删除一部小说（整目录，含历史）
#[tauri::command]
pub fn delete_novel(root: String, id: String) -> Result<(), String> {
    let root_buf = PathBuf::from(&root);
    let dir = match find_folder_by_id(&root_buf, &id) {
        Some(d) => d,
        None => return Ok(()),
    };
    std::fs::remove_dir_all(&dir).map_err(err_str)
}

/// 弹系统对话框选小说库文件夹
#[tauri::command]
pub async fn pick_library(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("选择小说库文件夹")
        .blocking_pick_folder();
    Ok(picked.map(|p| p.to_string()))
}
