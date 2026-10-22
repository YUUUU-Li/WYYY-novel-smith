//! fsops 的测试
//!
//! 这些断言是 `scripts/disk-format-test.ts` 的镜像。
//! 两边必须给出相同的期望值 —— 只要有一处不一致，就意味着
//! 浏览器版和桌面版会对同一个小说文件夹用不同的格式读写。
//!
//! 跑法：cd src-tauri && cargo test

use super::*;
use std::fs;

#[test]
fn path_constants_match_the_typescript_side() {
    assert_eq!(HISTORY_DIR, "历史");
    assert_eq!(META_FILE, "novel.json");
    assert_eq!(OUTLINE_FILE, "大纲.json");
    assert_eq!(TERMS_FILE, "词条.json");
    assert_eq!(entity_dir("character"), Some("角色"));
    assert_eq!(entity_dir("location"), Some("地点"));
    assert_eq!(entity_dir("event"), Some("事件"));
    assert_eq!(entity_dir("faction"), Some("势力"));
    assert_eq!(entity_dir("item"), Some("物品"));
    assert_eq!(entity_dir("concept"), Some("概念"));
    assert_eq!(entity_dir("未知类型"), None);
    assert_eq!(all_entity_dirs().len(), 6);
}

#[test]
fn safe_file_name_replaces_windows_illegal_chars() {
    // 与 disk-format-test.ts 的 nameCases 一一对应
    assert_eq!(safe_file_name("林昭"), "林昭");
    assert_eq!(safe_file_name("苏无咎"), "苏无咎");
    assert_eq!(safe_file_name("A/B"), "A·B");
    assert_eq!(safe_file_name("A:B"), "A·B");
    assert_eq!(safe_file_name("A*B"), "A·B");
    assert_eq!(safe_file_name("A?B"), "A·B");
    assert_eq!(safe_file_name("A\"B"), "A·B");
    assert_eq!(safe_file_name("A<B"), "A·B");
    assert_eq!(safe_file_name("A>B"), "A·B");
    assert_eq!(safe_file_name("A|B"), "A·B");
    assert_eq!(safe_file_name("A\\B"), "A·B");
    // 单引号是合法文件名字符，不该被替换
    assert_eq!(safe_file_name("寒刃's Edge"), "寒刃's Edge");
}

#[test]
fn safe_file_name_normalises_whitespace() {
    assert_eq!(safe_file_name("  前后空格  "), "前后空格");
    assert_eq!(safe_file_name("多个    空格"), "多个 空格");
    assert_eq!(safe_file_name("\t制表符\t"), "制表符");
}

#[test]
fn safe_file_name_handles_empty_and_long_input() {
    assert_eq!(safe_file_name(""), "未命名");
    assert_eq!(safe_file_name("   "), "未命名");
    assert_eq!(safe_file_name("///"), "·".repeat(3));

    // 截断按字符数而不是字节数：中文名不能因为按字节截断而出现半个字
    let long = "长".repeat(100);
    let got = safe_file_name(&long);
    assert_eq!(got.chars().count(), 60);
    assert_eq!(got, "长".repeat(60));
}

#[test]
fn safe_file_name_result_is_always_usable_on_windows() {
    // 遍历一组刁钻输入，确认输出里不含任何 Windows 非法字符
    let nasty = [
        "con",              // Windows 保留设备名（这里仅验证字符层面）
        "a/b\\c:d*e?f\"g<h>i|j",
        "..." ,
        "  ",
        "\\/:*?\"<>|",
        "名字里\n有换行",
    ];
    for input in nasty {
        let out = safe_file_name(input);
        for bad in ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] {
            assert!(
                !out.contains(bad),
                "输入 {:?} 的输出 {:?} 里仍含非法字符 {:?}",
                input,
                out,
                bad
            );
        }
        assert!(!out.is_empty(), "输入 {:?} 得到了空文件名", input);
        // 换行也必须被折叠掉，否则会写出一个带换行的文件名
        assert!(!out.contains('\n'), "输入 {:?} 的输出里仍有换行", input);
    }
}

#[test]
fn snapshot_stamp_matches_the_javascript_format() {
    // 与 disk-format-test.ts 的第 3 组对应
    assert_eq!(
        snapshot_stamp("2026-09-29T14:22:42.123Z"),
        "2026-09-29T14-22-42"
    );
}

#[test]
fn snapshot_stamp_never_contains_illegal_filename_chars() {
    let stamp = snapshot_stamp(&now_iso_utc());
    assert!(!stamp.contains(':'), "时间戳含冒号: {}", stamp);
    assert!(!stamp.contains('.'), "时间戳含点: {}", stamp);
    assert_eq!(stamp.chars().count(), 19, "时间戳长度应为 19: {}", stamp);
}

#[test]
fn snapshot_stamps_sort_chronologically_by_filename() {
    // 这个性质是 trim_history 不用解析时间就能删最旧的前提
    let a = snapshot_stamp("2026-09-29T09:00:00.000Z");
    let b = snapshot_stamp("2026-09-29T14:22:42.123Z");
    let c = snapshot_stamp("2026-09-30T01:00:00.000Z");
    let mut v = vec![c.clone(), a.clone(), b.clone()];
    v.sort();
    assert_eq!(v, vec![a, b, c]);
}

