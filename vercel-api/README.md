# DAEMON Vercel API

This project is the deploy target for DAEMON cloud endpoints. It includes:
- `POST /api/plan` and `POST /plan` for orchestrator planning
- `POST /api/vision_step` for deterministic instruction-driven servo control
- `POST /api/v1/daemon-configs/ingest` for CLI publish ingest
- `GET /api/health` for service health checks

## Run locally

```bash
npm install
npm run dev
```

Local base URL: `http://localhost:3000`

## Environment variables

All are optional for MVP:

- `DAEMON_PUBLISH_API_KEY`
  - If set, `POST /api/v1/daemon-configs/ingest` requires:
  - `Authorization: Bearer <DAEMON_PUBLISH_API_KEY>`
- `BLOB_READ_WRITE_TOKEN`
  - If set, ingest artifacts are persisted to Vercel Blob
  - If missing, ingest still returns success without persistence
- `OPENAI_API_KEY`
  - If set, `/api/vision_step` uses OpenAI vision for open-vocabulary object detection
- `OPENAI_VISION_MODEL`
  - Optional model override for vision perception (default `gpt-4.1-mini`)

## Planner endpoint

- `POST /api/plan`
- `POST /plan` (rewrite to `/api/plan`)

## Vision endpoint (deterministic, no RL)

- `POST /api/vision_step`
- Input:
  - `frame_jpeg_base64`
  - `instruction`
  - `state` (FSM persisted by caller)
  - optional `system_manifest`, `telemetry_snapshot`
- Output:
  - updated `state`
  - `perception` (`objects[]`, `selected_target`, `summary`, plus compatibility fields `found`, `bbox`, `area`, `offset_x`, `center_offset_x`, `confidence`)
  - short `plan` for `base`/`arm` (`RUN` + `STOP`)
  - `debug`
- Task parsing:
  - Deterministic instruction router (`stop`, `move-pattern`, `pick-object`, `follow`, `search`, `avoid+approach`)
  - Instruction hash reset (`state.instruction_ctx.hash`) for immediate behavior changes

## Example request

```bash
curl -X POST http://localhost:3000/api/plan \
  -H "Content-Type: application/json" \
  -d '{
    "instruction": "forward then close gripper",
    "system_manifest": {
      "daemon_version": "0.1",
      "nodes": [
        {
          "name": "base",
          "node_id": "node-base-1",
          "commands": [
            { "token": "FWD", "args": [{ "type": "number", "min": 0, "max": 1 }] },
            { "token": "BWD", "args": [{ "type": "number", "min": 0, "max": 1 }] },
            { "token": "TURN", "args": [{ "type": "number", "min": -180, "max": 180 }] },
            { "token": "L", "args": [{ "type": "number", "min": 0, "max": 1000 }] }
          ],
          "telemetry": {}
        },
        {
          "name": "arm",
          "node_id": "node-arm-1",
          "commands": [
            { "token": "GRIP", "args": [{ "type": "string", "enum": ["open", "close"] }] },
            { "token": "HOME", "args": [] }
          ],
          "telemetry": {}
        }
      ]
    },
    "telemetry_snapshot": {
      "base": { "uptime_ms": 123, "last_token": "NONE" },
      "arm": { "uptime_ms": 456, "last_token": "NONE" }
    }
  }'
```

## Example success response

```json
{
  "plan": [
    { "type": "RUN", "target": "base", "token": "FWD", "args": [0.6], "duration_ms": 1200 },
    { "type": "RUN", "target": "arm", "token": "GRIP", "args": ["close"] },
    { "type": "STOP" }
  ],
  "explanation": "Move forward, then close gripper, then stop."
}
```

## Validation failure shape

```json
{
  "error": "VALIDATION_ERROR",
  "message": "RUN step token does not exist in target node command catalog.",
  "details": {}
}
```

## CLI ingest endpoint

- `POST /api/v1/daemon-configs/ingest`
- `GET /api/health`

Example health check:

```bash
curl http://localhost:3000/api/health
```

Example ingest request:

```bash
curl -X POST http://localhost:3000/api/v1/daemon-configs/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "config_id": "rc_car_pi_arduino",
    "manifest": { "profile": "rc_car_pi_arduino", "version": "0.1" },
    "artifacts": {
      "DAEMON.yaml": "name: rc_car_pi_arduino\n",
      "daemon_entry.c": "int main(void){return 0;}\n"
    }
  }'
```

If auth is enabled:

```bash
curl -X POST http://localhost:3000/api/v1/daemon-configs/ingest \
  -H "Authorization: Bearer $DAEMON_PUBLISH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## Vercel deployment

Set Vercel project root directory to `vercel-api`.
