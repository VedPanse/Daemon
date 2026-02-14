#!/usr/bin/env python3
"""
DAEMON "serial-line-v1" node for a simple servo claw on Raspberry Pi GPIO.

Implements standard node protocol over TCP:
  HELLO -> MANIFEST <json>
  RUN <TOKEN> ...
  STOP

This keeps the desktop app/orchestrator hardware-agnostic: the claw interface is defined by MANIFEST.
"""

from __future__ import annotations

import argparse
import json
import socket
import threading
import time
from dataclasses import dataclass

from gpiozero import Servo


def _resolve_pin_factory(preferred: str | None):
    """
    Prefer pigpio when available (smooth servos), but allow fallback on distros where
    the `pigpio` apt package/daemon isn't available (e.g. some Debian/RPiOS variants).
    """
    pref = (preferred or "").strip().lower()

    if pref in {"pigpio", ""}:
        try:
            from gpiozero.pins.pigpio import PiGPIOFactory  # type: ignore

            return PiGPIOFactory()
        except Exception:
            pass

    if pref in {"lgpio", ""}:
        try:
            from gpiozero.pins.lgpio import LGPIOFactory  # type: ignore

            return LGPIOFactory()
        except Exception:
            pass

    # Default gpiozero factory (RPiGPIOFactory) if installed.
    return None


def _now_ms() -> int:
    return int(time.time() * 1000)


DEFAULT_MANIFEST = {
    "daemon_version": "0.1",
    "device": {"name": "rc-car-claw", "version": "0.1.0", "node_id": "arm"},
    "commands": [
        {
            "token": "GRIP",
            "description": "Set claw state.",
            "args": [{"name": "state", "type": "string", "enum": ["open", "hold"], "required": True}],
            "safety": {"rate_limit_hz": 10, "watchdog_ms": 1500, "clamp": True},
            "nlp": {"synonyms": ["grip", "open claw", "close claw"], "examples": ["grip open", "grip hold"]},
        }
    ],
    "telemetry": {
        "keys": [
            {"name": "uptime_ms", "type": "int", "unit": "ms"},
            {"name": "last_token", "type": "string"},
            {"name": "claw_state", "type": "string"},
        ]
    },
    "transport": {"type": "serial-line-v1"},
}


def send_line(conn: socket.socket, line: str) -> None:
    conn.sendall((line + "\n").encode("utf-8"))


def manifest_line(manifest: dict) -> str:
    return f"MANIFEST {json.dumps(manifest, separators=(',', ':'))}"


class Claw:
    def __init__(
        self,
        gpio_pin: int,
        hold_value: float,
        open_value: float,
        step: float,
        delay_s: float,
        pin_factory: str | None,
    ):
        self._factory = _resolve_pin_factory(pin_factory)
        self._servo = Servo(gpio_pin, pin_factory=self._factory) if self._factory else Servo(gpio_pin)
        self._lock = threading.Lock()
        self._hold = float(hold_value)
        self._open = float(open_value)
        self._step = max(0.001, float(step))
        self._delay = max(0.0, float(delay_s))
        self._state = "hold"

        # Start gripping so we don't drop anything on boot.
        self._servo.value = self._hold

    def state(self) -> str:
        return self._state

    def detach(self) -> None:
        try:
            self._servo.detach()
        except Exception:
            pass

    def _move_smooth(self, target: float) -> None:
        pos = self._servo.value if self._servo.value is not None else self._hold
        while abs(pos - target) > self._step:
            pos = pos + self._step if pos < target else pos - self._step
            self._servo.value = pos
            time.sleep(self._delay)
        self._servo.value = target

    def set_state(self, state: str) -> None:
        st = state.strip().lower()
        if st not in {"open", "hold"}:
            raise ValueError("invalid state")
        target = self._open if st == "open" else self._hold
        with self._lock:
            # Avoid repeated smoothing loops (can cause visible twitch) if we're already at target.
            current = self._servo.value
            if current is not None and abs(current - target) <= self._step:
                self._servo.value = target
                self._state = st
                return
            self._move_smooth(target)
            self._state = st

    def stop_safe(self) -> None:
        # "STOP" for a claw is: go to a safe gripping state.
        try:
            self.set_state("hold")
        except Exception:
            pass


@dataclass
class ClientState:
    conn: socket.socket
    running: bool = True
    telemetry_enabled: bool = False
    started_ms: int = 0
    last_token: str = "NONE"


def telemetry_loop(state: ClientState, claw: Claw) -> None:
    while state.running:
        if not state.telemetry_enabled:
            time.sleep(0.1)
            continue
        uptime = _now_ms() - state.started_ms
        try:
            send_line(
                state.conn,
                f"TELEMETRY uptime_ms={uptime} last_token={state.last_token} claw_state={claw.state()}",
            )
        except OSError:
            break
        time.sleep(0.6)


def parse_run(parts: list[str]) -> tuple[str | None, list[str]]:
    if len(parts) < 2:
        return None, []
    return parts[1], parts[2:]


class Watchdog:
    def __init__(self, claw: Claw, watchdog_ms: int):
        self._claw = claw
        self._watchdog_ms = max(150, int(watchdog_ms))
        self._lock = threading.Lock()
        self._last_cmd_ms = _now_ms()
        # Only enforce the watchdog after we've seen an "active" command (RUN).
        self._armed = False

    def bump(self, active: bool) -> None:
        with self._lock:
            self._last_cmd_ms = _now_ms()
            self._armed = bool(active)

    def loop(self) -> None:
        while True:
            time.sleep(0.15)
            with self._lock:
                dt = _now_ms() - self._last_cmd_ms
                armed = self._armed
            if armed and dt > self._watchdog_ms:
                self._claw.stop_safe()
                # Disarm after one safe-stop so we don't repeatedly drive the servo while idle.
                with self._lock:
                    self._armed = False


