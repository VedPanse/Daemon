# Blue Cube Demo Runbook (Deterministic, No RL)

## Why no RL for this demo
- RL is data-hungry and brittle under hackathon-time constraints.
- Deterministic color-based servoing plus a finite state machine is faster to tune, transparent, and repeatable.
- Online threshold tuning and explicit state transitions are easier to debug live during judging.

## 1) Start robot nodes (or emulators)
Use either real Raspberry Pi-connected nodes or local emulators exposing:
- base: `FWD`, `TURN`
- arm: `GRIP`

## 2) Start orchestrator HTTP bridge on localhost:5055
```bash
python3 orchestrator/orchestrator.py \
  --node base=127.0.0.1:7777 \
  --node arm=127.0.0.1:7778 \
  --http-host 127.0.0.1 \
  --http-port 5055
```

## 3) Start Vercel API locally (optional) or use deployed URL
```bash
cd vercel-api
npm install
npm run dev
```

## 4) Start desktop app
```bash
cd desktop-app
npm install
npm run tauri dev
```

Optional env vars:
- `VITE_VERCEL_BASE_URL` (default `https://daemon-ten-chi.vercel.app`)
- `VITE_ORCHESTRATOR_BASE_URL` (default `http://127.0.0.1:5055`)

## 5) Run live pick loop
- Place multiple cubes in view including a blue cube.
- Click `Enable Live Camera`.
- Observe FSM transitions: `SEARCH -> ALIGN -> APPROACH -> FINAL_ALIGN -> GRAB -> DONE`.
- Use `STOP` anytime for panic stop (`/stop`).
