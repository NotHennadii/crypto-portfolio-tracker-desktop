use std::{
    env,
    net::TcpListener,
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use url::Url;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

struct ServerState(Mutex<Option<Child>>);
const CREDENTIAL_SERVICE: &str = "pnl-diary";
const CREDENTIAL_ACCOUNT: &str = "exchange-api-credentials";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureCredentials {
    bingx_api_key: Option<String>,
    bingx_api_secret: Option<String>,
    bitget_api_key: Option<String>,
    bitget_api_secret: Option<String>,
    bitget_passphrase: Option<String>,
    binance_api_key: Option<String>,
    binance_api_secret: Option<String>,
    bybit_api_key: Option<String>,
    bybit_api_secret: Option<String>,
    mexc_api_key: Option<String>,
    mexc_api_secret: Option<String>,
    gate_api_key: Option<String>,
    gate_api_secret: Option<String>,
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|e| format!("Failed to access secure storage entry: {e}"))
}

#[tauri::command]
fn save_secure_credentials(payload: SecureCredentials) -> Result<(), String> {
    let serialized = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize credentials payload: {e}"))?;
    let entry = credential_entry()?;
    entry
        .set_password(&serialized)
        .map_err(|e| format!("Failed to write credentials to secure storage: {e}"))?;
    Ok(())
}

#[tauri::command]
fn load_secure_credentials() -> Result<Option<SecureCredentials>, String> {
    let entry = credential_entry()?;
    match entry.get_password() {
        Ok(raw) => {
            let parsed = serde_json::from_str::<SecureCredentials>(&raw)
                .map_err(|e| format!("Failed to parse secure credentials payload: {e}"))?;
            Ok(Some(parsed))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read credentials from secure storage: {e}")),
    }
}

#[tauri::command]
fn clear_secure_credentials() -> Result<(), String> {
    let entry = credential_entry()?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear secure credentials: {e}")),
    }
}

#[tauri::command]
fn install_update_from_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid update URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS update URLs are allowed.".to_string());
    }
    let file_name = parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|name| !name.is_empty())
        .unwrap_or("pnl-diary-update.exe");
    let temp_file = std::env::temp_dir().join(file_name);
    let escaped_url = url.replace('\'', "''");
    let escaped_out = temp_file.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; \
Invoke-WebRequest -Uri '{escaped_url}' -OutFile '{escaped_out}'; \
Start-Process -FilePath '{escaped_out}'"
    );
    let mut cmd = Command::new("powershell");
    cmd
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to start background updater: {e}"))?;
    Ok(())
}

#[tauri::command]
fn install_update_and_restart(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid update URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS update URLs are allowed.".to_string());
    }
    let file_name = parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|name| !name.is_empty())
        .unwrap_or("pnl-diary-update.exe");
    let temp_file = env::temp_dir().join(file_name);
    let current_exe = env::current_exe()
        .map_err(|e| format!("Failed to resolve current executable path: {e}"))?;
    let pid = std::process::id();
    let escaped_url = url.replace('\'', "''");
    let escaped_out = temp_file.to_string_lossy().replace('\'', "''");
    let escaped_exe = current_exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ErrorActionPreference='Stop'; \
$ProgressPreference='SilentlyContinue'; \
$pidToWait={pid}; \
Invoke-WebRequest -Uri '{escaped_url}' -OutFile '{escaped_out}'; \
Wait-Process -Id $pidToWait -ErrorAction SilentlyContinue; \
Start-Process -FilePath '{escaped_out}' -ArgumentList '/S' -Wait; \
Start-Sleep -Seconds 2; \
$appDir = Split-Path -Path '{escaped_exe}' -Parent; \
$runtimeStatic = Join-Path $appDir 'desktop-runtime\\.next\\static'; \
for ($i = 0; $i -lt 30; $i++) {{ \
  if ((Test-Path '{escaped_exe}') -and (Test-Path $runtimeStatic)) {{ break }}; \
  Start-Sleep -Milliseconds 500; \
}}; \
Start-Process -FilePath '{escaped_exe}'"
    );
    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to start silent updater: {e}"))?;
    // Ensure bundled node.exe is released before installer starts replacing files.
    kill_server(&app);
    app.exit(0);
    Ok(())
}

