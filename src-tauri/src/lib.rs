// Disk + network backend for the Lego Builder window.
// Every command is a small generic file primitive; all Lego logic lives in the web frontend,
// so the same frontend also runs in a plain browser against tools/devserver.mjs.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const LIBRARY_URL: &str = "https://library.ldraw.org/library/updates/complete.zip";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME not set"))
}
fn support_dir() -> PathBuf {
    home().join("Library/Application Support/LegoBuilder")
}
fn data_dir() -> PathBuf {
    home().join("Documents/Lego Builder")
}

/// Trust boundary: the frontend may only touch our two folders.
fn guard(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("path not allowed: {p}"));
    }
    if path.starts_with(support_dir()) || path.starts_with(data_dir()) {
        Ok(path)
    } else {
        Err(format!("path not allowed: {p}"))
    }
}

#[derive(Serialize)]
struct Paths {
    library: String,
    cache: String,
    data: String,
}

#[tauri::command]
fn app_paths() -> Paths {
    let _ = fs::create_dir_all(data_dir());
    let _ = fs::create_dir_all(support_dir().join("cache"));
    Paths {
        library: support_dir().join("ldraw").to_string_lossy().into(),
        cache: support_dir().join("cache").to_string_lossy().into(),
        data: data_dir().to_string_lossy().into(),
    }
}

#[tauri::command]
fn read_text(path: String) -> Result<Option<String>, String> {
    let p = guard(&path)?;
    match fs::read(&p) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write via temp file + rename so a crash mid-save never leaves a half-written model.
fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp-write");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    write_atomic(&guard(&path)?, text.as_bytes())
}

/// Binary write (screenshots, thumbnails, video frames). Body is raw bytes, path in a header.
#[tauri::command]
fn write_bytes(request: tauri::ipc::Request) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = percent_decode(path);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    write_atomic(&guard(&path)?, bytes)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Serialize)]
struct Entry {
    name: String,
    is_dir: bool,
    modified: u64,
    size: u64,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let p = guard(&path)?;
    let rd = match fs::read_dir(&p) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = vec![];
    for e in rd.flatten() {
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(Entry {
            name: e.file_name().to_string_lossy().into(),
            is_dir: md.is_dir(),
            modified,
            size: md.len(),
        });
    }
    Ok(out)
}

/// Moves a file into the data folder's .trash instead of deleting it.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    let p = guard(&path)?;
    let trash = data_dir().join(".trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = p.file_name().ok_or("no file name")?.to_string_lossy();
    fs::rename(&p, trash.join(format!("{stamp}-{name}"))).map_err(|e| e.to_string())
}

/// Removes a file permanently. Only allowed inside cache and the autosave history folder.
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    let p = guard(&path)?;
    if !(p.starts_with(support_dir().join("cache")) || p.starts_with(data_dir().join(".history"))) {
        return Err("remove only allowed in cache/history".into());
    }
    if p.is_dir() {
        // only ever an emptied temp folder (turntable frames)
        return fs::remove_dir(&p).map_err(|e| e.to_string());
    }
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Returns the leading comment block (header) of every .dat file in a folder.
#[derive(Serialize)]
struct Header {
    file: String,
    header: String,
}

#[tauri::command]
fn scan_headers(path: String) -> Result<Vec<Header>, String> {
    let p = guard(&path)?;
    let mut out = vec![];
    for e in fs::read_dir(&p).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".dat") {
            continue;
        }
        let mut buf = vec![0u8; 4096];
        let n = fs::File::open(e.path())
            .and_then(|mut f| f.read(&mut buf))
            .unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]);
        let header: Vec<&str> = text
            .lines()
            .take_while(|l| {
                let t = l.trim();
                t.is_empty() || t.starts_with('0')
            })
            .collect();
        out.push(Header { file: name, header: header.join("\n") });
    }
    Ok(out)
}

