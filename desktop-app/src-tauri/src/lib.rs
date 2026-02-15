use serde::Serialize;
use serde_json::{json, Value};
use serialport::SerialPort;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::{fs::OpenOptions};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const SERIAL_EVENT: &str = "serial_line";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CriticStatus {
    running: bool,
    task: Option<String>,
    model: Option<String>,
    success_streak: u32,
    success_n: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CriticStepResult {
    reward: f64,
    success: bool,
    success_confidence: f64,
    success_streak: u32,
    success_stable: bool,
    critical_failure: bool,
    critical_failure_reason: String,
    failure_modes: Vec<String>,
    describe: String,
    evaluate: String,
    notes_short: String,
    interrupt_sent: bool,
    raw: Value,
}

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
    critic_session: Mutex<Option<CriticSession>>,
}

#[derive(Clone)]
struct CriticSession {
    orchestrator_base_url: String,
    task: String,
    model: String,
    success_streak: u32,
    success_n: u32,
    conf_threshold: f64,
    reward_threshold: f64,
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
        return Err("base_url is empty".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_local_host(raw: &str) -> Result<IpAddr, String> {
    let trimmed = raw.trim();
    let normalized = if trimmed.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        trimmed
    };
    normalized
        .parse::<IpAddr>()
        .map_err(|_| format!("http_host must be an IP address (e.g. 127.0.0.1), got: {trimmed}"))
}

fn pick_free_tcp_port(host: IpAddr, preferred: u16) -> Result<u16, String> {
    let preferred_addr = SocketAddr::new(host, preferred);
    if let Ok(listener) = TcpListener::bind(preferred_addr) {
        drop(listener);
        return Ok(preferred);
    }

    let listener = TcpListener::bind(SocketAddr::new(host, 0))
        .map_err(|e| format!("Failed to bind ephemeral port on {host}: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read ephemeral port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_tcp_listen(host: IpAddr, port: u16, child: &mut Child, timeout: Duration) -> Result<(), String> {
    let addr = SocketAddr::new(host, port);
    let start = std::time::Instant::now();

    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Orchestrator exited early with status {status}"));
        }

        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }

        if start.elapsed() >= timeout {
            return Err(format!("Timed out waiting for orchestrator to listen on {addr}"));
        }

        thread::sleep(Duration::from_millis(80));
    }
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
    for candidate in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
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
    let mut file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
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

fn openai_api_key() -> Option<String> {
    // Tauri GUI apps on macOS may not inherit shell env; but if launched via terminal it will.
    // We keep this minimal: rely on OPENAI_API_KEY existing in the app environment.
    std::env::var("OPENAI_API_KEY").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn extract_first_text_field(resp: &Value) -> Option<String> {
    // Best-effort: Responses API returns content under output[].content[].text.
    // We scan for the first string "text" leaf.
    fn walk(v: &Value) -> Option<String> {
        match v {
            Value::Object(map) => {
                if let Some(Value::String(s)) = map.get("text") {
                    if !s.trim().is_empty() {
                        return Some(s.clone());
                    }
                }
                for (_k, child) in map.iter() {
                    if let Some(found) = walk(child) {
                        return Some(found);
                    }
                }
                None
            }
            Value::Array(arr) => {
                for child in arr {
                    if let Some(found) = walk(child) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }
    walk(resp)
}

fn extract_output_text(resp: &Value) -> Option<String> {
    // Prefer well-known Responses API fields.
    if let Some(Value::String(s)) = resp.get("output_text") {
        if !s.trim().is_empty() {
            return Some(s.clone());
        }
    }
    // Fall back to scanning for the first "text" field.
    extract_first_text_field(resp)
}

fn clamp_f64(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
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
    std::fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Failed to create logs directory {}: {e}", logs_dir.display()))?;
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
    writeln!(file, "{}", line)
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
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
                "error": msg
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
            "body": trunc_for_log(&response_text, 8000)
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

async fn vision_request(
    method: reqwest::Method,
    vision_base_url: String,
    path: &str,
    body: Option<Value>,
    correlation_id: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&vision_base_url)?;
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
        "vision.request",
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
            "vision.network_error",
            &json!({
                "method": method.to_string(),
                "url": url.clone(),
                "error": msg
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
        "vision.response",
        &json!({
            "method": method.to_string(),
            "url": url.clone(),
            "status": status.as_u16(),
            "body": trunc_for_log(&response_text, 8000)
        }),
    );

    if !status.is_success() {
        return Err(format!(
            "{method} {url} failed: HTTP {} body={}",
            status.as_u16(),
            trunc_for_log(&response_text, 3000),
        ));
    }

    serde_json::from_str::<Value>(&response_text).map_err(|error| {
        format!("{method} {url} failed: invalid JSON response: {error}; body={response_text}")
    })
}

fn build_critic_system_prompt(task: &str) -> String {
    // Keep it strict and conservative: fail closed if uncertain.
    // We do not request hidden reasoning; we only need the structured fields.
    format!(
        "You are a Vision-Language Reward Critic for a physical RC robot.\n\
Your job: evaluate the current camera frame against the user's task goal and produce a reward signal.\n\
\n\
You may be given multiple frames (ordered oldest -> newest). Use them to infer motion and progress.\n\
\n\
Output rules:\n\
- Return ONLY strict JSON that matches the provided schema.\n\
- Be conservative: if uncertain, success=false and success_confidence<=0.5.\n\
- Never claim success unless the goal is visually confirmed in the frame.\n\
\n\
Progress guidance:\n\
- If you can see the robot moved in the intended direction between frames, reward should be positive (even if not yet complete).\n\
- If you can see the robot moved in the wrong direction or did the opposite action, reward should be negative.\n\
\n\
Reward rules:\n\
- reward in [-1.0, 1.0].\n\
- +1.0 only when the task is clearly completed.\n\
- 0.0 when no clear progress or unclear.\n\
- negative when the robot regresses, interacts with the wrong object, or is unsafe.\n\
\n\
Safety rules:\n\
- If imminent collision risk, falling risk, or leaving camera view: critical_failure=true.\n\
\n\
TASK: {task}\n"
    )
}

async fn openai_critic_eval(
    model: &str,
    task: &str,
    frames_jpeg_base64: &[String],
    last_action_text: Option<&str>,
    executed_plan: Option<&Value>,
    correlation_id: Option<&str>,
) -> Result<Value, String> {
    let api_key = openai_api_key().ok_or_else(|| "OPENAI_API_KEY missing in app environment".to_string())?;
    let sys = build_critic_system_prompt(task);
    let mut user_lines = vec![
        format!("Goal: {task}"),
        "You will receive multiple frames in time order (oldest -> newest). Use them to detect motion and progress.".to_string(),
    ];
    if let Some(a) = last_action_text {
        let a = a.trim();
        if !a.is_empty() {
            user_lines.push(format!("Last action: {a}"));
        }
    }
    if let Some(plan) = executed_plan {
        // Keep it compact; tool output remains the source of truth.
        let plan_short = trunc_for_log(&plan.to_string(), 800);
        user_lines.push(format!("Executed plan (json): {plan_short}"));
    }
    user_lines.push("If robot/target is not clearly visible, do not claim success.".to_string());
    let user_text = user_lines.join("\n");

    // JSON schema for strict structured output.
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "describe": { "type": "string" },
            "evaluate": { "type": "string" },
            "reward": { "type": "number", "minimum": -1.0, "maximum": 1.0 },
            "success": { "type": "boolean" },
            "success_confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
            "critical_failure": { "type": "boolean" },
            "critical_failure_reason": { "type": "string" },
            "failure_modes": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["not_visible","target_not_visible","wrong_object","no_progress","regressing","collision_risk","edge_of_view","uncertain"]
                }
            },
            "notes_short": { "type": "string" }
        },
        "required": ["describe","evaluate","reward","success","success_confidence","critical_failure","critical_failure_reason","failure_modes","notes_short"]
    });

    let frames = frames_jpeg_base64
        .iter()
        .filter(|s| !s.trim().is_empty())
        .take(4)
        .cloned()
        .collect::<Vec<_>>();
    if frames.is_empty() {
        return Err("critic_step requires at least 1 frame".to_string());
    }

    let mut user_content: Vec<Value> = Vec::new();
    user_content.push(json!({ "type": "input_text", "text": user_text }));
    for (idx, b64) in frames.iter().enumerate() {
        // Tiny caption helps the model interpret ordering.
        user_content.push(json!({ "type": "input_text", "text": format!("frame_t{idx}") }));
        user_content.push(json!({ "type": "input_image", "image_url": format!("data:image/jpeg;base64,{b64}") }));
    }
    let body = json!({
        "model": model,
        "temperature": 0,
        "max_output_tokens": 350,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "critic_reward",
                "schema": schema,
                "strict": true
            }
        },
        "input": [
            { "role": "system", "content": [{ "type": "input_text", "text": sys }] },
            { "role": "user", "content": user_content }
        ],
        "metadata": {
            "correlation_id": correlation_id,
            "ts_ms": unix_ts_ms().to_string()
        }
    });

    append_desktop_audit_log("openai.critic.request", &json!({ "model": model, "task": task, "cid": correlation_id }));

    let client = reqwest::Client::new();
    let resp = client
        .post(OPENAI_RESPONSES_URL)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("OpenAI read body failed: {e}"))?;
    if !status.is_success() {
        append_desktop_audit_log("openai.critic.http_error", &json!({ "status": status.as_u16(), "body": trunc_for_log(&text, 2000) }));
        return Err(format!("OpenAI HTTP {}: {}", status.as_u16(), trunc_for_log(&text, 1200)));
    }

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("OpenAI invalid JSON: {e}; body={}", trunc_for_log(&text, 1200)))?;

    // With json_schema, the model output should be valid JSON text.
    if let Some(out_text) = extract_output_text(&parsed) {
        if let Ok(v) = serde_json::from_str::<Value>(&out_text) {
            append_desktop_audit_log("openai.critic.ok", &json!({ "cid": correlation_id, "out": v }));
            return Ok(v);
        }
    }

    // Fallback: if the provider ever returns already-parsed JSON in a field, return the whole response.
    append_desktop_audit_log("openai.critic.parse_failed", &json!({ "cid": correlation_id, "body": trunc_for_log(&text, 1200) }));
    Err("OpenAI critic response parse failed (no JSON tool output found)".to_string())
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
        let mut lock = state.session.lock().map_err(|_| "State lock poisoned".to_string())?;
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
    let mut lock = state.session.lock().map_err(|_| "State lock poisoned".to_string())?;
    stop_session_locked(&mut lock);

    Ok(ConnectionStatus {
        connected: false,
        port_name: None,
    })
}

