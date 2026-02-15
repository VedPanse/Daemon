use serde::Serialize;
use serde_json::{json, Value};
use serialport::SerialPort;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const SERIAL_EVENT: &str = "serial_line";

#[derive(Clone)]
struct SerialSession {
    writer: Arc<Mutex<Box<dyn SerialPort + Send>>>,
    stop_tx: mpsc::Sender<()>,
    port_name: String,
}

#[derive(Clone)]
struct NodeManifestSummary {
    raw: Value,
    device_name: Option<String>,
    node_id: Option<String>,
    tokens: Vec<String>,
}

struct OrchestratorProcess {
    child: Child,
    args: Vec<String>,
    http_base_url: String,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<SerialSession>>,
    orchestrator_proc: Mutex<Option<OrchestratorProcess>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialPortEntry {
    port_name: String,
    port_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    connected: bool,
    port_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorProcessStatus {
    running: bool,
    pid: Option<u32>,
    http_base_url: Option<String>,
    args: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeProbeStatus {
    ok: bool,
    host: String,
    port: u16,
    target: String,
    device_name: Option<String>,
    node_id: Option<String>,
    tokens: Vec<String>,
    manifest: Option<Value>,
}

fn port_type_name(port_type: &serialport::SerialPortType) -> String {
    match port_type {
        serialport::SerialPortType::UsbPort(info) => {
            let mut label = String::from("usb");
            if let Some(product) = &info.product {
                label = format!("usb:{product}");
            }
            label
        }
        serialport::SerialPortType::BluetoothPort => String::from("bluetooth"),
        serialport::SerialPortType::PciPort => String::from("pci"),
        serialport::SerialPortType::Unknown => String::from("unknown"),
    }
}

fn emit_serial_line(app: &AppHandle, line: String) {
    let _ = app.emit(SERIAL_EVENT, line);
}

fn stop_session_locked(slot: &mut Option<SerialSession>) {
    if let Some(session) = slot.take() {
        let _ = session.stop_tx.send(());
    }
}

fn stop_orchestrator_locked(slot: &mut Option<OrchestratorProcess>) {
    if let Some(mut proc_) = slot.take() {
        // Best-effort terminate. If this fails, we still drop the handle.
        let _ = proc_.child.kill();
        let _ = proc_.child.wait();
    }
}

fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("orchestrator_base_url is empty".to_string());
    }
    Ok(trimmed.to_string())
}

fn resolve_socket_addrs(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Failed to resolve {host}:{port}: {error}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(format!("No addresses found for {host}:{port}"));
    }
    Ok(addrs)
}

fn find_repo_root() -> Result<PathBuf, String> {
    // Tauri apps often start with a CWD that isn't the repo root. We search upward from:
    // - current_exe()
    // - current_dir()
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }

    for start in candidates {
        let mut cur: Option<&Path> = Some(start.as_path());
        while let Some(dir) = cur {
            let orch = dir.join("orchestrator").join("orchestrator.py");
            if orch.exists() {
                return Ok(dir.to_path_buf());
            }
            cur = dir.parent();
        }
    }

    Err("Could not locate repo root (expected orchestrator/orchestrator.py). Run the app from the repo, or set VITE_ORCHESTRATOR_BASE_URL and start orchestrator manually.".to_string())
}

fn resolve_python3() -> String {
    // GUI apps on macOS might not inherit the interactive shell PATH.
    for candidate in [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "python3".to_string()
}

fn unix_ts_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn trunc_for_log(input: &str, max_len: usize) -> String {
    if input.len() <= max_len {
        return input.to_string();
    }
    let cut = input
        .char_indices()
        .nth(max_len)
        .map(|(idx, _)| idx)
        .unwrap_or(input.len());
    format!("{}...(truncated)", &input[..cut])
}

fn append_desktop_audit_log(event: &str, payload: &Value) {
    let logs_dir = match repo_logs_dir() {
        Ok(path) => path,
        Err(_) => return,
    };
    if std::fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let log_path = logs_dir.join("backend_audit.jsonl");
    let mut file = match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(f) => f,
        Err(_) => return,
    };

    let line = json!({
        "ts_ms": unix_ts_ms(),
        "event": event,
        "payload": payload
    });
    let _ = writeln!(file, "{}", line);
}

