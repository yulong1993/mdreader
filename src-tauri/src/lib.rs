use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, FileIdMap};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// 每个窗口一份文件监听器（多窗口时各自维护自己的标签集），窗口同步标签集时整体替换。
struct WatcherState(
    Mutex<HashMap<String, Debouncer<notify::RecommendedWatcher, FileIdMap>>>,
);

/// 通过命令行参数传入的待打开文件（如双击 .md / 拖到 exe 上）。
struct InitialPath(Option<String>);

/// 最近聚焦的窗口标签：再次双击 .md 时文件转发到这里（而不是广播到所有窗口）。
struct FrontWindow(Mutex<String>);

/// 「从文件夹打开」最近一次经原生对话框选中的目录（规范化后）。
/// list_md_files 只接受与它一致的目录且一次有效——渲染层被攻破也无法
/// 把任意目录枚举当探子用（read_file 白名单仍是内容读取的最终闸门）。
struct BlessedDir(Mutex<Option<String>>);

/// 标签拖拽跟踪线程重入闸：同一时刻最多一个轮询线程。
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

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

/// 保存编辑内容。扩展名白名单与 read_file 一致；先写同目录临时文件再原子替换，避免写一半损坏原文档。
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let allowed = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false);
    if !allowed {
        return Err("仅允许保存 Markdown / 文本文档".into());
    }
    let tmp = format!("{path}.mdtmp");
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换原文件失败: {e}")
    })
}

/// 监听指定窗口当前打开的全部文件（多标签），任一变更时向前端广播 "fs-changed"
/// （载荷为该文件路径，前端各窗口按自己的标签过滤）。每次调用整体替换该窗口的监听集。
/// 事件按请求集 + 扩展名白名单双重过滤：监听器不能被当作任意目录的活动监视器。
#[tauri::command]
fn watch_files(
    app: AppHandle,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let app_handle = app.clone();
    // 请求集（规范化）先建好再移入闭包：事件只回放集合内的文档
    let mut watched = std::collections::HashSet::new();
    for path in &paths {
        if let Ok(c) = Path::new(path).canonicalize() {
            watched.insert(c);
        }
    }
    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |events: Result<Vec<notify_debouncer_full::DebouncedEvent>, _>| {
            if let Ok(events) = events {
                let mut seen = std::collections::HashSet::new();
                for ev in events {
                    for p in &ev.paths {
                        let ext_ok = p
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|e| TEXT_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
                            .unwrap_or(false);
                        if !ext_ok {
                            continue;
                        }
                        let canon = p.canonicalize().unwrap_or_else(|_| p.clone());
                        if watched.contains(&canon) && seen.insert(canon) {
                            let _ = app_handle.emit("fs-changed", p.to_string_lossy());
                        }
                    }
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    for path in &paths {
        debouncer
            .watch(Path::new(path), RecursiveMode::NonRecursive)
            .map_err(|e| format!("监听失败 {path}: {e}"))?;
    }

    state.0.lock().unwrap().insert(label, debouncer);
    Ok(())
}

/// 列出文件夹直接包含的可读文档（不递归），按修改时间倒序，上限 2000 条。
/// 仅接受最近一次原生对话框选中的目录（一次性），且只返回文档文件名——
/// 不给渲染层一个任意目录的枚举探子。
#[derive(Serialize)]
struct MdEntry {
    name: String,
    path: String,
    modified: u64, // unix 秒
}

const MAX_DIR_ENTRIES: usize = 2000;

#[tauri::command]
fn list_md_files(
    dir: String,
    state: State<'_, BlessedDir>,
) -> Result<Vec<MdEntry>, String> {
    let input = Path::new(&dir)
        .canonicalize()
        .map_err(|_| "目录不可用".to_string())?
        .to_string_lossy()
        .into_owned();
    let mut blessed = state.0.lock().unwrap();
    let ok = blessed.as_deref() == Some(input.as_str());
    *blessed = None; // 一次性：枚举许可随使用即焚
    if !ok {
        return Err("请通过「从文件夹打开」选择文件夹".into());
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("无法读取文件夹: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            continue;
        }
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| TEXT_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
            .unwrap_or(false);
        if !ext_ok {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(MdEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            modified,
        });
        if out.len() >= MAX_DIR_ENTRIES {
            break;
        }
    }
    out.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 原生文件夹选择对话框（Rust 侧）：结果同时登记为"祝福目录"，供 list_md_files 一次性使用。
#[tauri::command]
async fn pick_folder(app: AppHandle, state: State<'_, BlessedDir>) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .pick_folder(move |fp| {
            let picked = fp
                .and_then(|p| p.into_path().ok())
                .map(|pb| pb.to_string_lossy().into_owned());
            let _ = tx.send(picked);
        });
    let picked = rx.recv().map_err(|e| format!("对话框异常: {e}"))?;
    if let Some(ref dir) = picked {
        let canon = Path::new(dir)
            .canonicalize()
            .map(|p| p.to_string_lossy().into_owned())
            .ok();
        *state.0.lock().unwrap() = canon.or(Some(dir.clone()));
    }
    Ok(picked)
}

/// 路径规范化（canonicalize + 去 \\?\ 前缀）：作为标签身份，消除 8.3 短名、
/// 大小写、尾点等别名造成的"同一文件两个标签"（互相覆盖保存）问题。
#[tauri::command]
fn canon_path(path: String) -> Option<String> {
    Path::new(&path)
        .canonicalize()
        .ok()
        .map(|p| {
            let s = p.to_string_lossy().into_owned();
            s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
        })
}

/// 撕出标签成新窗口（原生侧创建）：标签格式校验 + 全局窗口数上限。
/// 不向前端开放通用的建窗能力（否则被攻破的渲染层可无限拉起 WebView 进程）。
/// 必须是 async：同步命令在主线程执行，而 build() 会阻塞等待新 WebView 就绪，
/// 就绪事件又要主线程处理——同步版本必然自锁（新窗口空白、原标签不动、应用无法关闭）。
#[tauri::command]
async fn tear_off_tab(app: AppHandle, label: String, x: f64, y: f64) -> Result<(), String> {
    let valid = label.len() >= 2
        && label.len() <= 13
        && label.starts_with('w')
        && label[1..]
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !valid {
        return Err("非法窗口标签".into());
    }
    if app.get_webview_window(&label).is_some() {
        return Err("窗口已存在".into());
    }
    if app.webview_windows().iter().filter(|(l, _)| *l != GHOST_LABEL).count() >= 12 {
        return Err("打开的窗口过多".into());
    }
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::default())
        .title("MD Reader")
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 400.0)
        .position(x, y)
        .build()
        .map_err(|e| format!("创建窗口失败: {e}"))?;
    Ok(())
}

