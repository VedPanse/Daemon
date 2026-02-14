# DAEMON Desktop App

Tauri + React control surface for natural-language robot tasks with live camera-assisted execution.

## What the app does
- Accepts a free-form task prompt from the operator.
- Captures low-FPS camera frames and sends them to `POST /api/vision_step`.
- Forwards returned plans to orchestrator through Rust proxy commands.
- Supports:
  - Live loop mode
  - Single-step mode
  - Dry-run mode (plan generation without execution)

## Why orchestrator calls are proxied through Rust
WebView networking can block direct localhost calls (`TypeError: Load failed`).
React calls Tauri commands, and Rust performs localhost HTTP requests to:
- `GET /status`
- `POST /execute_plan`
- `POST /stop`

## Important capability note
This desktop app now sends the user prompt dynamically (no hardcoded prompt in UI flow).
The vision policy is instruction-conditioned: each frame sends the current prompt to `/api/vision_step` and behavior updates when the prompt changes.

## Run
```bash
npm install
npm run tauri dev
```

## One-command local demo
From repo root:
```bash
bash desktop-app/run.sh
```

This starts:
- base emulator (`127.0.0.1:7777`)
- arm emulator (`127.0.0.1:7778`)
- orchestrator bridge (`127.0.0.1:5055`)
- desktop app (`npm run tauri dev`)

## Config
- `VITE_VERCEL_BASE_URL` (default `https://daemon-ten-chi.vercel.app`)
- `VITE_ORCHESTRATOR_BASE_URL` (default `http://127.0.0.1:5055`)

## Sleepy Test
1. Confirm orchestrator:
```bash
curl http://127.0.0.1:5055/status
```
2. Run app (`npm run tauri dev` or `bash desktop-app/run.sh`).
3. Click `Enable Live Camera`.
4. Click `STOP`; expect `STOP OK` or a clear Rust proxy error string.

## Build checks
```bash
npm run build
cd src-tauri
cargo check
```