fn repo_logs_dir() -> Result<PathBuf, String> {
    Ok(find_repo_root()?.join("logs"))
}

fn sanitize_log_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err("file_name cannot be empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("file_name must be a plain file name under logs/".to_string());
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
fn write_debug_log(file_name: String, payload: Value) -> Result<(), String> {
    let safe_name = sanitize_log_file_name(&file_name)?;
    let logs_dir = repo_logs_dir()?;
    std::fs::create_dir_all(&logs_dir).map_err(|e| {
        format!(
            "Failed to create logs directory {}: {e}",
            logs_dir.display()
        )
    })?;
    let path = logs_dir.join(safe_name);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let line = json!({
        "ts_ms": unix_ts_ms(),
        "payload": payload
    });
    writeln!(file, "{}", line).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command]
fn read_debug_log(file_name: String, tail_lines: Option<usize>) -> Result<String, String> {
    let safe_name = sanitize_log_file_name(&file_name)?;
    let path = repo_logs_dir()?.join(safe_name);
    if !path.exists() {
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let limit = tail_lines.unwrap_or(300).max(1);
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..].join("\n"))
}

fn parse_manifest_summary(manifest: &Value) -> NodeManifestSummary {
    let device_name = manifest
        .get("device")
        .and_then(|d| d.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let node_id = manifest
        .get("device")
        .and_then(|d| d.get("node_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut tokens: Vec<String> = Vec::new();
    if let Some(cmds) = manifest.get("commands").and_then(|v| v.as_array()) {
        for cmd in cmds {
            if let Some(tok) = cmd.get("token").and_then(|v| v.as_str()) {
                tokens.push(tok.to_string());
            }
        }
    }
    tokens.sort();
    tokens.dedup();
    NodeManifestSummary {
        raw: manifest.clone(),
        device_name,
        node_id,
        tokens,
    }
}

fn probe_daemon_node(host: &str, port: u16) -> Result<NodeManifestSummary, String> {
    let host_trimmed = host.trim();
    if host_trimmed.is_empty() {
        return Err("host cannot be empty".to_string());
    }

    let addrs = resolve_socket_addrs(host_trimmed, port)?;
    let mut last_error = None;

    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(2)) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_nodelay(true);
                stream
                    .write_all(b"HELLO\n")
                    .map_err(|error| format!("Node write failed: {error}"))?;
                stream
                    .flush()
                    .map_err(|error| format!("Node flush failed: {error}"))?;

                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .map_err(|error| format!("Node read failed: {error}"))?;
                let line = line.trim().to_string();
                if !line.starts_with("MANIFEST ") {
                    return Err(format!("Expected MANIFEST from HELLO, got: {line}"));
                }
                let payload = line["MANIFEST ".len()..].trim();
                let manifest: Value = serde_json::from_str(payload)
                    .map_err(|error| format!("Invalid MANIFEST JSON: {error}"))?;
                return Ok(parse_manifest_summary(&manifest));
            }
            Err(error) => {
                last_error = Some(format!("Connect to {addr} failed: {error}"));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Node connect failed".to_string()))
}

async fn orchestrator_request(
    method: reqwest::Method,
    orchestrator_base_url: String,
    path: &str,
    body: Option<Value>,
    correlation_id: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&orchestrator_base_url)?;
    let url = format!("{base}{path}");
    let client = reqwest::Client::new();
    let request_body = body.clone();
    let request = client.request(method.clone(), &url);
    let request = if let Some(cid) = correlation_id.as_ref() {
        request.header("X-Correlation-Id", cid)
    } else {
        request
    };
    let request = if let Some(payload) = body {
        request.json(&payload)
    } else {
        request
    };

    append_desktop_audit_log(
        "orchestrator.request",
        &json!({
            "method": method.to_string(),
            "url": url.clone(),
            "body": request_body,
            "correlation_id": correlation_id
        }),
    );

    let response = request.send().await.map_err(|error| {
        let msg = format!("{method} {url} failed: network error: {error}");
        append_desktop_audit_log(
            "orchestrator.network_error",
            &json!({
                "method": method.to_string(),
                "url": url.clone(),
                "error": msg,
                "correlation_id": correlation_id
            }),
        );
        msg
    })?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("{method} {url} failed: could not read response body: {error}"))?;

    append_desktop_audit_log(
        "orchestrator.response",
        &json!({
            "method": method.to_string(),
            "url": url.clone(),
            "status": status.as_u16(),
            "body": trunc_for_log(&response_text, 8000),
            "correlation_id": correlation_id
        }),
    );

    if !status.is_success() {
        return Err(format!(
            "{method} {url} failed: HTTP {} body={}",
            status.as_u16(),
            response_text
        ));
    }

    serde_json::from_str::<Value>(&response_text).map_err(|error| {
        format!("{method} {url} failed: invalid JSON response: {error}; body={response_text}")
    })
}