fn wait_for_server(host: &str, port: u16, retries: u32, sleep_ms: u64) -> bool {
    for _ in 0..retries {
        if TcpStream::connect((host, port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(sleep_ms));
    }
    false
}

fn pick_free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to reserve local port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read reserved local port: {e}"))?
        .port();
    Ok(port)
}

fn spawn_local_server(app: &AppHandle) -> Result<String, String> {
    let mut candidates: Vec<(PathBuf, PathBuf)> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push((
            resource_dir.join("desktop-runtime"),
            resource_dir.join("node.exe"),
        ));
        candidates.push((
            resource_dir.join("desktop-runtime"),
            resource_dir.join("bin").join("node.exe"),
        ));
    }
    if let Ok(exe_dir) = app.path().executable_dir() {
        candidates.push((exe_dir.join("desktop-runtime"), exe_dir.join("node.exe")));
        candidates.push((
            exe_dir.join("desktop-runtime"),
            exe_dir.join("bin").join("node.exe"),
        ));
        candidates.push((
            exe_dir.parent().unwrap_or(&exe_dir).join("desktop-runtime"),
            exe_dir.join("node.exe"),
        ));
        candidates.push((
            exe_dir.parent().unwrap_or(&exe_dir).join("desktop-runtime"),
            exe_dir.parent().unwrap_or(&exe_dir).join("bin").join("node.exe"),
        ));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push((cwd.join("desktop-runtime"), cwd.join("node.exe")));
        candidates.push((cwd.join("desktop-runtime"), cwd.join("bin").join("node.exe")));
    }

    let mut resolved: Option<(PathBuf, PathBuf)> = None;
    for (runtime_dir, node_path) in candidates {
        let has_server = runtime_dir.join("server.js").exists();
        let has_static = runtime_dir.join(".next").join("static").exists();
        let has_public = runtime_dir.join("public").exists();
        if has_server && has_static && has_public && node_path.exists() {
            resolved = Some((runtime_dir, node_path));
            break;
        }
    }
    let (runtime_dir, node_path) = resolved.ok_or_else(|| {
        "Could not locate bundled runtime. Expected desktop-runtime with server.js, .next/static, public, and node.exe.".to_string()
    })?;
    let server_js = runtime_dir.join("server.js");

    let port = pick_free_local_port()?;
    let port_str = port.to_string();
    let mut cmd = Command::new(&node_path);
    cmd.current_dir(&runtime_dir)
        .arg(&server_js)
        .env("PORT", &port_str)
        .env("HOSTNAME", "127.0.0.1")
        .env("ALLOW_GUEST_MODE", "true")
        .env("NEXT_PUBLIC_ALLOW_GUEST_MODE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch local Next server: {e}"))?;

    app.state::<ServerState>()
        .0
        .lock()
        .map_err(|_| "Failed to lock server state".to_string())?
        .replace(child);

    if !wait_for_server("127.0.0.1", port, 200, 50) {
        return Err(format!(
            "Local Next server did not become ready on port {port}."
        ));
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

fn create_main_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| format!("Invalid app URL: {e}"))?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(target))
        .title("PnL Diary")
        .inner_size(1400.0, 900.0)
        .min_inner_size(1024.0, 700.0)
        .build()
        .map_err(|e| format!("Failed to create main window: {e}"))?;
    Ok(())
}

fn kill_server(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<ServerState>().0.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        *guard = None;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            install_update_from_url,
            install_update_and_restart,
            save_secure_credentials,
            load_secure_credentials,
            clear_secure_credentials
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            #[cfg(debug_assertions)]
            {
                create_main_window(&app_handle, "http://localhost:1420")?;
            }
            #[cfg(not(debug_assertions))]
            {
                let app_url = spawn_local_server(&app_handle)?;
                create_main_window(&app_handle, &app_url)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_server(&app_handle);
            }
        });
}