#[cfg(windows)]
mod dragffi {
    #[repr(C)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    }
    pub fn cursor() -> Option<(i32, i32)> {
        unsafe {
            let mut p = Point { x: 0, y: 0 };
            if GetCursorPos(&mut p) != 0 {
                Some((p.x, p.y))
            } else {
                None
            }
        }
    }
    pub fn lbutton_down() -> bool {
        unsafe { (GetAsyncKeyState(0x01) as u16) & 0x8000 != 0 }
    }
    /// a 是否在 b 的上层（沿顶层 Z 序链向上走，遇到 b 即 a 在上）。
    /// 撕出的窗口常与原窗口重叠，命中测试必须取最上层那个。
    pub fn above(a: isize, b: isize) -> bool {
        if a == 0 || b == 0 {
            return false;
        }
        let mut h = a;
        while h != 0 {
            if h == b {
                return true;
            }
            h = unsafe { GetWindow(h, 3 /* GW_HWNDPREV */) };
        }
        false
    }
}

/// 拖拽跟手小窗（ghost）的窗口标签：固定名，建一次全程复用（隐藏而非销毁）
const GHOST_LABEL: &str = "ghost";
/// 拖起后仍算"在标签栏带内"的客户区高度（CSS 像素）：工具栏 44 + 标签行 ~40，留裕量
const TABBAR_BAND_CSS: f64 = 96.0;

#[derive(Serialize, Clone)]
struct DragEvent {
    phase: &'static str, // "move" | "end"
    #[serde(skip_serializing_if = "Option::is_none")]
    over: Option<String>, // 光标所在的本应用窗口（None = 窗外）
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<i32>, // end 时的全局物理坐标
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lx: Option<f64>, // 发起窗口客户区坐标（CSS 像素）
    #[serde(skip_serializing_if = "Option::is_none")]
    ly: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detached: Option<bool>, // 已拖离标签栏带（true = 标签应从栏上摘除）
}

