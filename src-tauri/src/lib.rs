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

/// 前端事件写入诊断日志（与窗口几何日志同文件）
#[tauri::command]
fn log_event(tag: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("mdreader-window.log"))
    {
        let _ = writeln!(f, "{:?} tag=fe-{}", std::time::SystemTime::now(), tag);
    }
}

/// 通道脱节的自愈：先缩 1px，间隔后再还原，强制产生两轮真实的 WM_SIZE，
/// 等价于用户手动拖动窗口（已验证可修复该脱节）。
#[tauri::command]
fn kick_window(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("主窗口不存在")?
        .clone();
    let cur = win.inner_size().map_err(|e| e.to_string())?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let w = cur.width as f64 / scale;
    let h = cur.height as f64 / scale;
    std::thread::spawn(move || {
        let _ = win.set_size(tauri::LogicalSize::new(w - 1.0, h));
        std::thread::sleep(Duration::from_millis(120));
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
    });
    Ok(())
}

#[cfg(windows)]
mod win_geom {
    // 与 Win32 WINDOWPLACEMENT 布局一致的裸结构（避免引 windows crate 依赖）
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }
    #[repr(C)]
    pub struct Placement {
        pub length: u32,
        pub flags: u32,
        pub show_cmd: u32,
        pub pt_min_position: Point,
        pub pt_max_position: Point,
        pub rc_normal_position: Rect,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowPlacement(hwnd: isize, placement: *mut Placement) -> i32;
        fn SetWindowPlacement(hwnd: isize, placement: *const Placement) -> i32;
        fn EnumChildWindows(parent: isize, cb: isize, lparam: isize) -> i32;
        fn GetClassNameW(hwnd: isize, buf: *mut u16, max: i32) -> i32;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn SetWindowPos(
            hwnd: isize,
            after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn ClientToScreen(hwnd: isize, point: *mut Point) -> i32;
    }

    /// 客户区 (0,0) 在屏幕坐标中的位置
    pub fn client_origin(parent: isize) -> Option<(i32, i32)> {
        unsafe {
            let mut p = Point { x: 0, y: 0 };
            if ClientToScreen(parent, &mut p) != 0 {
                Some((p.x, p.y))
            } else {
                None
            }
        }
    }

    /// 枚举 parent 的直接子窗口里 class 名含 chrome 的（WebView2 的 Chromium 渲染窗口），
    /// 返回 (hwnd, 相对父窗口左上角的 x, y, w, h)
    pub fn chrome_children(parent: isize) -> Vec<(isize, i32, i32, i32, i32)> {
        struct Ctx {
            parent: isize,
            out: Vec<(isize, i32, i32, i32, i32)>,
        }
        unsafe extern "system" fn cb(child: isize, lparam: isize) -> i32 {
            let ctx = &mut *(lparam as *mut Ctx);
            let mut buf = [0u16; 64];
            let n = GetClassNameW(child, buf.as_mut_ptr(), 64);
            let class = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            if !class.to_lowercase().contains("chrome") {
                return 1;
            }
            let mut wr = Rect::default();
            let mut pr = Rect::default();
            if GetWindowRect(child, &mut wr) == 0 || GetWindowRect(ctx.parent, &mut pr) == 0 {
                return 1;
            }
            ctx.out.push((
                child,
                wr.left - pr.left,
                wr.top - pr.top,
                wr.right - wr.left,
                wr.bottom - wr.top,
            ));
            1
        }
        let mut ctx = Ctx {
            parent,
            out: Vec::new(),
        };
        unsafe {
            EnumChildWindows(parent, cb as isize, &mut ctx as *mut Ctx as isize);
        }
        ctx.out
    }

    /// 强制把 child 摆到父窗口客户区 (0,0) 处、大小 w×h
    pub fn place_child(child: isize, w: i32, h: i32) -> bool {
        unsafe {
            // SWP_NOZORDER(4) | SWP_NOACTIVATE(0x10) = 0x14
            SetWindowPos(child, 0, 0, 0, w, h, 0x14) != 0
        }
    }

    pub fn client_size(hwnd: isize) -> Option<(i32, i32)> {
        unsafe {
            let mut r = Rect::default();
            if GetClientRect(hwnd, &mut r) != 0 {
                Some((r.right - r.left, r.bottom - r.top))
            } else {
                None
            }
        }
    }

    pub fn read(hwnd: isize) -> Option<Placement> {
        unsafe {
            let mut p = Placement {
                length: std::mem::size_of::<Placement>() as u32,
                ..std::mem::zeroed()
            };
            if GetWindowPlacement(hwnd, &mut p) != 0 {
                Some(p)
            } else {
                None
            }
        }
    }

    pub fn write(hwnd: isize, p: &Placement) -> bool {
        unsafe { SetWindowPlacement(hwnd, p) != 0 }
    }
}