/// GET from the LDraw site only (official set models). Runs in Rust to dodge webview CORS.
#[tauri::command]
fn http_get(url: String) -> Result<String, String> {
    if !url.starts_with("https://library.ldraw.org/") {
        return Err("only library.ldraw.org is allowed".into());
    }
    let out = Command::new("/usr/bin/curl")
        .args(["-sSfL", "--max-time", "60", &url])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---- first-run library download ----

#[derive(Serialize, Clone, Default)]
struct LibStatus {
    state: String, // "ready" | "missing" | "downloading" | "unpacking" | "error"
    bytes: u64,
    total: u64,
    error: String,
}

static LIB: Mutex<Option<LibStatus>> = Mutex::new(None);

#[tauri::command]
fn library_status() -> LibStatus {
    if let Some(s) = LIB.lock().unwrap().clone() {
        if s.state == "downloading" {
            let bytes = fs::metadata(support_dir().join("complete.zip")).map(|m| m.len()).unwrap_or(0);
            return LibStatus { bytes, ..s };
        }
        return s;
    }
    let ready = support_dir().join("ldraw/LDConfig.ldr").exists();
    LibStatus { state: if ready { "ready" } else { "missing" }.into(), ..Default::default() }
}

#[tauri::command]
fn download_library() {
    {
        let mut g = LIB.lock().unwrap();
        if matches!(g.as_ref().map(|s| s.state.as_str()), Some("downloading") | Some("unpacking")) {
            return;
        }
        *g = Some(LibStatus { state: "downloading".into(), total: 145_316_175, ..Default::default() });
    }
    std::thread::spawn(|| {
        let dir = support_dir();
        let _ = fs::create_dir_all(&dir);
        let zip = dir.join("complete.zip");
        let set = |s: LibStatus| *LIB.lock().unwrap() = Some(s);
        let ok = Command::new("/usr/bin/curl")
            .args(["-sSfL", "-o"])
            .arg(&zip)
            .arg(LIBRARY_URL)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            set(LibStatus { state: "error".into(), error: "download failed".into(), ..Default::default() });
            return;
        }
        set(LibStatus { state: "unpacking".into(), ..Default::default() });
        let ok = Command::new("/usr/bin/unzip")
            .args(["-q", "-o"])
            .arg(&zip)
            .arg("-d")
            .arg(&dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        set(LibStatus {
            state: if ok { "ready" } else { "error" }.into(),
            error: if ok { String::new() } else { "unzip failed".into() },
            ..Default::default()
        });
    });
}

// ---- video + finder ----

fn ffmpeg() -> Option<PathBuf> {
    ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

#[tauri::command]
fn has_ffmpeg() -> bool {
    ffmpeg().is_some()
}

/// Turns numbered PNG frames (frame_00000.png ...) into an H.264 .mp4.
#[tauri::command]
async fn encode_video(frames_dir: String, out_path: String, fps: u32) -> Result<(), String> {
    let frames = guard(&frames_dir)?;
    let out = guard(&out_path)?;
    let bin = ffmpeg().ok_or("ffmpeg is not installed")?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let result = Command::new(bin)
        .args(["-y", "-loglevel", "error", "-framerate", &fps.to_string(), "-i"])
        .arg(frames.join("frame_%05d.png"))
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"])
        .arg(&out)
        .output()
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&result.stderr).trim()))
    }
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = guard(&path)?;
    Command::new("/usr/bin/open").arg("-R").arg(p).status().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_paths,
            read_text,
            write_text,
            write_bytes,
            list_dir,
            trash_path,
            remove_file,
            scan_headers,
            http_get,
            library_status,
            download_library,
            has_ffmpeg,
            encode_video,
            reveal
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lego Builder");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guard_blocks_outside_and_dotdot() {
        let ok = data_dir().join("creations/house.ldr");
        assert!(guard(ok.to_str().unwrap()).is_ok());
        assert!(guard("/etc/passwd").is_err());
        let sneaky = data_dir().join("../../.ssh/id_rsa");
        assert!(guard(sneaky.to_str().unwrap()).is_err());
    }
    #[test]
    fn percent_decode_spaces() {
        assert_eq!(percent_decode("/a%20b/c.png"), "/a b/c.png");
        assert_eq!(percent_decode("plain"), "plain");
    }
}
