# Daemon

Root-level setup scripts for installing Rust + Tauri CLI are included for both macOS and Windows.

## Project layout

- `desktop-app/`: Tauri + React desktop app
- `daemon-cli/`: Firmware generation CLI (`daemon build`, `daemon publish`, `daemon init-samples`)
- `setup-macos.sh`: macOS installer/bootstrap script
- `setup-windows.ps1`: Windows installer/bootstrap script
- `.build/installed-tools.log`: install history written by setup scripts

## Quick start

### macOS

```bash
chmod +x setup-macos.sh
./setup-macos.sh
```

### Windows (PowerShell)

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup-windows.ps1
```

## What the setup scripts install

- Rust toolchain (via `rustup`, stable channel)
- Tauri CLI (via `cargo install tauri-cli --locked`)

Both scripts append installed/verified versions to `.build/installed-tools.log`.

## Run the desktop app after setup

```bash
cd desktop-app
npm install
npm run tauri dev
```

## Notes

- macOS script attempts to install Xcode Command Line Tools if missing.
- Windows script uses `winget` for Rust bootstrap when `rustup` is missing.
- See `daemon-cli/readme.txt` for the firmware config generation + API publish workflow.