#[tauri::command]
fn get_connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, String> {
    let lock = state.session.lock().map_err(|_| "State lock poisoned".to_string())?;
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
    let lock = state.session.lock().map_err(|_| "State lock poisoned".to_string())?;
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
    orchestrator_request(reqwest::Method::GET, orchestrator_base_url, "/status", None, None).await
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
async fn vision_step(
    vision_base_url: String,
    path: Option<String>,
    payload: Value,
    correlation_id: Option<String>,
) -> Result<Value, String> {
    let path = path
        .map(|raw| raw.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/api/vision_step".to_string());
    if !path.starts_with('/') {
        return Err(format!("vision_step path must start with '/', got: {path}"));
    }
    vision_request(
        reqwest::Method::POST,
        vision_base_url,
        &path,
        Some(payload),
        correlation_id,
    )
    .await
}

#[tauri::command]
fn critic_spawn(
    state: State<'_, AppState>,
    orchestrator_base_url: String,
    task: String,
    model: Option<String>,
    success_consecutive_frames: Option<u32>,
    success_confidence_threshold: Option<f64>,
    success_reward_threshold: Option<f64>,
) -> Result<CriticStatus, String> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("task is empty".to_string());
    }

    let mut lock = state
        .critic_session
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;

    *lock = Some(CriticSession {
        orchestrator_base_url: orchestrator_base_url.trim().to_string(),
        task: task.clone(),
        model: model.unwrap_or_else(|| "gpt-4.1-mini".to_string()),
        success_streak: 0,
        success_n: success_consecutive_frames.unwrap_or(3).max(1),
        conf_threshold: success_confidence_threshold.unwrap_or(0.9),
        reward_threshold: success_reward_threshold.unwrap_or(0.9),
    });

    Ok(CriticStatus {
        running: true,
        task: Some(task),
        model: lock.as_ref().map(|s| s.model.clone()),
        success_streak: 0,
        success_n: lock.as_ref().map(|s| s.success_n).unwrap_or(3),
    })
}

