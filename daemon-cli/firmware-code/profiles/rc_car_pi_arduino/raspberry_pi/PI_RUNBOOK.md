# Pi Runbook: RC Car Mecanum DAEMON Node

This runbook installs and runs the **DAEMON node server** on the Raspberry Pi that bridges:

- DAEMON node protocol over TCP (`HELLO` -> `MANIFEST`, `RUN`, `STOP`)
- Arduino mecanum sketch over serial (`/dev/ttyACM0` at `9600`)

The desktop app should talk to the **local orchestrator** (HTTP bridge). The orchestrator talks to the Pi node.

## Quickstart From `raspberry_pi` Directory

If you want one command that mirrors the root `SETUP.md` flow (desktop app dev server + vercel API dev server + orchestrator), run:

```bash
cd daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi
./daemon build
```

Useful helpers:

```bash
./daemon status
./daemon clean
```

## 0) SSH Into The Pi

From your laptop:
```bash
ssh treehacks@vporto26.local
```

If `.local` is flaky, use the Pi IPv4 (on the Pi run `hostname -I`).

## 1) Install Prereqs On The Pi

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-serial fswebcam
```

## 2) Clone The Repo On The Pi

Choose a folder (example uses `~/Daemon`):
```bash
cd ~
rm -rf Daemon
git clone --depth 1 https://github.com/Sachin-dot-py/Daemon Daemon
cd Daemon
```

## 3) Verify The Arduino Is Present

```bash
ls -l /dev/ttyACM* /dev/serial/by-id 2>/dev/null || true
dmesg | egrep -i 'cdc_acm|ttyACM|Arduino|error -32|enumerate' | tail -n 60
```

If `/dev/ttyACM0` is missing, fix USB/power/wiring first.
Note: after reconnects it may show up as `/dev/ttyACM1`. Prefer the stable `/dev/serial/by-id/...` symlink.

## 4) Start The DAEMON Node Server

Important: port conflicts
- If you already have an old JSON TCP bridge running on `8765`, either stop it or use a different port (recommended `8766`).

### Option A (recommended): Run node on `8766` (avoid conflicts)
```bash
pkill -f mecanum_daemon_node.py || true
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_44238313039351317291-if00 --baud 9600 --port 8766 --node-id base \
  > ~/mecanum_node.log 2>&1 &
```

Verify:
```bash
ss -ltnp | egrep ':(8766)\\b' || true
tail -n 60 ~/mecanum_node.log
```

### Option B: Reuse `8765` (only if you stop the old JSON bridge)
Stop anything else on `8765`:
```bash
pkill -f mecanum_bridge_server.py || true
pkill -f mecanum_daemon_node.py || true
```

Start node on `8765`:
```bash
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_44238313039351317291-if00 --baud 9600 --port 8765 --node-id base \
  > ~/mecanum_node.log 2>&1 &
```

## 4b) (Optional) Start The Claw Node (servo on GPIO)

If your robot has a servo claw driven from the Pi GPIO (example: GPIO 18), run a second DAEMON node.

Prereqs (recommended, works on Debian/RPiOS variants where `pigpio` may not exist):
```bash
sudo apt-get update
sudo apt-get install -y python3-gpiozero python3-lgpio
```

Optional (if your distro provides pigpio and you want it):
```bash
apt-cache search pigpio | head
```
If you see `pigpio` and `pigpiod`, you can install and enable them, and then run the node with `--pin-factory pigpio`.

Start the claw node on port `8767`:
```bash
pkill -f claw_daemon_node.py || true
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/claw_daemon_node.py \
  --gpio 18 --port 8767 --node-id arm --pin-factory lgpio --detach-after-move > ~/claw_node.log 2>&1 &
ss -ltnp | egrep ':(8767)\\b' || true
tail -n 60 ~/claw_node.log
```

Healthcheck from laptop:
```bash
python3 tools/daemon_node_healthcheck.py --host vporto26.local --port 8767 --stop
```

Manual claw command test (from laptop):
```bash
python3 - <<'PY'
import socket, time
host="vporto26.local"; port=8767
s=socket.create_connection((host,port), timeout=3)
s.sendall(b"HELLO\n")
print(s.recv(4096).decode().strip())
s.sendall(b"RUN GRIP open\n")
print(s.recv(4096).decode().strip())
time.sleep(1)
s.sendall(b"RUN GRIP hold\n")
print(s.recv(4096).decode().strip())
s.sendall(b"STOP\n")
print(s.recv(4096).decode().strip())
s.close()
PY
```

## 4c) Camera Node (USB webcam + fswebcam)

This runs:
- DAEMON node protocol on TCP `8768` (so the orchestrator manifest knows a camera exists)
- HTTP snapshot/MJPEG on `8081` (so the desktop app can use the robot camera frames)

Verify the camera device exists:
```bash
ls -l /dev/video* 2>/dev/null || true
v4l2-ctl --list-devices 2>/dev/null || true
```

Start camera node:
```bash
pkill -f usb_camera_daemon_node.py || true
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/usb_camera_daemon_node.py \
  --port 8768 --node-id cam --http-port 8081 --device /dev/video0 > ~/camera_node.log 2>&1 &
ss -ltnp | egrep ':(8768|8081)\\b' || true
tail -n 60 ~/camera_node.log
```

Quick HTTP check (from laptop):
```bash
curl -s -o /dev/null -w "%{http_code}\\n" http://vporto26.local:8081/health
curl -s -o /tmp/daemon_snapshot.jpg http://vporto26.local:8081/snapshot.jpg && file /tmp/daemon_snapshot.jpg
```

## 5) Healthcheck From Laptop

From repo root on laptop (not on Pi):
```bash
python3 tools/daemon_node_healthcheck.py --host vporto26.local --port 8766 --stop
```

Optional smoke motion:
```bash
python3 tools/daemon_node_healthcheck.py --host vporto26.local --port 8766 --smoke-run
```

If `vporto26.local` resolution is unreliable, substitute the Pi IPv4 address.

## 6) Run The Orchestrator On Laptop (what the desktop app uses)

Start orchestrator in HTTP bridge mode on your laptop:
```bash
python3 orchestrator/orchestrator.py \
  --node base=vporto26.local:8766 \
  --node arm=vporto26.local:8767 \
  --node cam=vporto26.local:8768 \
  --http-port 5055
```

Verify:
```bash
curl -s http://127.0.0.1:5055/status | head
```

Then the desktop app can execute plans via `http://127.0.0.1:5055/execute_plan`.

## Troubleshooting

- If the Pi ethernet drops, reconnect it and re-run:
  - `ss -ltnp | egrep ':(8765|8766)\\b'`
  - `tail -n 60 ~/mecanum_node.log`
- If the node returns `ERR SERIAL ... No such file or directory: '/dev/ttyACM0'`, the Arduino disappeared (or moved to `/dev/ttyACM1`).
- If your laptop healthcheck gets JSON like `{"ok": false, ...}` back, you're still hitting the *old* JSON bridge, not the DAEMON node.
