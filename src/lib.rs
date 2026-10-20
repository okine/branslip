use std::fs;
use std::path::{Path, PathBuf};

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
    fs::create_dir_all(&dirp).map_err(|e| e.to_string())?;
    let final_p = dirp.join(&name);
    let tmp_p = dirp.join(format!("{}.tmp", name));
    fs::write(&tmp_p, &text).map_err(|e| e.to_string())?;
    if final_p.exists() {
        fs::remove_file(&final_p).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_p, &final_p).map_err(|e| e.to_string())?;
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
    let dirp = PathBuf::from(&dir);
    fs::create_dir_all(&dirp).map_err(|e| e.to_string())?;
    fs::write(dirp.join(&name), bytes).map_err(|e| e.to_string())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_dir, read_text, write_text, read_bytes_b64,
            write_bytes, mkdir, exists, remove_entry, rename_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}