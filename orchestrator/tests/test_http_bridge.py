import json
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from orchestrator import Orchestrator, run_http_bridge


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class HttpBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.orchestrator = Orchestrator(nodes=[])
        cls.thread = threading.Thread(
            target=run_http_bridge,
            args=(cls.orchestrator, "127.0.0.1", cls.port),
            daemon=True,
        )
        cls.thread.start()
        time.sleep(0.2)

    def request(self, method: str, path: str, body: dict | None = None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return resp.status, payload

    def test_status_endpoint(self):
        status, payload = self.request("GET", "/status")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["nodes"], [])

    def test_execute_plan_endpoint(self):
        status, payload = self.request("POST", "/execute_plan", {"plan": [{"type": "STOP"}]})
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})

    def test_execute_plan_validation_error(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/execute_plan",
            data=json.dumps({"plan": {"type": "STOP"}}).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=2)
        self.assertEqual(ctx.exception.code, 400)
        payload = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertFalse(payload["ok"])

    def test_stop_endpoint(self):
        status, payload = self.request("POST", "/stop", {})
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})


if __name__ == "__main__":
    unittest.main()
