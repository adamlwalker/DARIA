//! Local Z-Image-Turbo generation via an MLX Python sidecar (mflux).
//!
//! The sidecar is **never** started with the app. Rust creates a venv and
//! installs `mflux` on first use, then spawns the sidecar only when the user
//! actually generates. Turning the mode off (or quitting) kills the process
//! so the weights leave unified memory.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

const SCRIPT: &str = include_str!("../resources/image-gen/daria-image-mlx.py");
const MFLUX_SPEC: &str = "mflux>=0.18.1,<0.19";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SETUP_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const LOAD_TIMEOUT: Duration = Duration::from_secs(45 * 60);
const GEN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenStatus {
    pub supported: bool,
    pub platform: String,
    pub apple_silicon: bool,
    pub python: Option<String>,
    pub python_version: Option<String>,
    pub runtime_ready: bool,
    pub weights_ready: bool,
    pub loaded: bool,
    pub loaded_quant: Option<u8>,
    pub recommended_quant: u8,
    pub ram_gb: u64,
    pub images_dir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ImageGenProgress {
    Phase { phase: String, message: String },
    Progress { frac: f32, message: String },
    Done { path: Option<String> },
    Error { message: String },
}

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    /// `Some(4|8|16)` after a successful load; `None` if the process is up
    /// but weights are not in memory.
    loaded_quant: Option<u8>,
}

struct Runtime {
    sidecar: Option<Sidecar>,
}

fn runtime() -> &'static Mutex<Runtime> {
    static RT: OnceLock<Mutex<Runtime>> = OnceLock::new();
    RT.get_or_init(|| Mutex::new(Runtime { sidecar: None }))
}

fn cancel_flag() -> &'static AtomicBool {
    static C: OnceLock<AtomicBool> = OnceLock::new();
    C.get_or_init(|| AtomicBool::new(false))
}

pub fn recommended_quant(ram_gb: u64) -> u8 {
    if ram_gb <= 18 {
        4
    } else if ram_gb <= 40 {
        8
    } else {
        16
    }
}

pub fn parse_quant(raw: Option<u8>) -> Option<u8> {
    match raw {
        Some(4) => Some(4),
        Some(8) => Some(8),
        _ => None, // 16 / anything else = full precision
    }
}

pub fn quant_label(q: Option<u8>) -> &'static str {
    match q {
        Some(4) => "4-bit",
        Some(8) => "8-bit",
        _ => "fp16",
    }
}

pub fn slug_filename(prompt: &str, now_secs: u64) -> String {
    let mut s: String = prompt
        .chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c.is_whitespace() || c == '-' || c == '_' {
                Some('-')
            } else {
                None
            }
        })
        .take(48)
        .collect();
    while s.ends_with('-') {
        s.pop();
    }
    if s.is_empty() {
        s.push_str("image");
    }
    format!("{now_secs}-{s}.png")
}

fn is_apple_silicon() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        true
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

fn platform_name() -> String {
    if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else {
        "linux".into()
    }
}

fn ram_gb() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    (sys.total_memory() / (1024 * 1024 * 1024)).max(1)
}

pub fn image_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("image-gen");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn venv_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("venv").join("Scripts").join("python.exe")
    } else {
        root.join("venv").join("bin").join("python")
    }
}