/// TEMP-DIAG：窗口几何日志（诊断"非全屏打开截断"，问题定位后移除）
fn log_geom(w: &tauri::WebviewWindow<tauri::Wry>, tag: &str) {
    use std::io::Write;
    let scale = w.scale_factor().unwrap_or(0.0);
    let inner = w.inner_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_default();
    let rect = w
        .hwnd()
        .ok()
        .and_then(|h| win_geom::read(h.0 as isize))
        .map(|p| {
            let r = p.rc_normal_position;
            format!(" normal=({},{})-({},{}) show={}", r.left, r.top, r.right, r.bottom, p.show_cmd)
        })
        .unwrap_or_default();
    let line = format!(
        "{:?} tag={} scale={} inner={}{rect} maximized={:?} minimized={:?}\n",
        std::time::SystemTime::now(),
        tag,
        scale,
        inner,
        w.is_maximized(),
        w.is_minimized()
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("mdreader-window.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {    tauri::Builder::default()
        // 必须最先注册：再次启动实例时（如双击 .md），把文件路径转发给已运行的实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // show() 不会还原最小化窗口，先显式还原再聚焦
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
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
            write_file,
            resolve_path,
            watch_file,
            find_wiki_target,
            initial_path,
            kick_window,
            log_event
        ])
        .setup(|app| {
            // Windows 高 DPI（200%）下窗口尺寸偶发被按物理像素写入（只有应有大小的一半，
            // 非最大化时内容被截断），且偶发以最小化状态创建；冷启动慢时损坏可能晚于
            // 窗口创建才发生。持续 60s 自检，只修正"恰好等于期望一半"的特征尺寸——
            // 绝不与用户手动调整的任意尺寸打架。
            if let Some(win) = app.get_webview_window("main") {
                if win.is_minimized().unwrap_or(false) {
                    let _ = win.unminimize();
                }
                log_geom(&win, "startup");
                let w = win.clone();
                win.on_window_event(move |e| {
                    if matches!(e, tauri::WindowEvent::Resized(_)) {
                        log_geom(&w, "event-resized");
                    }
                });
                let w = win.clone();
                let wv = app.get_webview("main");
                std::thread::spawn(move || {
                    let hwnd = w.hwnd().map(|h| h.0 as isize).ok();
                    let mut n = 0u32;
                    loop {
                        // 永久监控：签名制修正不会与用户手动调整冲突
                        std::thread::sleep(Duration::from_millis(2000));
                        n += 1;
                        if w.is_minimized().unwrap_or(false) {
                            let _ = w.unminimize();
                        }
                        // 启动后 3~20s 是"页面按外框宽度排版、可视区被裁"的高发窗口，
                        // 检测手段在该层全部失效（各 API 自报正常），故无条件主动踢几次，
                        // 强制产生真实 WM_SIZE 促使 Chromium 按真实客户区重排。
                        if n == 2 || n == 3 || n == 4 || n == 5 || n == 7 || n == 10 {
                            if !w.is_maximized().unwrap_or(false) {
                                log_geom(&w, "proactive-kick");
                                let scale = w.scale_factor().unwrap_or(2.0);
                                if let Ok(cur) = w.inner_size() {
                                    let lw = cur.width as f64 / scale;
                                    let lh = cur.height as f64 / scale;
                                    let _ = w.set_size(tauri::LogicalSize::new(lw - 1.0, lh));
                                    std::thread::sleep(Duration::from_millis(120));
                                    let _ = w.set_size(tauri::LogicalSize::new(lw, lh));
                                }
                            }
                        }
                        let Ok(scale) = w.scale_factor() else { continue };
                        let want_w = 1100.0 * scale;
                        let want_h = 760.0 * scale;
                        // 可见尺寸命中签名：≈期望的一半 → 重设
                        if let Ok(cur) = w.inner_size() {
                            if (cur.width as f64 - want_w / 2.0).abs() < 60.0
                                && (cur.height as f64 - want_h / 2.0).abs() < 60.0
                            {
                                log_geom(&w, "fix-half-size");
                                let _ = w.set_size(tauri::PhysicalSize::new(want_w, want_h));
                            }
                        }
                        // WebView2 覆盖范围偶发与窗口客户区脱节（内容渲染到窗口外被裁），
                        // 每次自检都比对并强制同步
                        if let (Some(wv), Ok(cur)) = (wv.as_ref(), w.inner_size()) {
                            if let Ok(b) = wv.bounds() {
                                let bs = b.size.to_physical::<u32>(scale);
                                if bs.width.abs_diff(cur.width) > 10
                                    || bs.height.abs_diff(cur.height) > 10
                                {
                                    log_geom(&w, "fix-webview-bounds");
                                    let _ = wv.set_bounds(tauri::Rect {
                                        position: tauri::Position::Physical(
                                            tauri::PhysicalPosition::new(0, 0),
                                        ),
                                        size: tauri::Size::Physical(tauri::PhysicalSize::new(
                                            cur.width, cur.height,
                                        )),
                                    });
                                }
                            }
                        }
                        // 更里层：WebView2 控制器可能报告正常，但其内部 Chromium 渲染子窗口
                        // 停在旧尺寸（内容画大、窗口裁掉，且 document.title 等更新通道一并失灵）。
                        // 直接用 Win32 检查子窗口矩形并强制对齐客户区。
                        if let Some(h) = hwnd {
                            if let (Some((cw, chh)), Some((cox, coy))) =
                                (win_geom::client_size(h), win_geom::client_origin(h))
                            {
                                // 客户区原点相对窗口矩形原点的偏移（边框+标题栏）
                                let (cox_rel, coy_rel) = (
                                    cox - w.outer_position().map(|p| p.x).unwrap_or(cox),
                                    coy - w.outer_position().map(|p| p.y).unwrap_or(coy),
                                );
                                for (child, x, y, w2, h2) in win_geom::chrome_children(h) {
                                    // 子窗口坐标换算到客户区
                                    let cx = x - cox_rel;
                                    let cy = y - coy_rel;
                                    let dw = (w2 - cw).abs();
                                    let dh = (h2 - chh).abs();
                                    if cx.abs() > 10 || cy.abs() > 10 || dw > 10 || dh > 10 {
                                        log_geom(
                                            &w,
                                            &format!(
                                                "fix-chrome-child rel=({cx},{cy},{w2}x{h2}) client=({cw}x{chh})"
                                            ),
                                        );
                                        let _ = win_geom::place_child(child, cw, chh);
                                    }
                                }
                            }
                        }
                        // 恢复矩形也可能带签名（窗口当前最大化/最小化时可见尺寸改不动）
                        if let Some(h) = hwnd {
                            if let Some(mut p) = win_geom::read(h) {
                                let r = p.rc_normal_position;
                                if ((r.right - r.left) as f64 - want_w / 2.0).abs() < 60.0
                                    && ((r.bottom - r.top) as f64 - want_h / 2.0).abs() < 60.0
                                {
                                    p.rc_normal_position.right = r.left + want_w as i32;
                                    p.rc_normal_position.bottom = r.top + want_h as i32;
                                    log_geom(&w, "fix-restore-rect");
                                    let _ = win_geom::write(h, &p);
                                }
                            }
                        }
                        if n == 1 {
                            log_geom(&w, "probe-1");
                        }
                    }
                });
            }
            Ok(())
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
