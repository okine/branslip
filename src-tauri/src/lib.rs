use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    kind: String,
}

#[tauri::command]
fn list_dir(dir: String) -> Result<Vec<DirEntry>, String> {
    let p = PathBuf::from(&dir);
    let mut out = Vec::new();
    let rd = fs::read_dir(&p).map_err(|e| e.to_string())?;
    for ent in rd {
        let ent = match ent { Ok(e) => e, Err(_) => continue };
        let name = ent.file_name().to_string_lossy().to_string();
        let kind = if ent.path().is_dir() { "dir" } else { "file" };
        out.push(DirEntry { name, kind: kind.into() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
fn read_text(dir: String, name: String) -> Result<String, String> {
    let p = PathBuf::from(&dir).join(&name);
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(dir: String, name: String, text: String) -> Result<(), String> {
    let dirp = PathBuf::from(&dir);
    if let Err(e) = fs::create_dir_all(&dirp) {
        return Err(format!("创建目录失败: {} (目录: {})", e, dir));
    }
    
    let final_p = dirp.join(&name);
    let tmp_p = dirp.join(format!("{}.tmp", name));
    
    if let Err(e) = fs::write(&tmp_p, &text) {
        return Err(format!("写入 .tmp 失败: {} (文件: {})", e, tmp_p.display()));
    }
    
    // 修正未使用的变量警告，并改进错误处理
        if final_p.exists() {
            if let Err(e) = fs::remove_file(&final_p) {
                // 打印具体的错误信息，方便定位
                eprintln!("删除旧文件失败: {} (文件: {})", e, final_p.display());
                    // 尝试去掉只读属性再删一次（防御性编程）
            if let Ok(md) = fs::metadata(&final_p) {
                let mut perms = md.permissions();
                perms.set_readonly(false);
                let _ = fs::set_permissions(&final_p, perms);
            }
            if let Err(e2) = fs::remove_file(&final_p) {
                return Err(format!("覆盖旧文件失败: {} (文件: {})", e2, final_p.display()));
            }
        }
    }
    
    if let Err(e) = fs::rename(&tmp_p, &final_p) {
        return Err(format!("重命名失败: {} (源: {}, 目标: {})", e, tmp_p.display(), final_p.display()));
    }
    
    Ok(())
}

#[tauri::command]
fn read_bytes_b64(dir: String, rel: String) -> Result<String, String> {
    use base64::Engine;
    let p: PathBuf = Path::new(&dir).join(rel);
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn write_bytes(dir: String, name: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&b64).map_err(|e| e.to_string())?;

    /* 必须写绝对路径：Android 的系统「保存」对话框给的是 content:// URI，
       早先直接当路径用会变成相对路径、落到 / 上，报 "read only file system"。 */
    let dirp = PathBuf::from(&dir);
    if !dirp.is_absolute() {
        return Err(format!(
            "导出目录不是绝对路径（可能是 content:// URI）：{}", dir
        ));
    }
    fs::create_dir_all(&dirp)
        .map_err(|e| format!("创建目录失败：{}（{}）", dirp.display(), e))?;

    let out = dirp.join(&name);
    fs::write(&out, bytes)
        .map_err(|e| format!("写入失败：{}（{}）", out.display(), e))
}

#[tauri::command]
fn mkdir(dir: String, name: String) -> Result<(), String> {
    fs::create_dir_all(PathBuf::from(&dir).join(&name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn exists(dir: String, name: String) -> Result<String, String> {
    let p = PathBuf::from(&dir).join(&name);
    if !p.exists() { return Ok(String::new()); }
    if p.is_dir() { Ok("dir".into()) } else { Ok("file".into()) }
}

#[tauri::command]
fn remove_entry(dir: String, name: String, recursive: bool) -> Result<(), String> {
    let p = PathBuf::from(&dir).join(&name);
    let md = fs::metadata(&p).map_err(|e| e.to_string())?;
    if md.is_dir() {
        if recursive { fs::remove_dir_all(&p).map_err(|e| e.to_string()) }
        else { fs::remove_dir(&p).map_err(|e| e.to_string()) }
    } else {
        fs::remove_file(&p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    let f = PathBuf::from(&from);
    let t = PathBuf::from(&to);
    if t.exists() {
        let md = fs::metadata(&t).map_err(|e| e.to_string())?;
        if md.is_dir() { fs::remove_dir_all(&t).map_err(|e| e.to_string())?; }
        else { fs::remove_file(&t).map_err(|e| e.to_string())?; }
    }
    fs::rename(&f, &t).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    /* Web/Tauri 共享层用 '/' 拼路径；explorer.exe 对混合分隔符不稳，
       Windows 下统一成反斜杠再交给资源管理器。 */
    #[cfg(target_os = "windows")]
    let p = PathBuf::from(path.replace('/', "\\"));
    #[cfg(not(target_os = "windows"))]
    let p = PathBuf::from(&path);

    if !p.is_dir() {
        return Err("目录不存在或不是文件夹".into());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("当前平台不支持打开文件夹".into())
    }
}

/* Android 上没有「选文件夹」这回事：tauri-plugin-dialog 在 Android 只用
   ACTION_GET_CONTENT / ACTION_CREATE_DOCUMENT，没有 ACTION_OPEN_DOCUMENT_TREE，
   所以 showOpenDialog({directory:true}) 永远不会返回目录。
   这里给一个固定位置：应用的外部私有目录
     /storage/emulated/0/Android/data/<identifier>/files/时枝笺
   不需要任何存储权限，文件管理器 / 数据线能看到，也方便整目录拷出来。
   兜底：应用私有目录（用户看不见，但一定能写）。 */
#[tauri::command]
fn default_storage_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let identifier = app.config().identifier.clone();
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "android")]
    candidates.push(PathBuf::from(format!(
        "/storage/emulated/0/Android/data/{}/files/时枝笺", identifier
    )));

    #[cfg(not(target_os = "android"))]
    let _ = &identifier;

    if let Ok(d) = app.path().app_data_dir() {
        candidates.push(d.join("时枝笺"));
    }

    let mut last_err = String::from("没有可用目录");
    for c in candidates {
        match fs::create_dir_all(&c) {
            Ok(_) => return Ok(c.to_string_lossy().into_owned()),
            Err(e) => last_err = format!("{}（{}）", c.display(), e),
        }
    }
    Err(format!("无法创建存储目录：{}", last_err))
}

/* 这个目录能不能写：建目录 + 写一个探针文件再删掉。
   Android 11+ 上「所有文件访问」没授予时，对 /storage/emulated/0 下
   任意目录这里都会 EACCES —— 用它判断权限，不需要任何 Android API。 */
#[tauri::command]
fn can_write_dir(dir: String) -> bool {
    let p = PathBuf::from(&dir);
    if fs::create_dir_all(&p).is_err() { return false; }
    let probe = p.join(".shizhijian-write-probe");
    match fs::write(&probe, b"") {
        Ok(_) => { let _ = fs::remove_file(&probe); true }
        Err(_) => false,
    }
}

/* 换存储目录时把旧目录整棵树复制过去（迁移用）。返回复制的文件数。 */
#[tauri::command]
fn copy_dir_tree(from: String, to: String) -> Result<u32, String> {
    fn rec(src: &Path, dst: &Path, n: &mut u32) -> std::io::Result<()> {
        fs::create_dir_all(dst)?;
        for ent in fs::read_dir(src)? {
            let ent = ent?;
            let p = ent.path();
            let q = dst.join(ent.file_name());
            if p.is_dir() {
                rec(&p, &q, n)?;
            } else {
                fs::copy(&p, &q)?;
                *n += 1;
            }
        }
        Ok(())
    }
    let mut n = 0u32;
    rec(&PathBuf::from(&from), &PathBuf::from(&to), &mut n)
        .map_err(|e| format!("复制失败：{}", e))?;
    Ok(n)
}

/* ---------- 流式写盘（ZIP 导出用） ----------
 * write_bytes 每次都要把整份字节传过来；几 GB 的归档在 JS 侧就会 OOM。
 * 这里开一个长期持有的 BufWriter，按块追加，内存只占一块。
 */

static ZIP_WRITERS: OnceLock<Mutex<HashMap<u64, BufWriter<fs::File>>>> = OnceLock::new();
static ZIP_NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn zip_writers() -> &'static Mutex<HashMap<u64, BufWriter<fs::File>>> {
    ZIP_WRITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn zip_writer_open(path: String) -> Result<u64, String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(format!("导出路径不是绝对路径：{}", path));
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{}（{}）", dir.display(), e))?;
    }
    let f = fs::File::create(&p).map_err(|e| format!("创建文件失败：{}（{}）", p.display(), e))?;
    let id = ZIP_NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut map = zip_writers().lock().map_err(|e| e.to_string())?;
    map.insert(id, BufWriter::with_capacity(1 << 20, f));
    Ok(id)
}

#[tauri::command]
fn zip_writer_append(id: u64, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&b64).map_err(|e| e.to_string())?;
    let mut map = zip_writers().lock().map_err(|e| e.to_string())?;
    let w = map.get_mut(&id).ok_or_else(|| format!("写入句柄不存在：{}", id))?;
    w.write_all(&bytes).map_err(|e| format!("写入失败：{}", e))
}

#[tauri::command]
fn zip_writer_close(id: u64) -> Result<u64, String> {
    let mut map = zip_writers().lock().map_err(|e| e.to_string())?;
    let mut w = map.remove(&id).ok_or_else(|| format!("写入句柄不存在：{}", id))?;
    w.flush().map_err(|e| format!("flush 失败：{}", e))?;
    let f = w.into_inner().map_err(|e| format!("关闭失败：{}", e))?;
    let n = f.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(n)
}

/* 兜底退出：窗口销毁被 ACL 拒绝时（少见，但真发生过），
   直接用 AppHandle 退出进程，保证"确认关闭"一定关得掉。 */
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_dir, read_text, write_text, read_bytes_b64,
            write_bytes, mkdir, exists, remove_entry, rename_path,
            open_folder, default_storage_dir, can_write_dir, copy_dir_tree,
            zip_writer_open, zip_writer_append, zip_writer_close, quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}