fn script_path(root: &Path) -> Result<PathBuf, String> {
    let path = root.join("daria-image-mlx.py");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current != SCRIPT {
        std::fs::write(&path, SCRIPT).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// macOS GUI apps do not inherit the shell PATH, so Homebrew's 3.14 is
/// invisible and `/usr/bin/python3` (Apple 3.9) would otherwise win.
pub(crate) fn python_version_ok(ver: &str) -> bool {
    let mut it = ver.split('.');
    let maj = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let min = it.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    maj > 3 || (maj == 3 && min >= 10)
}

fn probe_python(bin: &Path) -> Option<String> {
    if !bin.is_file() {
        // Bare names like `python3.14` are allowed — Command looks them up.
        if bin.components().count() != 1 {
            return None;
        }
    }
    let out = Command::new(bin)
        .args(["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
    python_version_ok(&ver).then_some(ver)
}

fn python_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    const DIRS: &[&str] = &[
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
    ];
    const NAMES: &[&str] = &[
        "python3.14",
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "python3",
    ];
    for dir in DIRS {
        for name in NAMES {
            out.push(PathBuf::from(dir).join(name));
        }
    }
    if let Some(home) = &home {
        for name in NAMES {
            out.push(home.join(".local/bin").join(name));
        }
        out.push(
            home.join("Library/Frameworks/Python.framework/Versions/Current/bin/python3"),
        );
    }
    for name in NAMES {
        out.push(PathBuf::from("/Library/Frameworks/Python.framework/Versions/Current/bin").join(name));
        out.push(PathBuf::from(name));
    }
    out.push(PathBuf::from("/usr/bin/python3"));
    out
}

fn find_system_python() -> Option<(PathBuf, String)> {
    for bin in python_candidates() {
        if let Some(ver) = probe_python(&bin) {
            return Some((bin, ver));
        }
    }
    None
}

fn runtime_ready(root: &Path) -> bool {
    let py = venv_python(root);
    if !py.is_file() {
        return false;
    }
    Command::new(&py)
        .args(["-c", "import mflux, mlx"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn weights_ready(root: &Path) -> bool {
    let hub = root.join("hf").join("hub");
    let Ok(rd) = std::fs::read_dir(hub) else {
        return false;
    };
    rd.flatten().any(|e| {
        let n = e.file_name().to_string_lossy().to_lowercase();
        n.contains("z-image") || n.contains("z_image")
    })
}

fn kill_sidecar(sc: &mut Sidecar) {
    let _ = sc.stdin.write_all(b"{\"cmd\":\"quit\"}\n");
    let _ = sc.stdin.flush();
    let start = Instant::now();
    loop {
        match sc.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = sc.child.kill();
                let _ = sc.child.wait();
                break;
            }
        }
    }
}

fn unload_locked(rt: &mut Runtime) {
    if let Some(mut sc) = rt.sidecar.take() {
        kill_sidecar(&mut sc);
    }
}

/// Protocol lines are a single JSON object. Hugging Face / tqdm / MLX often
/// leak banners or progress bars onto stdout — skip those instead of failing
/// the generate (that was the first-run "bad sidecar json" error).
pub(crate) fn parse_sidecar_line(line: &str) -> Option<serde_json::Value> {
    let t = line.trim();
    if t.is_empty() || !t.starts_with('{') {
        return None;
    }
    serde_json::from_str(t).ok()
}

fn read_event(reader: &mut BufReader<std::process::ChildStdout>, timeout: Duration) -> Result<serde_json::Value, String> {
    let start = Instant::now();
    let mut line = String::new();
    loop {
        if cancel_flag().load(Ordering::SeqCst) {
            return Err(crate::agent::tr("已取消", "cancelled"));
        }
        if start.elapsed() > timeout {
            return Err(crate::agent::tr("图像引擎超时", "image engine timed out"));
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return Err(crate::agent::tr("图像引擎已退出", "image engine exited")),
            Ok(_) => {
                if let Some(v) = parse_sidecar_line(&line) {
                    return Ok(v);
                }
                let t = line.trim();
                if !t.is_empty() {
                    eprintln!("[imagegen] skipped non-protocol stdout: {t}");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn spawn_sidecar(root: &Path) -> Result<Sidecar, String> {
    let py = venv_python(root);
    if !py.is_file() {
        return Err(crate::agent::tr(
            "图像引擎尚未安装，请先在设置里完成安装",
            "image engine is not installed yet — finish setup in Settings first",
        ));
    }
    let script = script_path(root)?;
    let hf = root.join("hf");
    std::fs::create_dir_all(&hf).ok();
    let mut cmd = Command::new(&py);
    cmd.arg("-u")
        .arg(&script)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("HF_HOME", &hf)
        .env("HUGGINGFACE_HUB_CACHE", hf.join("hub"))
        .env("TRANSFORMERS_CACHE", hf.join("transformers"))
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        .env("TQDM_DISABLE", "1")
        .env("TOKENIZERS_PARALLELISM", "false")
        .env("TRANSFORMERS_VERBOSITY", "error")
        .env("PYTHONUNBUFFERED", "1");
    let mut child = cmd.spawn().map_err(|e| {
        crate::agent::tr(
            &format!("无法启动图像引擎: {e}"),
            &format!("failed to start image engine: {e}"),
        )
    })?;
    let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let r = BufReader::new(stderr);
            for line in r.lines().map_while(Result::ok) {
                eprintln!("[imagegen] {line}");
            }
        });
    }
    let mut reader = BufReader::new(stdout);
    let ev = read_event(&mut reader, READY_TIMEOUT)?;
    if ev.get("event").and_then(|v| v.as_str()) != Some("ready") {
        let _ = child.kill();
        return Err(crate::agent::tr(
            "图像引擎没有就绪",
            "image engine did not become ready",
        ));
    }
    Ok(Sidecar {
        child,
        stdin,
        reader,
        loaded_quant: None,
    })
}

fn send_cmd(sc: &mut Sidecar, cmd: &serde_json::Value) -> Result<(), String> {
    let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
    line.push('\n');
    sc.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    sc.stdin.flush().map_err(|e| e.to_string())
}

fn ensure_loaded(root: &Path, quant: Option<u8>, progress: &Channel<ImageGenProgress>) -> Result<(), String> {
    let mut rt = runtime().lock().map_err(|e| e.to_string())?;
    let want = quant.unwrap_or(16);
    if let Some(sc) = rt.sidecar.as_ref() {
        if sc.loaded_quant == Some(want) {
            return Ok(());
        }
    }
    if rt.sidecar.is_none() {
        let _ = progress.send(ImageGenProgress::Phase {
            phase: "spawn".into(),
            message: crate::agent::tr("正在启动图像引擎…", "Starting image engine…"),
        });
        rt.sidecar = Some(spawn_sidecar(root)?);
    }
    let sc = rt.sidecar.as_mut().unwrap();
    send_cmd(
        sc,
        &serde_json::json!({ "cmd": "load", "quant": quant.unwrap_or(16) }),
    )?;
    loop {
        let ev = read_event(&mut sc.reader, LOAD_TIMEOUT)?;
        match ev.get("event").and_then(|v| v.as_str()) {
            Some("loadProgress") => {
                let frac = ev.get("frac").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                let message = ev
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("loading")
                    .to_string();
                let _ = progress.send(ImageGenProgress::Progress { frac, message });
            }
            Some("loaded") => {
                sc.loaded_quant = Some(want);
                return Ok(());
            }
            Some("error") => {
                let msg = ev
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("load failed")
                    .to_string();
                return Err(msg);
            }
            _ => {}
        }
    }
}

fn setup_inner(root: &Path, progress: &Channel<ImageGenProgress>) -> Result<(), String> {
    if !is_apple_silicon() {
        return Err(crate::agent::tr(
            "图像生成仅支持 Apple Silicon Mac",
            "image generation requires an Apple Silicon Mac",
        ));
    }
    let (sys_py, ver) = find_system_python().ok_or_else(|| {
        crate::agent::tr(
            "需要 Python 3.10 或更高版本。请从 python.org 安装后再试。",
            "Python 3.10+ is required. Install it from python.org and try again.",
        )
    })?;
    let _ = progress.send(ImageGenProgress::Phase {
        phase: "python".into(),
        message: format!("Python {ver}"),
    });

    let venv = root.join("venv");
    if !venv_python(root).is_file() {
        let _ = progress.send(ImageGenProgress::Phase {
            phase: "venv".into(),
            message: crate::agent::tr("正在创建虚拟环境…", "Creating the Python environment…"),
        });
        let st = Command::new(&sys_py)
            .args(["-m", "venv"])
            .arg(&venv)
            .status()
            .map_err(|e| e.to_string())?;
        if !st.success() {
            return Err(crate::agent::tr(
                "无法创建 Python 虚拟环境",
                "failed to create the Python environment",
            ));
        }
    }

    let py = venv_python(root);
    let _ = progress.send(ImageGenProgress::Phase {
        phase: "pip".into(),
        message: crate::agent::tr("正在安装 MLX 图像引擎（mflux）…", "Installing the MLX image engine (mflux)…"),
    });
    let mut child = Command::new(&py)
        .args(["-m", "pip", "install", "--upgrade", "pip", MFLUX_SPEC])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        if start.elapsed() > SETUP_TIMEOUT {
            let _ = child.kill();
            return Err(crate::agent::tr("安装超时", "install timed out"));
        }
        match child.try_wait() {
            Ok(Some(st)) if st.success() => break,
            Ok(Some(_)) => {
                return Err(crate::agent::tr(
                    "安装 mflux 失败",
                    "failed to install mflux",
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(e.to_string()),
        }
    }
    if !runtime_ready(root) {
        return Err(crate::agent::tr(
            "mflux 安装后无法导入，请重试",
            "mflux installed but could not be imported — try again",
        ));
    }
    let _ = script_path(root)?;
    Ok(())
}

/// Public status for the Settings / first-use UI.
#[tauri::command]
pub fn imagegen_status(app: AppHandle) -> Result<ImageGenStatus, String> {
    let root = image_root(&app)?;
    let images = images_dir(&app)?;
    let (python, python_version) = find_system_python()
        .map(|(p, v)| (Some(p.display().to_string()), Some(v)))
        .unwrap_or((None, None));
    let loaded_quant = runtime()
        .lock()
        .ok()
        .and_then(|rt| rt.sidecar.as_ref().and_then(|s| s.loaded_quant));
    Ok(ImageGenStatus {
        supported: is_apple_silicon(),
        platform: platform_name(),
        apple_silicon: is_apple_silicon(),
        python,
        python_version,
        runtime_ready: runtime_ready(&root),
        weights_ready: weights_ready(&root),
        loaded: loaded_quant.is_some(),
        loaded_quant,
        recommended_quant: recommended_quant(ram_gb()),
        ram_gb: ram_gb(),
        images_dir: images.to_string_lossy().to_string(),
    })
}

/// Create the venv and install mflux. Idempotent. Streams phase updates.
#[tauri::command]
pub async fn imagegen_setup(
    app: AppHandle,
    on_progress: Channel<ImageGenProgress>,
) -> Result<(), String> {
    let root = image_root(&app)?;
    let progress = on_progress;
    tauri::async_runtime::spawn_blocking(move || {
        match setup_inner(&root, &progress) {
            Ok(()) => {
                let _ = progress.send(ImageGenProgress::Done { path: None });
                Ok(())
            }
            Err(e) => {
                let _ = progress.send(ImageGenProgress::Error { message: e.clone() });
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kill the sidecar (if any) so weights leave memory. Safe to call when idle.
#[tauri::command]
pub fn imagegen_unload() -> Result<(), String> {
    cancel_flag().store(true, Ordering::SeqCst);
    if let Ok(mut rt) = runtime().lock() {
        unload_locked(&mut rt);
    }
    cancel_flag().store(false, Ordering::SeqCst);
    Ok(())
}

/// Cancel an in-flight generate by unloading the sidecar.
#[tauri::command]
pub fn imagegen_cancel() -> Result<(), String> {
    imagegen_unload()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenResult {
    pub path: String,
    pub seed: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateArgs {
    pub prompt: String,
    pub quant: Option<u8>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub steps: Option<u32>,
    pub seed: Option<u64>,
}

/// Lazy-start the sidecar, load weights if needed, generate one PNG.
#[tauri::command]
pub async fn imagegen_generate(
    app: AppHandle,
    args: GenerateArgs,
    on_progress: Channel<ImageGenProgress>,
) -> Result<ImageGenResult, String> {
    if !is_apple_silicon() {
        return Err(crate::agent::tr(
            "图像生成仅支持 Apple Silicon Mac",
            "image generation requires an Apple Silicon Mac",
        ));
    }
    let root = image_root(&app)?;
    let images = images_dir(&app)?;
    let prompt = args.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(crate::agent::tr("提示词为空", "prompt is empty"));
    }
    let quant = parse_quant(args.quant);
    let width = args.width.unwrap_or(1024).clamp(256, 2048);
    let height = args.height.unwrap_or(1024).clamp(256, 2048);
    let steps = args.steps.unwrap_or(9).clamp(1, 50);
    let seed = args.seed;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = images.join(slug_filename(&prompt, now));
    let dest_s = dest.to_string_lossy().to_string();

    cancel_flag().store(false, Ordering::SeqCst);
    let progress = on_progress;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            ensure_loaded(&root, quant, &progress)?;
            let _ = progress.send(ImageGenProgress::Phase {
                phase: "generate".into(),
                message: crate::agent::tr("正在生成图像…", "Generating image…"),
            });
            let mut rt = runtime().lock().map_err(|e| e.to_string())?;
            let sc = rt.sidecar.as_mut().ok_or_else(|| {
                crate::agent::tr("图像引擎未运行", "image engine is not running")
            })?;
            send_cmd(
                sc,
                &serde_json::json!({
                    "cmd": "generate",
                    "prompt": prompt,
                    "width": width,
                    "height": height,
                    "steps": steps,
                    "seed": seed,
                    "out": dest_s.clone(),
                }),
            )?;
            loop {
                let ev = read_event(&mut sc.reader, GEN_TIMEOUT)?;
                match ev.get("event").and_then(|v| v.as_str()) {
                    Some("progress") => {
                        let step = ev.get("step").and_then(|v| v.as_u64()).unwrap_or(0);
                        let total = ev.get("total").and_then(|v| v.as_u64()).unwrap_or(9).max(1);
                        if step > 0 {
                            let frac = step as f32 / total as f32;
                            let _ = progress.send(ImageGenProgress::Progress {
                                frac,
                                message: format!("{step}/{total}"),
                            });
                        }
                    }
                    Some("done") => {
                        let path = ev
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or(dest_s.as_str())
                            .to_string();
                        let used = ev
                            .get("seed")
                            .and_then(|v| v.as_u64())
                            .or(seed)
                            .unwrap_or(0);
                        return Ok(ImageGenResult { path, seed: used });
                    }
                    Some("error") => {
                        let msg = ev
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("generation failed")
                            .to_string();
                        return Err(msg);
                    }
                    _ => {}
                }
            }
        })();
        match &result {
            Ok(out) => {
                let _ = progress.send(ImageGenProgress::Done {
                    path: Some(out.path.clone()),
                });
            }
            Err(e) => {
                let _ = progress.send(ImageGenProgress::Error { message: e.clone() });
                if e == "cancelled" || e.contains("cancel") {
                    if let Ok(mut rt) = runtime().lock() {
                        unload_locked(&mut rt);
                    }
                }
            }
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_images_dir(app: AppHandle) -> Result<String, String> {
    let dir = images_dir(&app)?;
    let path = dir.to_string_lossy().to_string();
    crate::commands::open_default(&path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommended_quant_tiers() {
        assert_eq!(recommended_quant(8), 4);
        assert_eq!(recommended_quant(16), 4);
        assert_eq!(recommended_quant(18), 4);
        assert_eq!(recommended_quant(24), 8);
        assert_eq!(recommended_quant(40), 8);
        assert_eq!(recommended_quant(41), 16);
        assert_eq!(recommended_quant(64), 16);
    }

    #[test]
    fn parse_quant_maps_full_precision() {
        assert_eq!(parse_quant(Some(4)), Some(4));
        assert_eq!(parse_quant(Some(8)), Some(8));
        assert_eq!(parse_quant(Some(16)), None);
        assert_eq!(parse_quant(Some(0)), None);
        assert_eq!(parse_quant(None), None);
    }

    #[test]
    fn quant_labels() {
        assert_eq!(quant_label(Some(4)), "4-bit");
        assert_eq!(quant_label(Some(8)), "8-bit");
        assert_eq!(quant_label(None), "fp16");
    }

    #[test]
    fn slug_is_filesystem_safe() {
        let s = slug_filename("A puffin, standing on a cliff!!! 造相", 1700000000);
        assert!(s.starts_with("1700000000-"));
        assert!(s.ends_with(".png"));
        assert!(!s.contains(' '));
        assert!(!s.contains(','));
        assert!(!s.contains('!'));
        assert!(s.contains("puffin"));
    }

    #[test]
    fn slug_fallback_when_empty() {
        let s = slug_filename("!!!", 1);
        assert_eq!(s, "1-image.png");
    }

    #[test]
    fn script_is_embedded() {
        assert!(SCRIPT.contains("daria-image-mlx"));
        assert!(SCRIPT.contains("ZImageTurbo"));
        assert!(SCRIPT.contains("\"cmd\""));
        assert!(SCRIPT.contains("_StderrOnly"));
    }

    #[test]
    fn python_314_is_accepted_apple_39_is_not() {
        assert!(python_version_ok("3.14"));
        assert!(python_version_ok("3.14.7"));
        assert!(python_version_ok("3.10"));
        assert!(python_version_ok("4.0"));
        assert!(!python_version_ok("3.9"));
        assert!(!python_version_ok("3.9.6"));
        assert!(!python_version_ok("2.7"));
        assert!(!python_version_ok(""));
    }

    #[test]
    fn python_candidates_include_homebrew() {
        let s: Vec<String> = python_candidates()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert!(s.iter().any(|p| p.contains("/opt/homebrew/bin/python3.14")));
        assert!(s.iter().any(|p| p.contains("/opt/homebrew/bin/python3")));
    }

    #[test]
    fn sidecar_skips_banners_and_progress_bars() {
        assert!(parse_sidecar_line("").is_none());
        assert!(parse_sidecar_line("Fetching 12 files:  45%|████").is_none());
        assert!(parse_sidecar_line("warning: mlx compiled with...").is_none());
        assert!(parse_sidecar_line("{not json").is_none());
        let v = parse_sidecar_line(r#"{"event":"ready"}"#).expect("protocol");
        assert_eq!(v["event"], "ready");
        let v = parse_sidecar_line("  {\"event\":\"done\",\"path\":\"/tmp/a.png\"} \n").expect("padded");
        assert_eq!(v["path"], "/tmp/a.png");
    }
}
