#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_DIR="$ROOT_DIR/daemon-cli/.venv"
TMP_DIR="$(mktemp -d)"

BASE_PID=""
ARM_PID=""
GRIPPER_PID=""
DRONE_PID=""
SENSOR_PID=""
TURN_PID=""
PLANNER_PID=""

BASE_LOG="$TMP_DIR/base.log"
ARM_LOG="$TMP_DIR/arm.log"
GRIPPER_LOG="$TMP_DIR/gripper.log"
DRONE_LOG="$TMP_DIR/drone.log"
SENSOR_LOG="$TMP_DIR/sensor.log"
TURN_LOG="$TMP_DIR/turn.log"
RUN1_LOG="$TMP_DIR/run_forward_close.log"
RUN2_LOG="$TMP_DIR/run_square.log"
NEG1_LOG="$TMP_DIR/neg_missing_capability.log"
NEG2_LOG="$TMP_DIR/neg_ambiguous.log"
PLANNER_LOG="$TMP_DIR/planner.log"

log() {
  printf '[smoke-ext] %s\n' "$1"
}

fail() {
  printf '[smoke-ext] FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  local hint="$3"
  grep -q "$pattern" "$file" || fail "$hint"
}

kill_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  kill_pid "$PLANNER_PID"
  kill_pid "$TURN_PID"
  kill_pid "$SENSOR_PID"
  kill_pid "$DRONE_PID"
  kill_pid "$GRIPPER_PID"
  kill_pid "$ARM_PID"
  kill_pid "$BASE_PID"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

if [[ ! -d "$VENV_DIR" ]]; then
  log "Creating venv"
  python3 -m venv "$VENV_DIR"
fi

# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

log "Installing daemon-cli dependencies"
python3 -m pip install -r daemon-cli/requirements.txt >/dev/null
python3 -m pip install -e daemon-cli >/dev/null

log "Building manufacturer firmware examples"
daemon build --firmware-dir daemon-cli/examples/firmware_manufacturers/skylift_drone >/dev/null
daemon build --firmware-dir daemon-cli/examples/firmware_manufacturers/gripworks_gripper >/dev/null
daemon build --firmware-dir daemon-cli/examples/firmware_manufacturers/linetrace_sensor >/dev/null

log "Starting 5 emulators"
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7777 --manifest daemon-cli/examples/manifests/base.yml >"$BASE_LOG" 2>&1 &
BASE_PID=$!
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7778 --manifest daemon-cli/examples/manifests/arm.yml >"$ARM_LOG" 2>&1 &
ARM_PID=$!
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7779 --manifest daemon-cli/examples/manifests/gripworks_gripper.yml >"$GRIPPER_LOG" 2>&1 &
GRIPPER_PID=$!
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7780 --manifest daemon-cli/examples/manifests/skylift_drone.yml >"$DRONE_LOG" 2>&1 &
DRONE_PID=$!
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7781 --manifest daemon-cli/examples/manifests/linetrace_sensor.yml >"$SENSOR_LOG" 2>&1 &
SENSOR_PID=$!

sleep 1
kill -0 "$BASE_PID" 2>/dev/null || fail "base emulator failed to start"
kill -0 "$ARM_PID" 2>/dev/null || fail "arm emulator failed to start"
kill -0 "$GRIPPER_PID" 2>/dev/null || fail "gripper emulator failed to start"
kill -0 "$DRONE_PID" 2>/dev/null || fail "drone emulator failed to start"
kill -0 "$SENSOR_PID" 2>/dev/null || fail "sensor emulator failed to start"

ORCH_CMD=(python3 orchestrator/orchestrator.py \
  --node base=localhost:7777 \
  --node arm=localhost:7778 \
  --node gripper=localhost:7779 \
  --node drone=localhost:7780 \
  --node sensor=localhost:7781)

if [[ -n "${PLANNER_URL:-}" ]]; then
  log "Using remote planner from PLANNER_URL for positive path"
  ORCH_CMD+=(--planner-url "$PLANNER_URL")
else
  log "Using local fallback planner for positive path"
fi

"${ORCH_CMD[@]}" --instruction "forward then close gripper" >"$RUN1_LOG" 2>&1 || fail "positive case 1 failed"
"${ORCH_CMD[@]}" --instruction "square" >"$RUN2_LOG" 2>&1 || fail "positive case 2 failed"

assert_contains "$RUN1_LOG" "plan executed" "positive case 1 did not execute"
assert_contains "$RUN2_LOG" "plan executed" "positive case 2 did not execute"
assert_contains "$RUN1_LOG" '"target": "base"' "positive case 1 missing deterministic base routing"
assert_contains "$RUN1_LOG" '"target": "arm"' "positive case 1 missing deterministic gripper routing"
assert_contains "$RUN2_LOG" '"token": "TURN"' "square macro did not include TURN"

log "Running negative test: missing capability without THROTTLE node"
set +e
python3 orchestrator/orchestrator.py \
  --node base=localhost:7777 \
  --node arm=localhost:7778 \
  --node gripper=localhost:7779 \
  --node sensor=localhost:7781 \
  --instruction "takeoff" >"$NEG1_LOG" 2>&1
NEG1_STATUS=$?
set -e
[[ $NEG1_STATUS -ne 0 ]] || fail "missing capability test unexpectedly succeeded"
assert_contains "$NEG1_LOG" "Token 'THROTTLE' not found" "missing capability did not fail with clear token error"

log "Starting collision TURN emulator"
python3 daemon-cli/examples/node-emulator/emulator.py --host 127.0.0.1 --port 7782 --manifest daemon-cli/examples/manifests/collision_turn.yml >"$TURN_LOG" 2>&1 &
TURN_PID=$!
sleep 1
kill -0 "$TURN_PID" 2>/dev/null || fail "collision TURN emulator failed to start"

cat > "$TMP_DIR/mock_planner.py" <<'PY'
#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        _ = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        body = json.dumps({"plan": [{"type": "RUN", "token": "TURN", "args": [25]}, {"type": "STOP"}]})
        raw = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        return

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 7790), Handler).serve_forever()
PY
python3 "$TMP_DIR/mock_planner.py" >"$PLANNER_LOG" 2>&1 &
PLANNER_PID=$!
sleep 1
kill -0 "$PLANNER_PID" 2>/dev/null || fail "mock planner failed to start"

log "Running negative test: ambiguous TURN without target"
set +e
python3 orchestrator/orchestrator.py \
  --node base=localhost:7777 \
  --node turner=localhost:7782 \
  --planner-url http://127.0.0.1:7790 \
  --instruction "any" >"$NEG2_LOG" 2>&1
NEG2_STATUS=$?
set -e
[[ $NEG2_STATUS -ne 0 ]] || fail "ambiguous TURN test unexpectedly succeeded"
assert_contains "$NEG2_LOG" "ambiguous across nodes; explicit target is required" "ambiguous collision did not fail with clear validation error"

log "PASS"