#[tauri::command]
async fn vision_step_request(
    vercel_base_url: String,
    payload: Value,
    correlation_id: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&vercel_base_url)?;
    let url = format!("{base}/api/vision_step");
    let client = reqwest::Client::new();
    let request = client.post(&url).json(&payload);
    let request = if let Some(cid) = correlation_id.as_ref() {
        request.header("X-Correlation-Id", cid)
    } else {
        request
    };

    append_desktop_audit_log(
        "vision_step.request",
        &json!({
            "url": url,
            "correlation_id": correlation_id
        }),
    );

    let response = request.send().await.map_err(|error| {
        let msg = format!("POST {url} failed: network error: {error}");
        append_desktop_audit_log(
            "vision_step.network_error",
            &json!({
                "url": url,
                "error": msg,
                "correlation_id": correlation_id
            }),
        );
        msg
    })?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("POST {url} failed: could not read response body: {error}"))?;

    append_desktop_audit_log(
        "vision_step.response",
        &json!({
            "url": url,
            "status": status.as_u16(),
            "body": trunc_for_log(&response_text, 8000),
            "correlation_id": correlation_id
        }),
    );

    if !status.is_success() {
        return Err(format!(
            "POST {url} failed: HTTP {} body={}",
            status.as_u16(),
            response_text
        ));
    }

    serde_json::from_str::<Value>(&response_text).map_err(|error| {
        format!("POST {url} failed: invalid JSON response: {error}; body={response_text}")
    })
}

#[tauri::command]
fn read_desktop_audit_log(tail_lines: Option<usize>) -> Result<String, String> {
    let path = repo_logs_dir()?.join("backend_audit.jsonl");
    if !path.exists() {
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let limit = tail_lines.unwrap_or(300).max(1);
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..].join("\n"))
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortEntry>, String> {
    let ports = serialport::available_ports().map_err(|error| error.to_string())?;
    let result = ports
        .into_iter()
        .map(|port| SerialPortEntry {
            port_name: port.port_name,
            port_type: port_type_name(&port.port_type),
        })
        .collect::<Vec<_>>();
    Ok(result)
}

