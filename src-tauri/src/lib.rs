mod files;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// 读取文本文件，去掉 UTF-8 BOM
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| "文件不是 UTF-8 编码".to_string())
}

/// 以 UTF-8 写入文件
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// 判断文件是否存在（用于清理“最近打开”里已删除的文件）
#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// 判断目录是否存在
#[tauri::command]
fn dir_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

// ---------- 文件树 ----------

const MD_EXTS: [&str; 2] = ["md", "markdown"];
/// 文件树里不显示的目录
const IGNORED_DIRS: [&str; 6] = ["node_modules", "target", "dist", "build", "__pycache__", "venv"];

fn is_md(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MD_EXTS.iter().any(|m| m.eq_ignore_ascii_case(e)))
}

fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$') || IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// 目录里（含子目录）是否有 md 文件。为了不在大目录上卡住，最多检查 budget 个条目，
/// 超出预算时当作“有”，宁可多显示一个文件夹也不漏掉。
fn contains_md(dir: &Path, depth: u32, budget: &mut u32) -> bool {
    let Ok(rd) = fs::read_dir(dir) else { return false };
    let mut subdirs = Vec::new();
    for entry in rd.flatten() {
        if *budget == 0 {
            return true;
        }
        *budget -= 1;
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !is_ignored_dir(&entry.file_name().to_string_lossy()) {
                subdirs.push(path);
            }
        } else if is_md(&path) {
            return true;
        }
    }
    depth > 0 && subdirs.iter().any(|d| contains_md(d, depth - 1, budget))
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    /// 文件夹里（含子目录）有没有 md 文件；没有的文件夹照样显示，但不能展开
    expandable: bool,
}

/// 列出一层目录：先文件夹后文件，按名称排序；显示所有文件夹（跳过隐藏和忽略的）和 md 文件
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let p = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !is_ignored_dir(&name) {
                let expandable = contains_md(&p, 6, &mut 3000);
                dirs.push(Entry { name, path: p.to_string_lossy().into_owned(), is_dir: true, expandable });
            }
        } else if is_md(&p) {
            files.push(Entry { name, path: p.to_string_lossy().into_owned(), is_dir: false, expandable: false });
        }
    }
    let key = |e: &Entry| e.name.to_lowercase();
    dirs.sort_by_key(key);
    files.sort_by_key(key);
    dirs.extend(files);
    Ok(dirs)
}

/// 监听文件夹：有文件新增、删除、重命名时通知前端刷新文件树。
/// 每个窗口各自监听自己的文件夹（按窗口标签区分），窗口关闭时释放
#[derive(Default)]
struct DirWatcher(Mutex<HashMap<String, RecommendedWatcher>>);

#[tauri::command]
fn watch_dir(app: AppHandle, window: tauri::Window, state: State<DirWatcher>, path: String) -> Result<(), String> {
    let label = window.label().to_string();
    let mut guard = state.0.lock().unwrap();
    guard.remove(&label); // 先停掉这个窗口旧的监听
    let target = label.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // 只关心结构变化；文件内容修改（比如自动保存）不需要刷新文件树
            let structural = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
            );
            if structural {
                let _ = app.emit_to(target.as_str(), "fs-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(Path::new(&path), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    guard.insert(label, watcher);
    Ok(())
}

// ---------- 启动参数 ----------

/// 从命令行参数里找出要打开的文件；相对路径按 cwd 解析
fn file_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    args.into_iter().skip(1).filter(|a| !a.starts_with('-')).find_map(|a| {
        let p = PathBuf::from(&a);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        p.is_file().then(|| p.to_string_lossy().into_owned())
    })
}

/// 启动参数里的文件路径（双击 .md 文件或“打开方式”启动时传入）
#[tauri::command]
fn initial_file() -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    file_from_args(std::env::args(), &cwd)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：已经开着时再双击 .md，把路径交给已有窗口，不再开新窗口
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 交给主窗口；主窗口已经关了就交给剩下的任意一个窗口
            let win = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next());
            if let Some(win) = win {
                let _ = win.unminimize();
                let _ = win.set_focus();
                if let Some(path) = file_from_args(argv, Path::new(&cwd)) {
                    let _ = app.emit_to(win.label(), "open-file", path);
                }
            }
        }))
        // 记住窗口大小和位置（只记主窗口，“新建”开出来的窗口不记）
        .plugin(tauri_plugin_window_state::Builder::default().with_filter(|label| label == "main").build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DirWatcher::default())
        // 窗口关闭时，释放它的文件夹监听
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<DirWatcher>() {
                    state.0.lock().unwrap().remove(window.label());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_exists,
            dir_exists,
            list_dir,
            watch_dir,
            initial_file,
            files::save_image,
            files::copy_into,
            files::file_stat,
            files::history_save,
            files::history_list,
            files::history_read,
            files::create_file,
            files::create_dir,
            files::rename_path,
            files::trash_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