/// 发给悬停目标窗口的插入指示：over=false 表示拖拽结束/离开，清除插入缝
#[derive(Serialize, Clone)]
struct HoverEvent {
    over: bool,
    lx: f64, // 目标窗口客户区坐标（CSS 像素）
    ly: f64,
    w: f64, // 被拖标签的宽度（缝宽与之一致）
}

/// ghost 小窗的显示状态（增量更新；ghost_current 供页面就绪后一次性拉取）
#[derive(Serialize, Clone, Default)]
struct GhostState {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    w: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'static str>, // "default" | "no-drop"
}
struct GhostInfo(Mutex<GhostState>);

fn ghost_emit(app: &AppHandle, patch: GhostState) {
    if let Ok(mut g) = app.state::<GhostInfo>().0.lock() {
        if patch.title.is_some() {
            g.title = patch.title.clone();
        }
        if patch.w.is_some() {
            g.w = patch.w;
        }
        if patch.cursor.is_some() {
            g.cursor = patch.cursor;
        }
        let _ = app.emit_to(GHOST_LABEL, "ghost-state", &*g);
    }
}

/// 命中测试：全局物理坐标落在哪个应用窗口上；重叠时取 Z 序最上层（ghost 永远不算）
fn hit_test_window(app: &AppHandle, x: i32, y: i32) -> Option<String> {
    let mut best: Option<(String, isize)> = None;
    for (label, w) in app.webview_windows() {
        if label == GHOST_LABEL {
            continue;
        }
        let Ok(pos) = w.outer_position() else { continue };
        let Ok(size) = w.outer_size() else { continue };
        if x < pos.x || x >= pos.x + size.width as i32 || y < pos.y || y >= pos.y + size.height as i32
        {
            continue;
        }
        #[cfg(windows)]
        let hwnd = w.hwnd().ok().map(|h| h.0 as isize);
        #[cfg(not(windows))]
        let hwnd = None;
        match (&best, hwnd) {
            (None, _) => best = Some((label, hwnd.unwrap_or(0))),
            // 后命中且在更上层 → 换人；拿不到句柄的保守不比
            (Some((_, bh)), Some(h)) => {
                if *bh == 0 || dragffi::above(h, *bh) {
                    best = Some((label, h));
                }
            }
            (Some(_), None) => {}
        }
    }
    best.map(|(l, _)| l)
}

/// 全局物理坐标 → 窗口客户区 CSS 坐标（窗口已关等失败返回 None）
fn local_logical(win: &tauri::WebviewWindow, x: i32, y: i32) -> Option<(f64, f64)> {
    let pos = win.inner_position().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    if scale <= 0.0 {
        return None;
    }
    Some((
        (x - pos.x) as f64 / scale,
        (y - pos.y) as f64 / scale,
    ))
}

/// 拖拽收尾（左键释放）：最后一帧几何信息 + 目标窗口插入缝清除 + ghost 隐藏
fn drag_end(
    app: &AppHandle,
    origin: &str,
    x: i32,
    y: i32,
    last_over: Option<String>,
    ghost_shown: bool,
    w: f64,
) {
    let own = last_over.as_deref() == Some(origin);
    let (lx, ly) = app
        .get_webview_window(origin)
        .and_then(|win| local_logical(&win, x, y))
        .unwrap_or((f64::MAX, f64::MAX));
    let detached = !(own && ly >= 0.0 && lx >= 0.0 && ly <= TABBAR_BAND_CSS);
    let _ = app.emit_to(
        origin,
        "tab-drag",
        DragEvent {
            phase: "end",
            over: last_over.clone(),
            x: Some(x),
            y: Some(y),
            lx: Some(lx),
            ly: Some(ly),
            detached: Some(detached),
        },
    );
    // 目标窗口的插入缝由 end 收尾清除
    if let Some(prev) = &last_over {
        if prev != origin {
            let _ = app.emit_to(
                prev,
                "tab-drop-hover",
                HoverEvent { over: false, lx: 0.0, ly: 0.0, w },
            );
        }
    }
    if ghost_shown {
        if let Some(g) = app.get_webview_window(GHOST_LABEL) {
            let _ = g.hide();
        }
    }
    DRAG_ACTIVE.store(false, Ordering::SeqCst);
}