#[tauri::command]
fn connect_serial(
    app: AppHandle,
    state: State<'_, AppState>,
    port_name: String,
    baud_rate: Option<u32>,
) -> Result<ConnectionStatus, String> {
    let baud = baud_rate.unwrap_or(115_200);

    let port = serialport::new(&port_name, baud)
        .timeout(Duration::from_millis(120))
        .open()
        .map_err(|error| format!("Failed to open serial port {port_name}: {error}"))?;

    let mut reader = port
        .try_clone()
        .map_err(|error| format!("Failed to clone serial reader: {error}"))?;

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let writer: Arc<Mutex<Box<dyn SerialPort + Send>>> =
        Arc::new(Mutex::new(port as Box<dyn SerialPort + Send>));

    let app_handle = app.clone();
    thread::spawn(move || {
        let mut read_buf = [0_u8; 512];
        let mut pending = String::new();

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match reader.read(&mut read_buf) {
                Ok(size) if size > 0 => {
                    pending.push_str(&String::from_utf8_lossy(&read_buf[..size]));
                    while let Some(index) = pending.find('\n') {
                        let raw = pending[..index].trim().to_string();
                        pending.drain(..=index);
                        if !raw.is_empty() {
                            emit_serial_line(&app_handle, raw);
                        }
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
                Err(error) => {
                    emit_serial_line(&app_handle, format!("ERR SERIAL_READ {error}"));
                    break;
                }
            }
        }
    });

    {
        let mut lock = state
            .session
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        stop_session_locked(&mut lock);
        *lock = Some(SerialSession {
            writer,
            stop_tx,
            port_name: port_name.clone(),
        });
    }

    Ok(ConnectionStatus {
        connected: true,
        port_name: Some(port_name),
    })
}

#[tauri::command]
fn disconnect_serial(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let mut lock = state
        .session
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    stop_session_locked(&mut lock);

    Ok(ConnectionStatus {
        connected: false,
        port_name: None,
    })
}

#[tauri::command]
fn get_connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let lock = state
        .session
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    if let Some(session) = &*lock {
        Ok(ConnectionStatus {
            connected: true,
            port_name: Some(session.port_name.clone()),
        })
    } else {
        Ok(ConnectionStatus {
            connected: false,
            port_name: None,
        })
    }
}

#[tauri::command]
fn send_serial_line(state: State<'_, AppState>, line: String) -> Result<(), String> {
    let lock = state
        .session
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    let Some(session) = &*lock else {
        return Err("No active serial connection".to_string());
    };

    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Serial writer lock poisoned".to_string())?;

    writer
        .write_all(format!("{}\n", line.trim()).as_bytes())
        .map_err(|error| format!("Serial write failed: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Serial flush failed: {error}"))?;

    Ok(())
}

#[tauri::command]
async fn orchestrator_status(orchestrator_base_url: String) -> Result<Value, String> {
    orchestrator_request(
        reqwest::Method::GET,
        orchestrator_base_url,
        "/status",
        None,
        None,
    )
    .await
}

#[tauri::command]
async fn orchestrator_execute_plan(
    orchestrator_base_url: String,
    plan: Value,
    correlation_id: Option<String>,
) -> Result<Value, String> {
    orchestrator_request(
        reqwest::Method::POST,
        orchestrator_base_url,
        "/execute_plan",
        Some(json!({ "plan": plan, "correlation_id": correlation_id.clone() })),
        correlation_id,
    )
    .await
}

#[tauri::command]
async fn orchestrator_stop(orchestrator_base_url: String) -> Result<Value, String> {
    orchestrator_request(
        reqwest::Method::POST,
        orchestrator_base_url,
        "/stop",
        Some(json!({})),
        None,
    )
    .await
}

#[tauri::command]
fn node_probe(host: String, port: u16) -> Result<NodeProbeStatus, String> {
    let target = format!("{}:{}", host.trim(), port);
    match probe_daemon_node(&host, port) {
        Ok(summary) => Ok(NodeProbeStatus {
            ok: true,
            host: host.trim().to_string(),
            port,
            target,
            device_name: summary.device_name,
            node_id: summary.node_id,
            tokens: summary.tokens,
            manifest: Some(summary.raw),
        }),
        Err(error) => Ok(NodeProbeStatus {
            ok: false,
            host: host.trim().to_string(),
            port,
            target,
            device_name: None,
            node_id: None,
            tokens: vec![],
            manifest: Some(json!({ "error": error })),
        }),
    }
}

