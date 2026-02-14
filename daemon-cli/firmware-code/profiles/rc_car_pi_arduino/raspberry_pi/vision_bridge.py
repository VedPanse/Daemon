import json
import time

def emit_detection(serial_port, label, confidence, cx):
    payload = {
        "event": "vision.detection",
        "label": label,
        "confidence": confidence,
        "centroid_x": cx,
        "ts_ms": int(time.time() * 1000),
    }
    serial_port.write((json.dumps(payload) + "\n").encode("utf-8"))