#[tauri::command]
fn critic_status(state: State<'_, AppState>) -> Result<CriticStatus, String> {
    let lock = state
        .critic_session
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    if let Some(s) = &*lock {
        Ok(CriticStatus {
            running: true,
            task: Some(s.task.clone()),
            model: Some(s.model.clone()),
            success_streak: s.success_streak,
            success_n: s.success_n,
        })
    } else {
        Ok(CriticStatus {
            running: false,
            task: None,
            model: None,
            success_streak: 0,
            success_n: 3,
        })
    }
}

#[tauri::command]
async fn critic_step(
    state: State<'_, AppState>,
    frames_jpeg_base64: Vec<String>,
    last_action_text: Option<String>,
    executed_plan: Option<Value>,
    task_override: Option<String>,
    correlation_id: Option<String>,
) -> Result<CriticStepResult, String> {
    // Snapshot config without holding the mutex across await (tauri commands require Send futures).
    let (orch_url, task, model, conf_th, reward_th, success_n) = {
        let lock = state
            .critic_session
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        let Some(sess) = &*lock else {
            return Err("Critic not running. Click Start Critic first.".to_string());
        };
        (
            sess.orchestrator_base_url.clone(),
            sess.task.clone(),
            sess.model.clone(),
            sess.conf_threshold,
            sess.reward_threshold,
            sess.success_n,
        )
    };

    let cid = correlation_id.clone().unwrap_or_else(|| format!("ui-{}", unix_ts_ms()));
    let task_to_use = task_override.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(task.as_str());
    let raw = openai_critic_eval(
        &model,
        task_to_use,
        &frames_jpeg_base64,
        last_action_text.as_deref(),
        executed_plan.as_ref(),
        Some(&cid),
    )
    .await?;

    let reward = clamp_f64(raw.get("reward").and_then(|v| v.as_f64()).unwrap_or(0.0), -1.0, 1.0);
    let success = raw.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    let conf = clamp_f64(raw.get("success_confidence").and_then(|v| v.as_f64()).unwrap_or(0.0), 0.0, 1.0);
    let critical = raw.get("critical_failure").and_then(|v| v.as_bool()).unwrap_or(false);
    let critical_reason = raw
        .get("critical_failure_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let failure_modes = raw
        .get("failure_modes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
        .unwrap_or_else(|| vec!["uncertain".to_string()]);

    let success_this_frame = success && conf >= conf_th && reward >= reward_th;

    // Update streak under lock (no await).
    let (streak, stable) = {
        let mut lock = state
            .critic_session
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        let Some(sess) = &mut *lock else {
            return Err("Critic stopped while step was in-flight.".to_string());
        };
        // Keep session task in sync if the UI changes prompt mid-run.
        if let Some(t) = task_override.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            sess.task = t;
        }
        sess.success_streak = if success_this_frame { sess.success_streak + 1 } else { 0 };
        (sess.success_streak, sess.success_streak >= success_n)
    };

    let mut interrupt_sent = false;
    if critical {
        // Hard safety stop (best-effort).
        let _ = orchestrator_stop(orch_url).await;
        interrupt_sent = true;
    }

    Ok(CriticStepResult {
        reward,
        success,
        success_confidence: conf,
        success_streak: streak,
        success_stable: stable,
        critical_failure: critical,
        critical_failure_reason: critical_reason,
        failure_modes,
        describe: raw.get("describe").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        evaluate: raw.get("evaluate").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        notes_short: raw.get("notes_short").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        interrupt_sent,
        raw,
    })
}

#[tauri::command]
fn critic_stop(state: State<'_, AppState>) -> Result<CriticStatus, String> {
    let mut lock = state
        .critic_session
        .lock()
        .map_err(|_| "State lock poisoned".to_string())?;
    *lock = None;
    Ok(CriticStatus {
        running: false,
        task: None,
        model: None,
        success_streak: 0,
        success_n: 3,
    })
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
async fn orchestrator_spawn(
    state: State<'_, AppState>,
    nodes: Vec<String>,
    http_port: Option<u16>,
    http_host: Option<String>,
    planner_url: Option<String>,
    step_timeout_s: Option<f64>,
) -> Result<OrchestratorProcessStatus, String> {
    // Snapshot/clear state without holding the mutex across awaits.
    {
        let mut lock = state
            .orchestrator_proc
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;

        // If already running, return status.
        if let Some(proc_) = &mut *lock {
            if proc_.child.try_wait().map_err(|e| format!("Failed to query orchestrator process: {e}"))?.is_none() {
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
    }

    let http_host_raw = http_host.unwrap_or_else(|| "127.0.0.1".to_string());
    let http_host_ip = normalize_local_host(&http_host_raw)?;
    let preferred_port = http_port.unwrap_or(5055);

    // If something is already listening on the preferred port, check if it's already a DAEMON orchestrator.
    // If so, reuse it instead of spawning a second orchestrator on an ephemeral port.
    {
        let base = format!("http://{}:{}", http_host_raw.trim(), preferred_port);
        let url = format!("{base}/status");
        let client = reqwest::Client::new();
        let resp = client
            .get(&url)
            .timeout(Duration::from_millis(400))
            .send()
            .await;
        if let Ok(r) = resp {
            if r.status().is_success() {
                if let Ok(v) = r.json::<Value>().await {
                    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                        append_desktop_audit_log("orchestrator.reuse_existing", &json!({ "base_url": base, "status": v }));
                        return Ok(OrchestratorProcessStatus {
                            running: false,
                            pid: None,
                            http_base_url: Some(base),
                            args: None,
                        });
                    }
                }
            }
        }
    }

    // Re-check state (another call may have spawned while we were probing).
    {
        let mut lock = state
            .orchestrator_proc
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
        if let Some(proc_) = &mut *lock {
            if proc_.child.try_wait().map_err(|e| format!("Failed to query orchestrator process: {e}"))?.is_none() {
                return Ok(OrchestratorProcessStatus {
                    running: true,
                    pid: Some(proc_.child.id()),
                    http_base_url: Some(proc_.http_base_url.clone()),
                    args: Some(proc_.args.clone()),
                });
            }
            *lock = None;
        }
    }

    let http_port = pick_free_tcp_port(http_host_ip, preferred_port)?;
    let repo_root = find_repo_root()?;
    let orch_path = repo_root.join("orchestrator").join("orchestrator.py");
    if !orch_path.exists() {
        return Err(format!(
            "orchestrator.py not found at {}",
            orch_path.display()
        ));
    }

    if nodes.is_empty() {
        return Err("nodes must contain at least one entry like base=vporto26.local:8765".to_string());
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
    if let Some(url) = planner_url.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        args.push("--planner-url".to_string());
        args.push(url);
    }
    if let Some(step_timeout) = step_timeout_s {
        args.push("--step-timeout".to_string());
        args.push(format!("{step_timeout}"));
    }
    args.push("--http-host".to_string());
    args.push(http_host_raw.trim().to_string());
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
        .map_err(|e| format!("Failed to open orchestrator log file {}: {e}", log_path.display()))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("Failed to clone log file handle: {e}"))?;

    cmd.args(&args)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn orchestrator: {e}"))?;
    // orchestrator.py connects to nodes before it starts the HTTP bridge, and each node connect
    // can take a couple seconds (DNS + TCP timeout). Give it enough time to come up.
    wait_for_tcp_listen(http_host_ip, http_port, &mut child, Duration::from_secs(12))
        .map_err(|e| format!("{e}. If a previous orchestrator is running, stop it or use a different port."))?;

    let http_base_url = format!("http://{}:{}", http_host_raw.trim(), http_port);
    {
        let mut lock = state
            .orchestrator_proc
            .lock()
            .map_err(|_| "State lock poisoned".to_string())?;
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
}

#[tauri::command]
fn orchestrator_stop_process(state: State<'_, AppState>) -> Result<OrchestratorProcessStatus, String> {
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
fn orchestrator_process_status(state: State<'_, AppState>) -> Result<OrchestratorProcessStatus, String> {
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
            vision_step,
            critic_spawn,
            critic_status,
            critic_step,
            critic_stop,
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
