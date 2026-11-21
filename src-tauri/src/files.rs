//! 图片保存、文件信息、历史版本、文件树里的新建/重命名/删除

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 目录里已有同名文件时，在文件名后面加 -1、-2 …
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem}-{i}{ext}")))
        .find(|c| !c.exists())
        .unwrap()
}

/// 把请求头里 encodeURIComponent 过的值还原
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(request: &tauri::ipc::Request<'_>, key: &str) -> Result<String, String> {
    request
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| format!("缺少参数 {key}"))
}

// ---------- 图片 ----------

/// 保存粘贴的图片（二进制直接放在请求体里）。请求头 dir、name；返回实际保存的文件名
#[tauri::command]
pub fn save_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要二进制图片数据".into());
    };
    let dir = PathBuf::from(header(&request, "dir")?);
    let name = header(&request, "name")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = unique_path(&dir, &name);
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target.file_name().unwrap().to_string_lossy().into_owned())
}

/// 把拖进来的图片复制到 dir 里；返回实际保存的文件名
#[tauri::command]
pub fn copy_into(src: String, dir: String) -> Result<String, String> {
    let src = PathBuf::from(src);
    let dir = PathBuf::from(dir);
    let name = src.file_name().ok_or("文件名无效")?.to_string_lossy().into_owned();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 已经在目标文件夹里了就不用再复制
    if src.parent().map(|p| p == dir).unwrap_or(false) {
        return Ok(name);
    }
    let target = unique_path(&dir, &name);
    fs::copy(&src, &target).map_err(|e| e.to_string())?;
    Ok(target.file_name().unwrap().to_string_lossy().into_owned())
}

// ---------- 文件信息（用来发现外部修改） ----------

#[derive(Serialize)]
pub struct Stat {
    mtime: u64,
    size: u64,
}

#[tauri::command]
pub fn file_stat(path: String) -> Option<Stat> {
    let meta = fs::metadata(&path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(Stat { mtime, size: meta.len() })
}

// ---------- 历史版本 ----------
// 存在应用数据目录 history/<路径哈希>/<毫秒时间戳>.md，不在用户的文档文件夹里留文件

const HISTORY_MAX: usize = 100;
const HISTORY_INTERVAL_MS: u64 = 5 * 60 * 1000;

fn history_dir(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let mut h = DefaultHasher::new();
    path.to_lowercase().hash(&mut h);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("history").join(format!("{:016x}", h.finish()));
    Ok(dir)
}

/// 按时间从旧到新排好的快照 (时间戳, 路径)
fn snapshots(dir: &Path) -> Vec<(u64, PathBuf)> {
    let mut list: Vec<(u64, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let ts = p.file_stem()?.to_str()?.parse::<u64>().ok()?;
            (p.extension()? == "md").then_some((ts, p))
        })
        .collect();
    list.sort_by_key(|(ts, _)| *ts);
    list
}

/// 存一份快照。内容和最近一份相同就不存；force 为 false 时，距离上一份不到 5 分钟也不存
#[tauri::command]
pub fn history_save(app: AppHandle, path: String, content: String, force: bool) -> Result<bool, String> {
    let dir = history_dir(&app, &path)?;
    let list = snapshots(&dir);
    if let Some((ts, last)) = list.last() {
        if fs::read_to_string(last).map(|c| c == content).unwrap_or(false) {
            return Ok(false);
        }
        if !force && now_ms().saturating_sub(*ts) < HISTORY_INTERVAL_MS {
            return Ok(false);
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("path.txt"), &path).ok();
    fs::write(dir.join(format!("{}.md", now_ms())), content).map_err(|e| e.to_string())?;
    let list = snapshots(&dir);
    if list.len() > HISTORY_MAX {
        for (_, p) in &list[..list.len() - HISTORY_MAX] {
            fs::remove_file(p).ok();
        }
    }
    Ok(true)
}

#[derive(Serialize)]
pub struct Snapshot {
    id: String,
    time: u64,
    size: u64,
}

/// 快照列表，最新的在前
#[tauri::command]
pub fn history_list(app: AppHandle, path: String) -> Result<Vec<Snapshot>, String> {
    let dir = history_dir(&app, &path)?;
    Ok(snapshots(&dir)
        .into_iter()
        .rev()
        .map(|(ts, p)| Snapshot { id: ts.to_string(), time: ts, size: fs::metadata(p).map(|m| m.len()).unwrap_or(0) })
        .collect())
}

#[tauri::command]
pub fn history_read(app: AppHandle, path: String, id: String) -> Result<String, String> {
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("无效的版本".into());
    }
    let dir = history_dir(&app, &path)?;
    fs::read_to_string(dir.join(format!("{id}.md"))).map_err(|e| e.to_string())
}

// ---------- 文件树：新建、重命名、删除 ----------

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { "已经有同名文件".into() } else { e.to_string() })
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("已经有同名文件夹".into());
    }
    fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    // 只改大小写时目标“存在”的是自己，允许
    if Path::new(&to).exists() && from.to_lowercase() != to.to_lowercase() {
        return Err("已经有同名的文件或文件夹".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// 删除到回收站（可以找回）
#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}
