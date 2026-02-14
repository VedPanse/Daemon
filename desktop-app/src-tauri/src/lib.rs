use serde::Serialize;
use serialport::SerialPort;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const SERIAL_EVENT: &str = "serial_line";

#[derive(Clone)]
struct SerialSession {
    writer: Arc<Mutex<Box<dyn SerialPort + Send>>>,
    stop_tx: mpsc::Sender<()>,
    port_name: String,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<SerialSession>>,
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
            send_serial_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
