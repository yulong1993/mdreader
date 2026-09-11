use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, FileIdMap};
use tauri::{AppHandle, Emitter, Manager, State};

/// 活跃的文件监听器；打开新文件时旧监听器被 drop 即自动停止。
struct WatcherState(Mutex<Option<Debouncer<notify::RecommendedWatcher, FileIdMap>>>);

/// 通过命令行参数传入的待打开文件（如双击 .md / 拖到 exe 上）。
struct InitialPath(Option<String>);

/// 仅允许读取文本类文档：即使渲染层被攻破，也无法把这里当任意文件读取通道
const TEXT_EXTS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let allowed = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false);
    if !allowed {
        return Err("仅支持读取 Markdown / 文本文档（.md/.markdown/.mdown/.mkd/.txt）".into());
    }
    let meta = fs::metadata(&path).map_err(|e| format!("无法读取文件: {e}"))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err("文件过大（上限 50 MB）".into());
    }
    let bytes = fs::read(&path).map_err(|e| format!("无法读取文件: {e}"))?;
    // BOM 嗅探：UTF-8 / UTF-16LE / UTF-16BE；无 BOM 时 UTF-8 校验失败回退 GBK
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Ok(text.into_owned());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Ok(text.into_owned());
    }
    let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes[..]
    };
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => Ok(text),
        Err(err) => {
            // 旧的中文文档常见 GBK 编码，做一次回退解码
            let (text, _, had_errors) = encoding_rs::GBK.decode(err.as_bytes());
            if had_errors {
                Err("文件既不是 UTF-8/UTF-16 也无法按 GBK 解码".into())
            } else {
                Ok(text.into_owned())
            }
        }
    }
}

/// 把 Markdown 里的相对资源路径（图片等）解析为绝对路径，前端再转成 asset 协议 URL。
/// 把相对资源路径解析为真实存在的绝对路径（canonicalize，Windows 下带 \\?\ 前缀）。
/// 文件不存在时返回 None——绝不能返回拼接出来的假路径，否则 asset 协议会 404。
#[tauri::command]
fn resolve_path(base_dir: String, relative: String) -> Option<String> {
    let joined = Path::new(&base_dir).join(relative.replace('/', r"\"));
    joined
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// 监听指定文件，变更（保存）时向前端发送 "fs-changed" 事件。同一时刻只监听当前文件。
#[tauri::command]
fn watch_file(
    app: AppHandle,
    path: String,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let watched_path = path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |events: Result<Vec<notify_debouncer_full::DebouncedEvent>, _>| {
            if let Ok(events) = events {
                if !events.is_empty() {
                    let _ = app_handle.emit("fs-changed", &watched_path);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().unwrap() = Some(debouncer);
    Ok(())
}

/// 在 base_dir 及其子目录（深度 <= 3，跳过隐藏目录/node_modules/target）中
/// 查找 Obsidian wikilink 目标（优先 name.md，其次原样文件名）。找不到返回 None。
#[tauri::command]
fn find_wiki_target(base_dir: String, name: String) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return None;
    }

    fn walk(dir: &Path, name: &str, depth: u32) -> Option<std::path::PathBuf> {
        if depth == 0 {
            return None;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return None;
        };
        let mut subdirs = Vec::new();
        let mut loose_match = None;
        for entry in entries.flatten() {
            let path = entry.path();
            let fname = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if fname.starts_with('.') || fname == "node_modules" || fname == "target" {
                    continue;
                }
                subdirs.push(path);
            } else if fname.eq_ignore_ascii_case(&format!("{name}.md")) {
                return Some(path); // 精确命中：name.md
            } else if loose_match.is_none() && fname.eq_ignore_ascii_case(name) {
                loose_match = Some(path); // 原样文件名（含扩展名）
            }
        }
        if let Some(hit) = loose_match {
            return Some(hit);
        }
        for sd in subdirs {
            if let Some(hit) = walk(&sd, name, depth - 1) {
                return Some(hit);
            }
        }
        None
    }

    walk(Path::new(&base_dir), name, 3).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn initial_path(state: State<'_, InitialPath>) -> Option<String> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须最先注册：再次启动实例时（如双击 .md），把文件路径转发给已运行的实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(path) = argv.iter().nth(1) {
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState(Mutex::new(None)))
        .manage(InitialPath(std::env::args().nth(1)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            resolve_path,
            watch_file,
            find_wiki_target,
            initial_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running mdreader");
}
