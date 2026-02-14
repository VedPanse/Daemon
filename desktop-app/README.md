# DAEMON Desktop App (MVP)

Tauri + React desktop app for DAEMON-enabled devices.

## Features
- Enumerate serial ports
- Connect/disconnect to a selected port
- Send `HELLO` and `READ_MANIFEST`
- Parse and display DAEMON command catalog from `MANIFEST ...`
- Chat input with rule-based planner constrained to manifest commands
- Execute `RUN <TOKEN> <args>` and `STOP`
- Show `OK`/`ERR` responses and live `TELEMETRY ...` stream

## Run
```bash
npm install
npm run tauri dev
```

## Build checks
```bash
npm run build
cd src-tauri
cargo check
```
