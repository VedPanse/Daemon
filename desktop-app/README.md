# DAEMON Desktop App

Tauri + React app with a deterministic live camera loop for blue-cube picking demos.

## Features
- Live webcam preview (`640x480`)
- Downscaled frame capture (`320x240`, JPEG quality `0.6`, ~`3.3 FPS`)
- Sends frames to `POST /api/vision_step`
- Forwards returned plan to local orchestrator `POST /execute_plan`
- Panic stop button wired to `POST /stop`
- UI panels for FSM state, perception/bbox overlay, debug metadata, and last plan

## Run
```bash
npm install
npm run tauri dev
```

## Config
- `VITE_VERCEL_BASE_URL` (default `https://daemon-ten-chi.vercel.app`)
- `VITE_ORCHESTRATOR_BASE_URL` (default `http://127.0.0.1:5055`)

## Build checks
```bash
npm run build
cd src-tauri
cargo check
```