/// 标签页拖拽跟踪：网页内拿不到窗口外的鼠标事件，由原生层轮询全局光标。
/// 拖离标签栏带（detached）时驱动一个无边框透明置顶的 ghost 小窗贴着光标走；
/// 悬停其它窗口时把该窗口的客户区坐标持续喂给它（插入缝定位）。
#[tauri::command]
fn drag_tab_begin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    title: Option<String>,
    width: Option<f64>,
) {
    if DRAG_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // 已有跟踪线程在跑
    }
    let origin = window.label().to_string();
    let title = title.unwrap_or_else(|| "…".into());
    let width = width.unwrap_or(150.0).clamp(48.0, 260.0);
    std::thread::spawn(move || {
        let mut last_over: Option<String> = None;
        let mut last_detached: Option<bool> = None;
        let mut ghost_spawned = false;
        let mut ghost_shown = false;
        let mut ghost_cursor: Option<&'static str> = None;
        loop {
            std::thread::sleep(Duration::from_millis(12));
            let Some((x, y)) = dragffi::cursor() else { break };
            if !dragffi::lbutton_down() {
                drag_end(&app, &origin, x, y, last_over, ghost_shown, width);
                break;
            }
            let over = hit_test_window(&app, x, y);
            let own = over.as_deref() == Some(origin.as_str());
            let (lx, ly) = app
                .get_webview_window(&origin)
                .and_then(|w| local_logical(&w, x, y))
                .unwrap_or((f64::MAX, f64::MAX));
            let detached = !(own && ly >= 0.0 && lx >= 0.0 && ly <= TABBAR_BAND_CSS);

            if detached {
                if !ghost_spawned {
                    ghost_spawned = true;
                    ensure_ghost(&app, title.clone(), width);
                }
                if let Some(g) = app.get_webview_window(GHOST_LABEL) {
                    let _ = g.set_position(tauri::PhysicalPosition::new(x + 12, (y - 36).max(0)));
                    if !ghost_shown {
                        ghost_shown = true;
                        let _ = g.show();
                    }
                }
                // 悬停自己窗口的内容区/标题栏 = 此处不能放（图2 的 🚫）
                let cur: &'static str = if own { "no-drop" } else { "default" };
                if ghost_cursor != Some(cur) {
                    ghost_cursor = Some(cur);
                    ghost_emit(&app, GhostState { title: None, w: None, cursor: Some(cur) });
                }
            } else if ghost_shown {
                ghost_shown = false;
                if let Some(g) = app.get_webview_window(GHOST_LABEL) {
                    let _ = g.hide();
                }
            }

            if over != last_over {
                if let Some(prev) = &last_over {
                    if prev != &origin {
                        let _ = app.emit_to(
                            prev,
                            "tab-drop-hover",
                            HoverEvent { over: false, lx: 0.0, ly: 0.0, w: width },
                        );
                    }
                }
            }
            if let Some(cur) = &over {
                if cur != &origin {
                    let (tlx, tly) = app
                        .get_webview_window(cur)
                        .and_then(|win| local_logical(&win, x, y))
                        .unwrap_or((0.0, 0.0));
                    let _ = app.emit_to(
                        cur,
                        "tab-drop-hover",
                        HoverEvent { over: true, lx: tlx, ly: tly, w: width },
                    );
                }
            }
            // over/detached 变化必发；在自家标签栏带内时逐帧发（就地把缝挪到光标处）
            if over != last_over || Some(detached) != last_detached || (own && !detached) {
                let _ = app.emit_to(
                    &origin,
                    "tab-drag",
                    DragEvent {
                        phase: "move",
                        over: over.clone(),
                        x: None,
                        y: None,
                        lx: Some(lx),
                        ly: Some(ly),
                        detached: Some(detached),
                    },
                );
            }
            last_over = over;
            last_detached = Some(detached);
        }
        if DRAG_ACTIVE.load(Ordering::SeqCst) {
            DRAG_ACTIVE.store(false, Ordering::SeqCst); // 光标读取失败等异常路径兜底
        }
    });
}

/// ghost 小窗页面就绪后一次性拉取当前显示状态（创建竞态：页面加载期间事件会丢）
#[tauri::command]
fn ghost_current(state: State<'_, GhostInfo>) -> GhostState {
    state.0.lock().unwrap().clone()
}

