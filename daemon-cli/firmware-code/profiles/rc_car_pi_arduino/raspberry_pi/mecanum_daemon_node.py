#!/usr/bin/env python3
"""
DAEMON "serial-line-v1" node for an RC car base (Raspberry Pi + Arduino mecanum).

Why this exists
- Keeps the desktop app/orchestrator hardware-agnostic.
- Hardware specifics live behind a DAEMON node MANIFEST (tokens + arg schema).
- Any future hardware just needs to implement the same node protocol + provide a manifest.

Wire protocol (line-based over TCP)
- Request lines:
  - HELLO
  - READ_MANIFEST
  - SUB TELEMETRY
  - UNSUB TELEMETRY
  - RUN <TOKEN> <arg0> <arg1> ...
  - STOP
- Responses:
  - MANIFEST <json>   (for HELLO/READ_MANIFEST)
  - OK                (for SUB/UNSUB/RUN/STOP success)
  - ERR <code> <msg>  (for failures)

This node maps high-level tokens to the Arduino's single-letter commands:
  F/B/L/R/Q/E/S
and relies on the orchestrator for timing (it will call STOP after duration_ms).
"""

from __future__ import annotations

import argparse
import json
import socket
import threading
import time
from dataclasses import dataclass

import serial  # pyserial
from serial.serialutil import SerialException


def _now_ms() -> int:
    return int(time.time() * 1000)


DEFAULT_MANIFEST = {
    "daemon_version": "0.1",
    "device": {"name": "rc-car-mecanum", "version": "0.1.0", "node_id": "base"},
    "commands": [
        {
            "token": "FWD",
            "description": "Move forward (speed is currently ignored by firmware; kept for interface stability).",
            "args": [{"name": "speed", "type": "float", "min": 0.0, "max": 1.0, "required": True}],
            "safety": {"rate_limit_hz": 20, "watchdog_ms": 1200, "clamp": True},
            "nlp": {"synonyms": ["forward", "move forward", "go forward"], "examples": ["forward 0.6"]},
        },
        {
            "token": "BWD",
            "description": "Move backward (speed is currently ignored by firmware; kept for interface stability).",
            "args": [{"name": "speed", "type": "float", "min": 0.0, "max": 1.0, "required": True}],
            "safety": {"rate_limit_hz": 20, "watchdog_ms": 1200, "clamp": True},
            "nlp": {"synonyms": ["backward", "reverse", "go back"], "examples": ["backward 0.5"]},
        },
        {
            "token": "STRAFE",
            "description": "Strafe left/right. dir in {L,R}. speed is currently ignored by firmware.",
            "args": [
                {"name": "dir", "type": "string", "enum": ["L", "R"], "required": True},
                {"name": "speed", "type": "float", "min": 0.0, "max": 1.0, "required": True},
            ],
            "safety": {"rate_limit_hz": 20, "watchdog_ms": 1200, "clamp": True},
            "nlp": {"synonyms": ["strafe", "slide"], "examples": ["strafe L 0.5", "strafe R 0.5"]},
        },
        {
            "token": "TURN",
            "description": "Rotate in place. degrees<0 => left, degrees>0 => right (magnitude ignored by firmware).",
            # Use float so upstream planners can send small corrective turns (e.g. 3.2 degrees).
            "args": [{"name": "degrees", "type": "float", "min": -180.0, "max": 180.0, "required": True}],
            "safety": {"rate_limit_hz": 20, "watchdog_ms": 1200, "clamp": True},
            "nlp": {"synonyms": ["turn", "rotate", "spin"], "examples": ["turn 90", "turn -90"]},
        },
        {
            "token": "MECANUM",
            "description": "Direct primitive command (one of F,B,L,R,Q,E,S).",
            "args": [{"name": "cmd", "type": "string", "enum": ["F", "B", "L", "R", "Q", "E", "S"], "required": True}],
            "safety": {"rate_limit_hz": 30, "watchdog_ms": 1200, "clamp": True},
            "nlp": {"synonyms": ["mecanum"], "examples": ["mecanum F"]},
        },
    ],
    "telemetry": {
        "keys": [
            {"name": "uptime_ms", "type": "int", "unit": "ms"},
            {"name": "last_token", "type": "string"},
            {"name": "serial_ok", "type": "bool"},
        ]
    },
    "transport": {"type": "serial-line-v1"},
}