def handle_run(claw: Claw, token: str, args: list[str]) -> str:
    t = token.strip().upper()
    if t != "GRIP":
        return "ERR BAD_TOKEN unknown"
    if len(args) != 1:
        return "ERR BAD_ARGS wrong_count"
    try:
        claw.set_state(args[0])
        return "OK"
    except ValueError:
        return "ERR RANGE enum"
    except Exception as exc:
        return f"ERR INTERNAL {exc}"


def bind_server(listen: str, port: int) -> socket.socket:
    last_error: Exception | None = None
    for family, sockaddr in (
        (socket.AF_INET6, (listen, port, 0, 0)),
        (socket.AF_INET, ("0.0.0.0", port)),
    ):
        try:
            srv = socket.socket(family, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET6:
                try:
                    srv.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                except Exception:
                    pass
            srv.bind(sockaddr)
            return srv
        except Exception as exc:
            last_error = exc
            try:
                srv.close()
            except Exception:
                pass
    raise RuntimeError(f"Failed to bind server socket: {last_error}")


def client_loop(conn: socket.socket, addr, manifest: dict, claw: Claw, watchdog: Watchdog) -> None:
    state = ClientState(conn=conn, started_ms=_now_ms())
    t_thread = threading.Thread(target=telemetry_loop, args=(state, claw), daemon=True)
    t_thread.start()
    m_line = manifest_line(manifest)

    try:
        with conn:
            file = conn.makefile("r", encoding="utf-8", newline="\n")
            for raw_line in file:
                line = raw_line.strip()
                if not line:
                    continue
                parts = line.split()
                cmd = parts[0].upper()

                if cmd == "HELLO":
                    send_line(conn, m_line)
                    continue
                if cmd == "READ_MANIFEST":
                    send_line(conn, m_line)
                    continue
                if cmd == "SUB" and len(parts) >= 2 and parts[1].upper() == "TELEMETRY":
                    state.telemetry_enabled = True
                    send_line(conn, "OK")
                    continue
                if cmd == "UNSUB" and len(parts) >= 2 and parts[1].upper() == "TELEMETRY":
                    state.telemetry_enabled = False
                    send_line(conn, "OK")
                    continue

                if cmd == "STOP":
                    watchdog.bump(active=False)
                    claw.stop_safe()
                    state.last_token = "STOP"
                    send_line(conn, "OK")
                    continue

                if cmd == "RUN":
                    token, run_args = parse_run(parts)
                    if not token:
                        send_line(conn, "ERR BAD_ARGS missing_token")
                        continue
                    watchdog.bump(active=True)
                    resp = handle_run(claw, token, run_args)
                    if resp == "OK":
                        state.last_token = token.upper()
                    send_line(conn, resp)
                    continue

                send_line(conn, "ERR BAD_REQUEST unsupported")
    finally:
        state.running = False
        t_thread.join(timeout=1.0)
        claw.stop_safe()
        print(f"client disconnected: {addr}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="DAEMON node for servo claw (Pi GPIO)")
    ap.add_argument("--listen", default="::", help="Bind address (default: :: for dual-stack)")
    ap.add_argument("--port", type=int, default=8767, help="TCP port (default: 8767)")
    ap.add_argument("--node-id", default="arm", help="Manifest device.node_id")
    ap.add_argument("--name", default="rc-car-claw", help="Manifest device.name")
    ap.add_argument("--gpio", type=int, default=18, help="Servo GPIO pin (default: 18)")
    ap.add_argument(
        "--pin-factory",
        default="auto",
        help="GPIO backend: auto|pigpio|lgpio|default (default: auto)",
    )
    ap.add_argument("--hold", type=float, default=-0.55, help="Hold (grip) position value")
    ap.add_argument("--open", type=float, default=-1.0, help="Open (release) position value")
    ap.add_argument("--step", type=float, default=0.02, help="Smoothing step size")
    ap.add_argument("--delay", type=float, default=0.02, help="Smoothing step delay seconds")
    ap.add_argument("--watchdog-ms", type=int, default=1500, help="Deadman STOP if no commands within this window")
    args = ap.parse_args()

    manifest = dict(DEFAULT_MANIFEST)
    manifest["device"] = dict(DEFAULT_MANIFEST.get("device", {}))
    manifest["device"]["node_id"] = args.node_id
    manifest["device"]["name"] = args.name

    pf = args.pin_factory.strip().lower()
    if pf == "auto":
        pf = ""
    if pf == "default":
        pf = "default"
    claw = Claw(args.gpio, args.hold, args.open, args.step, args.delay, pin_factory=pf if pf != "default" else None)
    watchdog = Watchdog(claw, args.watchdog_ms)
    threading.Thread(target=watchdog.loop, daemon=True).start()

    srv = bind_server(args.listen, args.port)
    srv.listen(16)
    print(f"claw node listening on {args.listen}:{args.port} (node_id={args.node_id} gpio={args.gpio})", flush=True)

    while True:
        conn, addr = srv.accept()
        print(f"client connected: {addr}", flush=True)
        threading.Thread(target=client_loop, args=(conn, addr, manifest, claw, watchdog), daemon=True).start()


if __name__ == "__main__":
    main()