/// 创建（或复用）拖拽跟手 ghost 小窗：无边框、透明、置顶、不进任务栏。
/// 必须在异步上下文里建：同步路径会在主线程自锁（同 tear_off_tab 的教训）。
fn ensure_ghost(app: &AppHandle, title: String, w: f64) {
    if app.get_webview_window(GHOST_LABEL).is_some() {
        ghost_emit(app, GhostState { title: Some(title), w: Some(w), cursor: None });
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let built = tauri::WebviewWindowBuilder::new(
            &app,
            GHOST_LABEL,
            tauri::WebviewUrl::App("ghost.html".into()),
        )
        .title("MD Reader")
        .inner_size(320.0, 48.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .focused(false)
        .visible(false)
        .build();
        if built.is_ok() {
            ghost_emit(&app, GhostState { title: Some(title), w: Some(w), cursor: None });
        }
    });
}

/// 记录最近聚焦的窗口（用于双击 .md 时的转发目标）
#[tauri::command]
fn set_front_window(label: String, state: State<'_, FrontWindow>) {
    *state.0.lock().unwrap() = label;
}

/// 把指定窗口带到前台（标签合并进目标窗口后调用）
#[tauri::command]
fn focus_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
    }
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
pub fn run() {    tauri::Builder::default()
        // 必须最先注册：再次启动实例时（如双击 .md），把文件路径转发给最近聚焦的窗口
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let target = app
                .state::<FrontWindow>()
                .0
                .lock()
                .map(|g| g.clone())
                .unwrap_or_else(|_| "main".into());
            if let Some(window) = app.get_webview_window(&target) {
                // show() 不会还原最小化窗口，先显式还原再聚焦
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(path) = argv.iter().nth(1) {
                // 只发给目标窗口；广播会导致每个窗口都开一个同名标签
                let _ = app.emit_to(&target, "open-file", path);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState(Mutex::new(HashMap::new())))
        .manage(InitialPath(std::env::args().nth(1)))
        .manage(FrontWindow(Mutex::new("main".into())))
        .manage(BlessedDir(Mutex::new(None)))
        .manage(GhostInfo(Mutex::new(GhostState::default())))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            resolve_path,
            watch_files,
            find_wiki_target,
            initial_path,
            drag_tab_begin,
            set_front_window,
            focus_window,
            list_md_files,
            pick_folder,
            canon_path,
            tear_off_tab,
            ghost_current
        ])
        .setup(|app| {
            // 窗口偶发以最小化状态创建，显式还原（此前曾误判为双显示器 DPI 问题，
            // 实际截断根因是前端 grid 隐式 auto 列轨道被宽内容撑爆，见 styles.css）
            if let Some(win) = app.get_webview_window("main") {
                if win.is_minimized().unwrap_or(false) {
                    let _ = win.unminimize();
                }
            }
            Ok(())
        })
        // ghost 小窗隐藏复用、不计入"还有窗口吗"：最后一个真实窗口销毁时
        // 显式清掉 ghost 并退出，否则隐藏小窗会让进程残留（单实例转发会指向死进程）
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle();
            let real_left = app
                .webview_windows()
                .iter()
                .any(|(l, _)| *l != GHOST_LABEL);
            if !real_left {
                if let Some(g) = app.get_webview_window(GHOST_LABEL) {
                    let _ = g.destroy();
                }
                app.exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running mdreader");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_file_原子替换与白名单() {
        let dir = std::env::temp_dir().join("mdreader-write-test");
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("t.md");
        fs::write(&md, "old").unwrap();

        write_file(md.to_string_lossy().into_owned(), "new 内容".into()).unwrap();
        assert_eq!(fs::read_to_string(&md).unwrap(), "new 内容");
        assert!(!dir.join("t.md.mdtmp").exists(), "不应残留临时文件");

        let exe = dir.join("evil.exe");
        assert!(write_file(exe.to_string_lossy().into_owned(), "x".into()).is_err());
        assert!(!exe.exists(), "白名单外文件不应被创建");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_编码识别往返() {
        let dir = std::env::temp_dir().join("mdreader-read-test");
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("enc.md");

        fs::write(&md, "\u{FEFF}带 BOM 的中文").unwrap();
        assert_eq!(read_file(md.to_string_lossy().into_owned()).unwrap(), "带 BOM 的中文");

        // 手工构造 UTF-16LE（encoding_rs.encode 的 output-encoding 语义会返回 UTF-8，不可用于造测试数据）
        let mut bytes = vec![0xFF, 0xFE];
        for u in "UTF16 内容".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        fs::write(&md, &bytes).unwrap();
        assert_eq!(read_file(md.to_string_lossy().into_owned()).unwrap(), "UTF16 内容");

        let _ = fs::remove_dir_all(&dir);
    }
}