ALLOWED_PRIMITIVES = {"F", "B", "L", "R", "Q", "E", "S"}


def send_line(conn: socket.socket, line: str) -> None:
    conn.sendall((line + "\n").encode("utf-8"))


def manifest_line(manifest: dict) -> str:
    return f"MANIFEST {json.dumps(manifest, separators=(',', ':'))}"


class MecanumSerial:
    def __init__(self, port: str, baud: int):
        self._port = port
        self._baud = baud
        self._lock = threading.Lock()
        self._ser: serial.Serial | None = None
        self._serial_ok = False

    def _open(self) -> None:
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None

        self._ser = serial.Serial(self._port, self._baud, timeout=1)
        # Most Arduino boards reset on open.
        time.sleep(2.0)
        self._serial_ok = True

    def serial_ok(self) -> bool:
        return bool(self._serial_ok and self._ser and self._ser.is_open)

    def send_primitive(self, cmd: str) -> None:
        cmd_u = cmd.strip().upper()
        if cmd_u not in ALLOWED_PRIMITIVES:
            raise ValueError("unsupported primitive")

        with self._lock:
            try:
                if not self._ser or not self._ser.is_open:
                    self._open()
                assert self._ser is not None
                self._ser.write(cmd_u.encode("ascii"))
                self._ser.flush()
            except Exception:
                # One reopen + retry to smooth over transient USB resets.
                self._serial_ok = False
                self._open()
                assert self._ser is not None
                self._ser.write(cmd_u.encode("ascii"))
                self._ser.flush()


@dataclass
class ClientState:
    conn: socket.socket
    running: bool = True
    telemetry_enabled: bool = False
    started_ms: int = 0
    last_token: str = "NONE"


def telemetry_loop(state: ClientState, serial_dev: MecanumSerial) -> None:
    while state.running:
        if not state.telemetry_enabled:
            time.sleep(0.1)
            continue
        uptime = _now_ms() - state.started_ms
        last_token = state.last_token
        serial_ok = serial_dev.serial_ok()
        try:
            send_line(state.conn, f"TELEMETRY uptime_ms={uptime} last_token={last_token} serial_ok={int(serial_ok)}")
        except OSError:
            break
        time.sleep(0.5)


def parse_run(parts: list[str]) -> tuple[str | None, list[str]]:
    if len(parts) < 2:
        return None, []
    return parts[1], parts[2:]


def handle_run(serial_dev: MecanumSerial, token: str, args: list[str]) -> str:
    t = token.strip().upper()

    try:
        if t == "FWD":
            if len(args) != 1:
                return "ERR BAD_ARGS wrong_count"
            # speed is kept for interface stability; firmware uses fixed speed.
            float(args[0])
            serial_dev.send_primitive("F")
            return "OK"

        if t == "BWD":
            if len(args) != 1:
                return "ERR BAD_ARGS wrong_count"
            float(args[0])
            serial_dev.send_primitive("B")
            return "OK"

        if t == "STRAFE":
            if len(args) != 2:
                return "ERR BAD_ARGS wrong_count"
            direction = args[0].strip().upper()
            float(args[1])
            if direction == "L":
                serial_dev.send_primitive("L")
                return "OK"
            if direction == "R":
                serial_dev.send_primitive("R")
                return "OK"
            return "ERR RANGE enum"

        if t == "TURN":
            if len(args) != 1:
                return "ERR BAD_ARGS wrong_count"
            deg = int(float(args[0]))
            if deg < 0:
                serial_dev.send_primitive("Q")
            elif deg > 0:
                serial_dev.send_primitive("E")
            else:
                # no-op
                pass
            return "OK"

        if t == "MECANUM":
            if len(args) != 1:
                return "ERR BAD_ARGS wrong_count"
            cmd = args[0].strip().upper()
            if cmd not in ALLOWED_PRIMITIVES:
                return "ERR RANGE enum"
            serial_dev.send_primitive(cmd)
            return "OK"

        return "ERR BAD_TOKEN unknown"
    except (ValueError, TypeError):
        return "ERR BAD_ARGS parse"
    except (FileNotFoundError, SerialException) as exc:
        return f"ERR SERIAL {exc}"
    except Exception as exc:
        return f"ERR INTERNAL {exc}"


