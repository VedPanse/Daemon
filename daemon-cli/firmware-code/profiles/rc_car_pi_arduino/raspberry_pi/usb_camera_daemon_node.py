#!/usr/bin/env python3
"""
DAEMON node + HTTP server for a Raspberry Pi USB webcam.

Goals
- Provide a stable "camera" abstraction in the same style as other DAEMON nodes.
- Expose a low-latency snapshot endpoint that the desktop app can poll for vision loops.
- Expose an optional MJPEG stream endpoint for a live preview.

Transport
- DAEMON node protocol (TCP): HELLO/READ_MANIFEST/SUB/UNSUB/RUN/STOP (serial-line-v1 style)
- HTTP: GET /snapshot.jpg and GET /stream.mjpg

Implementation details
- Capture uses `fswebcam` (usb webcam via V4L2). We keep a background thread that refreshes the
  latest JPEG and serves it from memory to avoid spawning `fswebcam` on every HTTP request.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional


def _now_ms() -> int:
    return int(time.time() * 1000)


DEFAULT_MANIFEST = {
    "daemon_version": "0.1",
    "device": {"name": "rc-car-camera", "version": "0.1.0", "node_id": "cam"},
    "commands": [
        {
            "token": "SNAP",
            "description": "Capture a single camera frame (also available via HTTP /snapshot.jpg).",
            "args": [],
            "safety": {"rate_limit_hz": 5, "watchdog_ms": 2000, "clamp": True},
            "nlp": {"synonyms": ["snapshot", "camera", "take picture"], "examples": ["snap"]},
        }
    ],
    "telemetry": {
        "keys": [
            {"name": "uptime_ms", "type": "int", "unit": "ms"},
            {"name": "last_token", "type": "string"},
            {"name": "capture_ok", "type": "bool"},
            {"name": "last_capture_ms", "type": "int", "unit": "ms"},
            {"name": "http_port", "type": "int"},
        ]
    },
    "services": {
        "camera": {
            "type": "http-camera-v1",
            "http_port": 8081,
            "snapshot_path": "/snapshot.jpg",
            "mjpeg_path": "/stream.mjpg",
        }
    },
    "transport": {"type": "serial-line-v1"},
}


def send_line(conn: socket.socket, line: str) -> None:
    conn.sendall((line + "\n").encode("utf-8"))


def manifest_line(manifest: dict) -> str:
    return f"MANIFEST {json.dumps(manifest, separators=(',', ':'))}"


class CameraCapture:
    def __init__(
        self,
        device: str,
        width: int,
        height: int,
        jpeg_quality: int,
        fps: float,
        skip_frames: int,
        warmup_captures: int,
        tmp_dir: str,
    ):
        self._device = device
        self._width = int(width)
        self._height = int(height)
        self._jpeg_quality = int(jpeg_quality)
        self._fps = max(0.2, float(fps))
        self._skip = max(0, int(skip_frames))
        self._warmup = max(0, int(warmup_captures))
        self._tmp_dir = Path(tmp_dir)
        self._tmp_dir.mkdir(parents=True, exist_ok=True)
        self._tmp_path = self._tmp_dir / "daemon_latest.jpg"

        self._lock = threading.Lock()
        self._latest: Optional[bytes] = None
        self._last_capture_ms = 0
        self._ok = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.5)

    def snapshot_bytes(self) -> Optional[bytes]:
        with self._lock:
            return self._latest

    def status(self) -> tuple[bool, int]:
        with self._lock:
            return bool(self._ok), int(self._last_capture_ms)

    def capture_once(self) -> None:
        # Called from RUN SNAP as best-effort synchronous refresh.
        self._capture_into_latest()

    def _fswebcam_cmd(self) -> list[str]:
        cmd = [
            "fswebcam",
            "--no-banner",
            "--quiet",
            "-d",
            self._device,
            "-r",
            f"{self._width}x{self._height}",
            "--jpeg",
            str(self._jpeg_quality),
        ]
        if self._skip > 0:
            cmd.extend(["-S", str(self._skip)])
        cmd.append(str(self._tmp_path))
        return cmd

    def _capture_into_latest(self) -> None:
        try:
            subprocess.run(self._fswebcam_cmd(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            raw = self._tmp_path.read_bytes()
        except Exception:
            with self._lock:
                self._ok = False
            return

        with self._lock:
            self._latest = raw
            self._ok = True
            self._last_capture_ms = _now_ms()

    def _loop(self) -> None:
        # Warmup to avoid the first frame being stale/dark.
        for _ in range(self._warmup):
            if self._stop.is_set():
                return
            self._capture_into_latest()
            time.sleep(0.08)

        period = 1.0 / self._fps
        while not self._stop.is_set():
            t0 = time.time()
            self._capture_into_latest()
            dt = time.time() - t0
            time.sleep(max(0.0, period - dt))


def run_http_server(
    capture: CameraCapture,
    *,
    listen: str,
    port: int,
    mjpeg_fps: float,
) -> ThreadingHTTPServer:
    boundary = "frame"

    class Handler(BaseHTTPRequestHandler):
        def _set_common_headers(self, content_type: str) -> None:
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/health"):
                ok, last_ms = capture.status()
                payload = json.dumps({"ok": ok, "last_capture_ms": last_ms}).encode("utf-8")
                self.send_response(200)
                self._set_common_headers("application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if self.path.startswith("/snapshot.jpg"):
                raw = capture.snapshot_bytes()
                if raw is None:
                    # Best-effort immediate capture if we have nothing yet.
                    capture.capture_once()
                    raw = capture.snapshot_bytes()
                if raw is None:
                    self.send_response(503)
                    self._set_common_headers("text/plain")
                    self.end_headers()
                    self.wfile.write(b"camera_unavailable")
                    return

                self.send_response(200)
                self._set_common_headers("image/jpeg")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return

            if self.path.startswith("/stream.mjpg") or self.path.startswith("/stream.mjpeg"):
                self.send_response(200)
                self._set_common_headers(f"multipart/x-mixed-replace; boundary={boundary}")
                self.end_headers()

                period = 1.0 / max(0.5, float(mjpeg_fps))
                while True:
                    raw = capture.snapshot_bytes()
                    if raw is None:
                        time.sleep(0.1)
                        continue
                    try:
                        self.wfile.write(f"--{boundary}\r\n".encode("ascii"))
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii"))
                        self.wfile.write(raw)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                    except Exception:
                        break
                    time.sleep(period)
                return

            self.send_response(404)
            self._set_common_headers("text/plain")
            self.end_headers()
            self.wfile.write(b"not_found")

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

    httpd = ThreadingHTTPServer((listen, int(port)), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


@dataclass
class ClientState:
    conn: socket.socket
    running: bool = True
    telemetry_enabled: bool = False
    started_ms: int = 0
    last_token: str = "NONE"


def telemetry_loop(state: ClientState, capture: CameraCapture, http_port: int) -> None:
    while state.running:
        if not state.telemetry_enabled:
            time.sleep(0.1)
            continue
        uptime = _now_ms() - state.started_ms
        ok, last_ms = capture.status()
        try:
            send_line(
                state.conn,
                f"TELEMETRY uptime_ms={uptime} last_token={state.last_token} capture_ok={int(ok)} last_capture_ms={last_ms} http_port={http_port}",
            )
        except OSError:
            break
        time.sleep(0.6)


def parse_run(parts: list[str]) -> tuple[str | None, list[str]]:
    if len(parts) < 2:
        return None, []
    return parts[1], parts[2:]


def handle_run(capture: CameraCapture, token: str, args: list[str]) -> str:
    t = token.strip().upper()
    if t != "SNAP":
        return "ERR BAD_TOKEN unknown"
    if args:
        return "ERR BAD_ARGS wrong_count"
    try:
        capture.capture_once()
        return "OK"
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


def client_loop(conn: socket.socket, addr, manifest: dict, capture: CameraCapture, http_port: int) -> None:
    state = ClientState(conn=conn, started_ms=_now_ms())
    t_thread = threading.Thread(target=telemetry_loop, args=(state, capture, http_port), daemon=True)
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
                    state.last_token = "STOP"
                    send_line(conn, "OK")
                    continue

                if cmd == "RUN":
                    token, run_args = parse_run(parts)
                    if not token:
                        send_line(conn, "ERR BAD_ARGS missing_token")
                        continue
                    resp = handle_run(capture, token, run_args)
                    if resp == "OK":
                        state.last_token = token.upper()
                    send_line(conn, resp)
                    continue

                send_line(conn, "ERR BAD_REQUEST unsupported")
    finally:
        state.running = False
        t_thread.join(timeout=1.0)
        print(f"client disconnected: {addr}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="DAEMON node + HTTP server for Pi USB camera (fswebcam)")
    ap.add_argument("--listen", default="::", help="Bind address for TCP node (default: :: for dual-stack)")
    ap.add_argument("--port", type=int, default=8768, help="TCP port for DAEMON node (default: 8768)")
    ap.add_argument("--node-id", default="cam", help="Manifest device.node_id (default: cam)")
    ap.add_argument("--name", default="rc-car-camera", help="Manifest device.name (default: rc-car-camera)")

    ap.add_argument("--http-listen", default="0.0.0.0", help="Bind address for HTTP server (default: 0.0.0.0)")
    ap.add_argument("--http-port", type=int, default=8081, help="HTTP port for snapshot/MJPEG (default: 8081)")

    ap.add_argument("--device", default="/dev/video0", help="V4L2 device path (default: /dev/video0)")
    ap.add_argument("--width", type=int, default=640, help="Capture width (default: 640)")
    ap.add_argument("--height", type=int, default=480, help="Capture height (default: 480)")
    ap.add_argument("--jpeg-quality", type=int, default=70, help="JPEG quality 1..95 (default: 70)")
    ap.add_argument("--fps", type=float, default=8.0, help="Background capture FPS (default: 8.0)")
    ap.add_argument("--mjpeg-fps", type=float, default=8.0, help="MJPEG stream FPS (default: 8.0)")
    ap.add_argument("--skip-frames", type=int, default=2, help="fswebcam skip frames (default: 2)")
    ap.add_argument("--warmup-captures", type=int, default=2, help="Warmup captures on boot (default: 2)")
    ap.add_argument("--tmp-dir", default="/tmp", help="Temp directory for fswebcam output (default: /tmp)")
    args = ap.parse_args()

    manifest = dict(DEFAULT_MANIFEST)
    manifest["device"] = dict(DEFAULT_MANIFEST.get("device", {}))
    manifest["device"]["node_id"] = args.node_id
    manifest["device"]["name"] = args.name

    manifest["services"] = dict(DEFAULT_MANIFEST.get("services", {}))
    if isinstance(manifest["services"].get("camera"), dict):
        manifest["services"]["camera"] = dict(manifest["services"]["camera"])
        manifest["services"]["camera"]["http_port"] = int(args.http_port)

    capture = CameraCapture(
        device=args.device,
        width=args.width,
        height=args.height,
        jpeg_quality=args.jpeg_quality,
        fps=args.fps,
        skip_frames=args.skip_frames,
        warmup_captures=args.warmup_captures,
        tmp_dir=args.tmp_dir,
    )
    capture.start()

    httpd = run_http_server(capture, listen=args.http_listen, port=args.http_port, mjpeg_fps=args.mjpeg_fps)
    print(
        f"camera HTTP listening on http://{args.http_listen}:{args.http_port} "
        f"(snapshot=/snapshot.jpg stream=/stream.mjpg)",
        flush=True,
    )

    srv = bind_server(args.listen, args.port)
    srv.listen(16)
    print(
        f"camera DAEMON node listening on {args.listen}:{args.port} (node_id={args.node_id}) device={args.device}",
        flush=True,
    )

    try:
        while True:
            conn, addr = srv.accept()
            print(f"client connected: {addr}", flush=True)
            threading.Thread(target=client_loop, args=(conn, addr, manifest, capture, int(args.http_port)), daemon=True).start()
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        capture.stop()


if __name__ == "__main__":
    main()