#[tauri::command]
fn orchestrator_spawn(
    state: State<'_, AppState>,
    nodes: Vec<String>,
    http_port: Option<u16>,
    http_host: Option<String>,
    planner_url: Option<String>,
    step_timeout_s: Option<f64>,
) -> Result<OrchestratorProcessStatus, String> {
    let mut lock = state
        .orchestrator_proc
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;

    // If already running, return status.
    if let Some(proc_) = &mut *lock {
        if proc_
            .child
            .try_wait()
            .map_err(|e| format!("Failed to query orchestrator process: {e}"))?
            .is_none()
        {
            return Ok(OrchestratorProcessStatus {
                running: true,
                pid: Some(proc_.child.id()),
                http_base_url: Some(proc_.http_base_url.clone()),
                args: Some(proc_.args.clone()),
            });
        }
        // Child exited; clear and continue to respawn.
        *lock = None;
    }

    let http_port = http_port.unwrap_or(5055);
    let http_host = http_host.unwrap_or_else(|| "127.0.0.1".to_string());
    let repo_root = find_repo_root()?;
    let orch_path = repo_root.join("orchestrator").join("orchestrator.py");
    if !orch_path.exists() {
        return Err(format!(
            "orchestrator.py not found at {}",
            orch_path.display()
        ));
    }

    if nodes.is_empty() {
        return Err(
            "nodes must contain at least one entry like base=vporto26.local:8765".to_string(),
        );
    }

    let mut args: Vec<String> = Vec::new();
    args.push(orch_path.to_string_lossy().to_string());
    for node in &nodes {
        let trimmed = node.trim();
        if trimmed.is_empty() {
            continue;
        }
        args.push("--node".to_string());
        args.push(trimmed.to_string());
    }
    if let Some(url) = planner_url
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        args.push("--planner-url".to_string());
        args.push(url);
    }
    if let Some(step_timeout) = step_timeout_s {
        args.push("--step-timeout".to_string());
        args.push(format!("{step_timeout}"));
    }
    args.push("--http-host".to_string());
    args.push(http_host.clone());
    args.push("--http-port".to_string());
    args.push(http_port.to_string());

    let python3 = resolve_python3();
    let mut cmd = Command::new(python3);

    let log_path = repo_root.join(".build").join("orchestrator_desktop.log");
    let _ = std::fs::create_dir_all(repo_root.join(".build"));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| {
            format!(
                "Failed to open orchestrator log file {}: {e}",
                log_path.display()
            )
        })?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone log file handle: {e}"))?;

    cmd.args(&args)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn orchestrator: {e}"))?;

    let http_base_url = format!("http://{}:{}", http_host, http_port);
    *lock = Some(OrchestratorProcess {
        child,
        args,
        http_base_url: http_base_url.clone(),
    });

    Ok(OrchestratorProcessStatus {
        running: true,
        pid: lock.as_ref().map(|p| p.child.id()),
        http_base_url: Some(http_base_url),
        args: lock.as_ref().map(|p| p.args.clone()),
    })
}

#[tauri::command]
fn orchestrator_stop_process(
    state: State<'_, AppState>,
) -> Result<OrchestratorProcessStatus, String> {
    let mut lock = state
        .orchestrator_proc
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    stop_orchestrator_locked(&mut lock);
    Ok(OrchestratorProcessStatus {
        running: false,
        pid: None,
        http_base_url: None,
        args: None,
    })
}

#[tauri::command]
fn orchestrator_process_status(
    state: State<'_, AppState>,
) -> Result<OrchestratorProcessStatus, String> {
    let mut lock = state
        .orchestrator_proc
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    if let Some(proc_) = &mut *lock {
        match proc_.child.try_wait() {
            Ok(None) => Ok(OrchestratorProcessStatus {
                running: true,
                pid: Some(proc_.child.id()),
                http_base_url: Some(proc_.http_base_url.clone()),
                args: Some(proc_.args.clone()),
            }),
            Ok(Some(_)) => {
                *lock = None;
                Ok(OrchestratorProcessStatus {
                    running: false,
                    pid: None,
                    http_base_url: None,
                    args: None,
                })
            }
            Err(e) => Err(format!("Failed to query orchestrator process: {e}")),
        }
    } else {
        Ok(OrchestratorProcessStatus {
            running: false,
            pid: None,
            http_base_url: None,
            args: None,
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_serial,
            disconnect_serial,
            get_connection_status,
            send_serial_line,
            orchestrator_status,
            orchestrator_execute_plan,
            orchestrator_stop,
            vision_step_request,
            node_probe,
            write_debug_log,
            read_debug_log,
            read_desktop_audit_log,
            orchestrator_spawn,
            orchestrator_stop_process,
            orchestrator_process_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