def client_loop(conn: socket.socket, addr, manifest: dict, serial_dev: MecanumSerial, watchdog: "Watchdog") -> None:
    state = ClientState(conn=conn, started_ms=_now_ms())
    t_thread = threading.Thread(target=telemetry_loop, args=(state, serial_dev), daemon=True)
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
                    watchdog.bump("STOP")
                    try:
                        serial_dev.send_primitive("S")
                        state.last_token = "STOP"
                        send_line(conn, "OK")
                    except Exception as exc:
                        send_line(conn, f"ERR SERIAL {exc}")
                    continue

                if cmd == "RUN":
                    token, run_args = parse_run(parts)
                    if not token:
                        send_line(conn, "ERR BAD_ARGS missing_token")
                        continue
                    watchdog.bump(token)
                    resp = handle_run(serial_dev, token, run_args)
                    if resp == "OK":
                        state.last_token = token.upper()
                    send_line(conn, resp)
                    continue

                send_line(conn, "ERR BAD_REQUEST unsupported")
    finally:
        state.running = False
        t_thread.join(timeout=1.0)
        # Deadman: ensure stop on disconnect.
        try:
            serial_dev.send_primitive("S")
        except Exception:
            pass
        print(f"client disconnected: {addr}", flush=True)


class Watchdog:
    def __init__(self, serial_dev: MecanumSerial, watchdog_ms: int):
        self._serial = serial_dev
        self._watchdog_ms = max(100, int(watchdog_ms))
        self._lock = threading.Lock()
        self._last_cmd_ms = _now_ms()
        self._last_motion_active = False

    def bump(self, token: str) -> None:
        with self._lock:
            self._last_cmd_ms = _now_ms()
            self._last_motion_active = token.strip().upper() not in {"STOP"}

    def loop(self) -> None:
        while True:
            time.sleep(0.1)
            with self._lock:
                dt = _now_ms() - self._last_cmd_ms
                active = self._last_motion_active
            if active and dt > self._watchdog_ms:
                try:
                    self._serial.send_primitive("S")
                except Exception:
                    pass
                with self._lock:
                    self._last_motion_active = False


def bind_server(listen: str, port: int) -> socket.socket:
    # Prefer IPv6 dual-stack for `.local` (often IPv6 link-local).
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


def main() -> None:
    ap = argparse.ArgumentParser(description="DAEMON node for RC car mecanum base (Pi+Arduino)")
    ap.add_argument("--listen", default="::", help="Bind address (default: :: for dual-stack)")
    ap.add_argument("--port", type=int, default=8765, help="TCP port (default: 8765)")
    ap.add_argument("--serial", default="/dev/ttyACM0", help="Arduino serial device path")
    ap.add_argument("--baud", type=int, default=9600, help="Serial baud (default: 9600)")
    ap.add_argument("--node-id", default="base", help="Manifest device.node_id")
    ap.add_argument("--name", default="rc-car-mecanum", help="Manifest device.name")
    ap.add_argument("--watchdog-ms", type=int, default=1200, help="Deadman STOP if no commands within this window")
    args = ap.parse_args()

    manifest = dict(DEFAULT_MANIFEST)
    manifest["device"] = dict(DEFAULT_MANIFEST.get("device", {}))
    manifest["device"]["node_id"] = args.node_id
    manifest["device"]["name"] = args.name

    serial_dev = MecanumSerial(args.serial, args.baud)
    try:
        serial_dev._open()
    except Exception as exc:
        print(f"warning: serial not ready at startup ({args.serial}): {exc}", flush=True)

    watchdog = Watchdog(serial_dev, args.watchdog_ms)
    threading.Thread(target=watchdog.loop, daemon=True).start()

    srv = bind_server(args.listen, args.port)
    srv.listen(16)
    print(
        f"rc_car_pi_arduino node listening on {args.listen}:{args.port} -> {args.serial}@{args.baud} "
        f"(node_id={args.node_id})",
        flush=True,
    )

    while True:
        conn, addr = srv.accept()
        print(f"client connected: {addr}", flush=True)
        threading.Thread(
            target=client_loop,
            args=(conn, addr, manifest, serial_dev, watchdog),
            daemon=True,
        ).start()


if __name__ == "__main__":
    main()
