use dotenvy::from_path;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::Emitter;

const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamChatRequest {
    request_id: String,
    messages: Vec<ChatMessage>,
    model: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamEvent {
    request_id: String,
    kind: String,
    delta: Option<String>,
    error: Option<String>,
}

fn load_api_key() -> Result<String, String> {
    let current_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let mut env_path = PathBuf::from(&current_dir);

    if current_dir.ends_with("src-tauri") {
        env_path.pop();
    }

    env_path.pop();
    env_path.push(".env");

    if env_path.exists() {
        let _ = from_path(&env_path);
    }

    std::env::var("OPEN_AI_API_KEY")
        .or_else(|_| std::env::var("OPENAI_API_KEY"))
        .map_err(|_| {
            format!(
                "Missing OPEN_AI_API_KEY in {}",
                env_path.to_string_lossy()
            )
        })
}

fn parse_delta(data: &str) -> Option<String> {
    let json: Value = serde_json::from_str(data).ok()?;
    let content = json
        .get("choices")?
        .as_array()?
        .first()?
        .get("delta")?
        .get("content")?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    if let Some(chunks) = content.as_array() {
        let joined = chunks
            .iter()
            .filter_map(|chunk| chunk.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");

        if !joined.is_empty() {
            return Some(joined);
        }
    }

    None
}

#[tauri::command]
async fn stream_chat(app: tauri::AppHandle, request: StreamChatRequest) -> Result<(), String> {
    if request.messages.is_empty() {
        return Err("At least one message is required".to_string());
    }

    let api_key = load_api_key()?;
    let event_channel = "chat_stream_event";
    let request_id = request.request_id.clone();
    let model = request
        .model
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    let body = serde_json::json!({
      "model": model,
      "stream": true,
      "messages": request.messages
    });

    let client = reqwest::Client::new();
    let response = client
        .post(OPENAI_URL)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown OpenAI error".to_string());
        return Err(format!("OpenAI request failed ({status}): {error_body}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|error| error.to_string())?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(boundary_index) = buffer.find('\n') {
            let mut line = buffer[..boundary_index].trim().to_string();
            buffer.drain(..=boundary_index);

            if line.is_empty() {
                continue;
            }

            if let Some(stripped) = line.strip_prefix("data:") {
                line = stripped.trim().to_string();
            }

            if line == "[DONE]" {
                let _ = app.emit(
                    event_channel,
                    StreamEvent {
                        request_id: request_id.clone(),
                        kind: "done".to_string(),
                        delta: None,
                        error: None,
                    },
                );
                return Ok(());
            }

            if let Some(delta) = parse_delta(&line) {
                let _ = app.emit(
                    event_channel,
                    StreamEvent {
                        request_id: request_id.clone(),
                        kind: "delta".to_string(),
                        delta: Some(delta),
                        error: None,
                    },
                );
            }
        }
    }

    let _ = app.emit(
        event_channel,
        StreamEvent {
            request_id,
            kind: "done".to_string(),
            delta: None,
            error: None,
        },
    );

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![stream_chat])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
