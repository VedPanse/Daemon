# TROUBLESHOOT.md

Common DAEMON failure symptoms and the fastest commands to diagnose/fix them.

## Quick Health Checklist

1) Orchestrator reachable?
```bash
curl -s http://127.0.0.1:5055/status | python3 -m json.tool
```

2) Is `base` connected to the right host/port (Pi vs emulators)?
- Real Pi node typically: `host: vporto26.local` (or a Pi IP), `port: 8766` (or similar)
- Emulators typically: `host: 127.0.0.1`, `port: 7777/7778`

3) Hard motor test (bypass vision/UI):
```bash
curl -sS http://127.0.0.1:5055/execute_plan \
  -H 'Content-Type: application/json' \
  -d '{"plan":[{"type":"RUN","target":"base","token":"MECANUM","args":["F"],"duration_ms":1200},{"type":"STOP"}]}'
```

If `MECANUM` is not in `/status` for the base node, you are not connected to the mecanum Pi node.

## Symptom: “Address already in use” / Orchestrator fails to start

Example:
- `OSError: [Errno 48] Address already in use`
- `Timed out waiting for orchestrator to listen on 127.0.0.1:<port>`

Fix (kill the existing listener, then restart):
```bash
lsof -tiTCP:5055 -sTCP:LISTEN | xargs -r kill
```

Verify it is gone:
```bash
lsof -nP -iTCP:5055 -sTCP:LISTEN || true
```

Start orchestrator again (example for Pi base node):
```bash
python3 orchestrator/orchestrator.py \
  --node base=vporto26.local:8766 \
  --http-host 127.0.0.1 \
  --http-port 5055 \
  --telemetry
```

## Symptom: Desktop app says plan executed, but robot does not move

Most common cause: the desktop app is connected to an orchestrator that is controlling local emulators.

Confirm what orchestrator you are talking to:
```bash
curl -s http://127.0.0.1:5055/status | python3 -m json.tool
```

If you see:
- `host: 127.0.0.1 port: 7777/7778`
then you are running emulators, not real hardware.

Fix:
1) Stop emulator stack (ports 5055/7777/7778).
```bash
lsof -tiTCP:5055 -sTCP:LISTEN | xargs -r kill
lsof -tiTCP:7777 -sTCP:LISTEN | xargs -r kill
lsof -tiTCP:7778 -sTCP:LISTEN | xargs -r kill
```

2) Start real orchestrator pointing at the Pi node (8766/8767 etc).

## Symptom: `/execute_plan` returns HTTP 400 “base: not connected; panic STOP sent”

Meaning: orchestrator received a plan, but the socket to the `base` node was disconnected at runtime.

Fix:
1) Check connection state:
```bash
curl -s http://127.0.0.1:5055/status | python3 -m json.tool
```

2) Restart orchestrator:
```bash
lsof -tiTCP:5055 -sTCP:LISTEN | xargs -r kill
python3 orchestrator/orchestrator.py --node base=vporto26.local:8766 --http-port 5055 --telemetry
```

3) If it keeps happening: network/Pi node is dropping. See “Network drops” and “Pi node restart”.

## Symptom: Desktop app errors like “Tauri proxy POST ... failed” / “TypeError: Load failed”

Meaning: the UI attempted to call orchestrator or the vision endpoint, and the underlying WebView networking failed or got a non-200.

Fix:
1) Confirm orchestrator is reachable:
```bash
curl -s http://127.0.0.1:5055/status >/dev/null && echo OK
```

2) If `/execute_plan` returns 400, read the `error` string in the response. It is the real cause.

3) Restart the desktop app after restarting orchestrator (the UI can get “stuck” on stale state).

## Symptom: “step[0] token 'X' not found on node 'base'”

Meaning: your plan references a token not present in the connected base node manifest.

Fix:
1) Inspect the base node tokens:
```bash
curl -s http://127.0.0.1:5055/status | python3 - <<'PY'
import json,sys
d=json.load(sys.stdin)
for n in d.get("nodes",[]):
  if n.get("alias")=="base":
    print("base host:", n.get("host"), "port:", n.get("port"))
    print("base tokens:", n.get("commands"))
PY
```

2) If the tokens are missing (e.g. `MECANUM` absent), you are likely connected to the wrong node (emulator vs Pi base node).

## Symptom: Pi base node reachable sometimes, then timeouts / `.local` flakiness

Meaning: mDNS (`.local`) or network is unreliable.

Fix:
1) Prefer a stable IPv4 address instead of `.local`:
```bash
# on the Pi
hostname -I
```
Then use `--node base=<PI_IP>:8766` on the laptop.

2) If using Ethernet, physically reseat the cable and confirm link lights.

3) If Wi-Fi, reduce latency/jitter (closer AP, avoid hotspots).

## Symptom: Pi node returns serial errors (`ERR SERIAL ...`) or robot does not move

Common causes:
- Arduino enumerated as a different device path (`/dev/ttyACM1` instead of `/dev/ttyACM0`)
- Wrong baud rate
- Arduino resets on open; node restarted repeatedly
- Motor driver not powered / wiring issue

Fix on the Pi:
1) Find the stable Arduino path:
```bash
ls -l /dev/ttyACM* /dev/serial/by-id 2>/dev/null || true
dmesg | egrep -i 'cdc_acm|ttyACM|Arduino|error' | tail -n 60
```

2) Restart the base node using `/dev/serial/by-id/...`:
```bash
pkill -f mecanum_daemon_node.py || true
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/serial/by-id/<YOUR_ARDUINO> --baud 9600 --port 8766 --node-id base \
  > ~/mecanum_node.log 2>&1 &
tail -n 80 ~/mecanum_node.log
```

3) If node is up but motors never move: verify motor power, driver enable pins, battery, and that the Arduino firmware is flashed.

## Symptom: Vision step works but nothing executes (dry run vs execute)

In the desktop app:
- Ensure `dryRun` is disabled and `executePlan` is enabled.
- Confirm the UI shows an `orchestrator.execute_plan.ok` event after a `vision.step.response`.

## Symptom: OpenAI vision/perception unavailable

Examples:
- “missing OPENAI_API_KEY”
- Non-200 from OpenAI APIs

Fix:
```bash
export OPENAI_API_KEY=...
```

If running `vercel-api` locally:
```bash
cd vercel-api
export OPENAI_API_KEY=...
npm run dev
```

## Autonomy Engine (autonomy-engine/) Notes

Run:
```bash
export OPENAI_API_KEY=...
python3 autonomy-engine/run_engine.py --taskspec autonomy-engine/tasks/example.taskspec.json
```

Artifacts:
- Episode frames/steps: `.daemon/episodes/`
- Semantics cache: `.daemon/semantics_cache.json`
- Judge cache: `.daemon/judge_cache.json`

If the engine can’t see the robot (no motion + no OpenAI key), it will fail closed with STOP.