#[test]
fn now_iso_utc_has_the_expected_shape() {
    let s = now_iso_utc();
    // 形如 2026-09-29T14:22:42.123Z
    assert_eq!(s.len(), 24, "长度不对: {}", s);
    assert!(s.ends_with('Z'), "应以 Z 结尾: {}", s);
    assert_eq!(&s[4..5], "-");
    assert_eq!(&s[7..8], "-");
    assert_eq!(&s[10..11], "T");
    assert_eq!(&s[13..14], ":");
    assert_eq!(&s[16..17], ":");
    assert_eq!(&s[19..20], ".");
    // 年份应当是合理的四位数字
    let year: i32 = s[0..4].parse().expect("年份应是数字");
    assert!((2020..2100).contains(&year), "年份离谱: {}", year);
}

#[test]
fn civil_from_days_handles_known_dates() {
    // Unix 纪元
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    // 闰日
    assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    // 跨世纪闰年规则（2000 是闰年，1900 不是）
    assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    assert_eq!(civil_from_days(11_017), (2000, 3, 1));
}

#[test]
fn novel_dir_is_the_folder_itself() {
    // 「文件夹即作品」：选中的那一层就是作品，不再拼书名
    let root = Path::new("C:/库/战国记");
    assert_eq!(novel_dir(root, "随便什么标题"), root.to_path_buf());
}

#[test]
fn atomic_write_creates_parents_and_overwrites() {
    let tmp = std::env::temp_dir().join("novel-studio-test-atomic");
    let _ = fs::remove_dir_all(&tmp);
    let target = tmp.join("a").join("b").join("x.json");

    write_string_atomic(&target, "第一次").expect("首次写入");
    assert_eq!(fs::read_to_string(&target).unwrap(), "第一次");

    // 覆盖已存在的文件（Windows 上 rename 到已存在目标会失败，所以要处理）
    write_string_atomic(&target, "第二次").expect("覆盖写入");
    assert_eq!(fs::read_to_string(&target).unwrap(), "第二次");

    // 不应留下临时文件
    let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "留下了临时文件: {:?}", leftovers);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn list_entity_files_skips_hidden_and_temp() {
    let tmp = std::env::temp_dir().join("novel-studio-test-list");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    fs::write(tmp.join("林昭.md"), "x").unwrap();
    fs::write(tmp.join("苏无咎.md"), "x").unwrap();
    fs::write(tmp.join("大纲.json"), "x").unwrap(); // 非 md，应被跳过
    fs::write(tmp.join(".DS_Store"), "x").unwrap(); // 隐藏文件
    fs::write(tmp.join("林昭.md.tmp"), "x").unwrap(); // 临时文件
    fs::write(tmp.join("参考图.png"), "x").unwrap(); // 无关文件

    let got: Vec<String> = list_entity_files(&tmp)
        .iter()
        .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .collect();
    assert_eq!(got, vec!["林昭.md", "苏无咎.md"]);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn prune_removes_only_orphans() {
    let tmp = std::env::temp_dir().join("novel-studio-test-prune");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    fs::write(tmp.join("留下.md"), "x").unwrap();
    fs::write(tmp.join("孤儿.md"), "x").unwrap();

    let removed = prune_entity_files(&tmp, &["留下.md".to_string()]);
    assert_eq!(removed, 1);
    assert!(tmp.join("留下.md").exists());
    assert!(!tmp.join("孤儿.md").exists());

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn trim_history_keeps_the_newest() {
    let tmp = std::env::temp_dir().join("novel-studio-test-trim");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    // 造 65 份，文件名按时间递增
    for i in 0..65 {
        let day = 1 + i / 24;
        let hour = i % 24;
        let name = format!("2026-09-{:02}T{:02}-00-00.json", day, hour);
        fs::write(tmp.join(name), "x").unwrap();
    }

    let removed = trim_history(&tmp, 60);
    assert_eq!(removed, 5);

    let left: Vec<String> = fs::read_dir(&tmp)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(left.len(), 60);
    // 最早的那一份应该被删掉
    assert!(!left.contains(&"2026-09-01T00-00-00.json".to_string()));

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn list_novel_folders_is_empty_or_the_root_itself() {
    let tmp = std::env::temp_dir().join("novel-studio-test-folders");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    // 没有 novel.json：这个文件夹不是作品
    assert!(list_novel_folders(&tmp).is_empty());

    // 有 novel.json：它自己就是那部作品，用空字符串表示"就落在这一层"
    fs::write(tmp.join(META_FILE), "{}").unwrap();
    assert_eq!(list_novel_folders(&tmp), vec![String::new()]);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn read_meta_extracts_fields() {
    let tmp = std::env::temp_dir().join("novel-studio-test-meta");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();

    let json = r#"{"id":"proj_x","title":"铁砧","logline":"一句话","updatedAt":42}"#;
    fs::write(tmp.join(META_FILE), json).unwrap();

    let (id, title, logline, updated) = read_meta(&tmp).expect("应能读出元信息");
    assert_eq!(id, "proj_x");
    assert_eq!(title, "铁砧");
    assert_eq!(logline, "一句话");
    assert_eq!(updated, 42);

    // 缺字段时给默认值而不是崩溃
    fs::write(tmp.join(META_FILE), r#"{"id":"only_id"}"#).unwrap();
    let (id2, title2, logline2, updated2) = read_meta(&tmp).unwrap();
    assert_eq!(id2, "only_id");
    assert_eq!(title2, "未命名");
    assert_eq!(logline2, "");
    assert_eq!(updated2, 0);

    // 坏 JSON 返回 None，不 panic
    fs::write(tmp.join(META_FILE), "不是 json").unwrap();
    assert!(read_meta(&tmp).is_none());

    let _ = fs::remove_dir_all(&tmp);
}
