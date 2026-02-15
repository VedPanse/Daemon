#!/usr/bin/env python3
"""
Pi Vision Brain (HTTP)
=====================

This service runs on the Raspberry Pi and is responsible for:
- Capturing frames from the robot camera locally (no frames sent to laptop/cloud).
- Running lightweight vision (OpenCV) to detect simple targets (red obstacle, cube-ish square, ring-ish circle, person-ish).
- Producing a short motion plan (DAEMON plan steps) for the laptop orchestrator to execute.

The orchestrator stays on the laptop. The desktop app calls this service for "vision_step" decisions.

Endpoints
- GET  /health
- POST /vision_step  (compatible-ish response with the existing Vercel API shape, but no frame required)

Install prerequisites on the Pi
- sudo apt-get install -y python3-opencv python3-numpy python3-requests
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import requests

try:
    import cv2  # type: ignore
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore
    np = None  # type: ignore


def _now_ms() -> int:
    return int(time.time() * 1000)


def _fnv1a_32(text: str) -> str:
    data = text.encode("utf-8")
    h = 0x811C9DC5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def _clamp(x: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, x))


def _json(obj: Any) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


@dataclass
class DetectedObject:
    label: str
    confidence: float
    bbox: dict[str, float]  # x,y,w,h in normalized [0,1]
    attributes: list[str]


def _largest_contour(mask: "np.ndarray") -> Optional[tuple[float, tuple[int, int, int, int]]]:
    # Returns (area_px, (x,y,w,h)) for the largest contour.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    best = max(contours, key=cv2.contourArea)
    area = float(cv2.contourArea(best))
    if area <= 1.0:
        return None
    x, y, w, h = cv2.boundingRect(best)
    return area, (int(x), int(y), int(w), int(h))


def detect_red(frame_bgr: "np.ndarray") -> Optional[DetectedObject]:
    h, w = frame_bgr.shape[:2]
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)

    # Two ranges to cover red across hue wrap-around.
    lower1 = np.array([0, 90, 60], dtype=np.uint8)
    upper1 = np.array([12, 255, 255], dtype=np.uint8)
    lower2 = np.array([170, 90, 60], dtype=np.uint8)
    upper2 = np.array([180, 255, 255], dtype=np.uint8)
    mask1 = cv2.inRange(hsv, lower1, upper1)
    mask2 = cv2.inRange(hsv, lower2, upper2)
    mask = cv2.bitwise_or(mask1, mask2)

    # Clean up noise a bit.
    mask = cv2.medianBlur(mask, 5)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8), iterations=1)

    found = _largest_contour(mask)
    if not found:
        return None
    area_px, (x, y, bw, bh) = found
    area_frac = area_px / float(w * h)
    if area_frac < 0.002:
        return None

    cx = (x + bw / 2.0) / float(w)
    cy = (y + bh / 2.0) / float(h)
    bbox = {"x": x / float(w), "y": y / float(h), "w": bw / float(w), "h": bh / float(h)}
    # Confidence is heuristic: scale with area.
    conf = _clamp(0.15 + area_frac * 2.2, 0.0, 0.99)
    return DetectedObject(
        label="red object",
        confidence=conf,
        bbox=bbox,
        attributes=["red", f"cx={cx:.3f}", f"cy={cy:.3f}", f"area={area_frac:.4f}"],
    )


def detect_cube_like(frame_bgr: "np.ndarray") -> Optional[DetectedObject]:
    # Very rough: find largest 4-vertex contour that is close to square.
    h, w = frame_bgr.shape[:2]
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 80, 160)
    edges = cv2.dilate(edges, np.ones((3, 3), dtype=np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    best_score = 0.0
    best_bbox: Optional[tuple[int, int, int, int]] = None
    for c in contours:
        area = float(cv2.contourArea(c))
        if area < 250:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.03 * peri, True)
        if len(approx) != 4:
            continue
        x, y, bw, bh = cv2.boundingRect(approx)
        aspect = bw / float(max(1, bh))
        if aspect < 0.75 or aspect > 1.33:
            continue
        fill = area / float(bw * bh)
        if fill < 0.45:
            continue
        area_frac = area / float(w * h)
        score = area_frac * fill
        if score > best_score:
            best_score = score
            best_bbox = (x, y, bw, bh)

    if not best_bbox:
        return None
    x, y, bw, bh = best_bbox
    area_frac = (bw * bh) / float(w * h)
    conf = _clamp(0.12 + area_frac * 1.7, 0.0, 0.92)
    return DetectedObject(
        label="cube",
        confidence=conf,
        bbox={"x": x / float(w), "y": y / float(h), "w": bw / float(w), "h": bh / float(h)},
        attributes=["square-ish"],
    )


def detect_ring_like(frame_bgr: "np.ndarray") -> Optional[DetectedObject]:
    # Rough circle detection (for a "ring" prompt). This is not robust but works for high-contrast rings.
    h, w = frame_bgr.shape[:2]
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 0)
    circles = cv2.HoughCircles(gray, cv2.HOUGH_GRADIENT, dp=1.2, minDist=40, param1=120, param2=30, minRadius=12, maxRadius=120)
    if circles is None or len(circles) == 0:
        return None
    c = circles[0][0]
    cx, cy, r = float(c[0]), float(c[1]), float(c[2])
    x = int(max(0, cx - r))
    y = int(max(0, cy - r))
    bw = int(min(w - x, 2 * r))
    bh = int(min(h - y, 2 * r))
    area_frac = (math.pi * (r * r)) / float(w * h)
    conf = _clamp(0.10 + area_frac * 2.4, 0.0, 0.9)
    return DetectedObject(
        label="ring",
        confidence=conf,
        bbox={"x": x / float(w), "y": y / float(h), "w": bw / float(w), "h": bh / float(h)},
        attributes=["circle-ish"],
    )


def detect_person_like(frame_bgr: "np.ndarray") -> Optional[DetectedObject]:
    # HOG people detector; can be slow. Use low-res frames.
    h, w = frame_bgr.shape[:2]
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    small = cv2.resize(frame_bgr, (min(320, w), int(min(320, w) * (h / float(w)))))
    rects, weights = hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.05)
    if rects is None or len(rects) == 0:
        return None
    # Pick the highest-weight box.
    best_i = int(np.argmax(weights))
    x, y, bw, bh = rects[best_i]
    weight = float(weights[best_i]) if weights is not None and len(weights) > best_i else 0.4
    # Map back to original coords.
    sx = w / float(small.shape[1])
    sy = h / float(small.shape[0])
    x0 = int(x * sx)
    y0 = int(y * sy)
    bw0 = int(bw * sx)
    bh0 = int(bh * sy)
    conf = _clamp(0.25 + weight * 0.15, 0.0, 0.9)
    return DetectedObject(
        label="person",
        confidence=conf,
        bbox={"x": x0 / float(w), "y": y0 / float(h), "w": bw0 / float(w), "h": bh0 / float(h)},
        attributes=["hog"],
    )


def compose_perception(objects: list[DetectedObject], target: Optional[DetectedObject], summary: str) -> dict[str, Any]:
    found = target is not None
    bbox = target.bbox if target else None
    area = float(bbox["w"] * bbox["h"]) if bbox else 0.0
    center_x = (bbox["x"] + bbox["w"] / 2.0) if bbox else 0.5
    offset_x = float(center_x - 0.5)
    # Rough distance proxy: larger area => closer.
    distance_norm = float(_clamp(1.0 / math.sqrt(max(1e-6, area)), 1.0, 25.0)) if bbox else 0.0
    return {
        "objects": [
            {"label": o.label, "confidence": float(o.confidence), "bbox": o.bbox, "attributes": list(o.attributes or [])} for o in objects
        ],
        "selected_target": {"label": target.label, "confidence": float(target.confidence), "bbox": target.bbox, "attributes": list(target.attributes or [])}
        if target
        else None,
        "summary": summary,
        "found": bool(found),
        "bbox": bbox,
        "area": float(area),
        "offset_x": float(offset_x),
        "center_offset_x": float(offset_x),
        "confidence": float(target.confidence) if target else 0.0,
        "distance_norm": distance_norm,
    }


def parse_target(text: str) -> dict[str, Optional[str]]:
    # Very small target extractor (label + color).
    color = None
    if re.search(r"\bred\b", text):
        color = "red"
    if re.search(r"\bblue\b", text):
        color = "blue"
    if re.search(r"\bgreen\b", text):
        color = "green"
    if re.search(r"\byellow\b", text):
        color = "yellow"

    label = None
    for candidate in ["ring", "cube", "person", "obstacle", "object", "block"]:
        if re.search(rf"\b{re.escape(candidate)}\b", text):
            label = candidate
            break
    if label == "block":
        label = "cube"
    if label in ("object", "obstacle") and color:
        label = "obstacle"
    return {"label": label, "color": color}


def parse_actions(text: str) -> tuple[str, list[dict[str, Any]], dict[str, Optional[str]]]:
    """
    Returns (task_type, canonical_actions, target)
    task_type: stop | move-pattern | move-if-clear | pick-object | unknown
    """
    t = text.lower().strip()
    t = re.sub(r"\s+", " ", t)

    target = parse_target(t)

    if re.search(r"(emergency stop|e-stop|estop|abort|halt|\bstop\b)", t):
        return "stop", [{"type": "STOP"}], target

    # Conditional forward steps based on visual absence/presence of a colored obstacle.
    has_if_no = bool(re.search(r"\bif\b", t) and re.search(r"\b(no|not|can't|cannot|dont|don't)\b", t) and target.get("color"))
    has_until = bool(re.search(r"\buntil\b", t) and target.get("color"))
    wants_forward = bool(re.search(r"\b(forward|ahead|straight)\b", t))
    if (has_if_no or has_until) and wants_forward:
        return "move-if-clear", [{"type": "MOVE", "direction": "forward", "distance_m": 1.0, "speed": 0.55}], target

    # Motion-only multi-step parsing.
    motion_trigger = bool(
        re.search(r"\b(move|go|drive|head|strafe|slide|shift)\b", t)
        or re.search(r"\b(turn|rotate)\b", t)
        or re.search(r"\b(reverse|back up)\b", t)
    )
    if motion_trigger:
        clauses = [c.strip() for c in re.split(r"\b(?:and then|then|after that|afterwards|next)\b|,|;", t) if c.strip()]
        if len(clauses) <= 1:
            dir_mentions = len(re.findall(r"\b(forward|backward|backwards|back|behind|left|right)\b", t))
            if dir_mentions >= 2 and " and " in t:
                clauses = [c.strip() for c in re.split(r"\band\b", t) if c.strip()]

        actions: list[dict[str, Any]] = []
        for clause in clauses if clauses else [t]:
            if re.search(r"\b(turn (to )?(the )?left|rotate left|counterclockwise)\b", clause):
                actions.append({"type": "TURN", "direction": "left", "angle_deg": 90, "speed": 0.55})
                continue
            if re.search(r"\b(turn (to )?(the )?right|rotate right|clockwise)\b", clause):
                actions.append({"type": "TURN", "direction": "right", "angle_deg": 90, "speed": 0.55})
                continue
            if re.search(r"\b(backward|backwards|back up|move back|go back|reverse|behind)\b", clause):
                actions.append({"type": "MOVE", "direction": "backward", "distance_m": 1.0, "speed": 0.55})
                continue
            if re.search(r"\b(strafe left|slide left)\b|\bleft\b", clause):
                actions.append({"type": "MOVE", "direction": "left", "distance_m": 1.0, "speed": 0.55})
                continue
            if re.search(r"\b(strafe right|slide right)\b|\bright\b", clause):
                actions.append({"type": "MOVE", "direction": "right", "distance_m": 1.0, "speed": 0.55})
                continue
            if re.search(r"\b(move forward|go forward|drive forward|forward|ahead|straight)\b", clause):
                actions.append({"type": "MOVE", "direction": "forward", "distance_m": 1.0, "speed": 0.55})
                continue

        if actions:
            return "move-pattern", actions, target

    if re.search(r"\b(pick up|pickup|grab)\b", t):
        return "pick-object", [], target

    return "unknown", [], target


def build_allowed_tokens(system_manifest: Any) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    if not isinstance(system_manifest, dict):
        return out
    nodes = system_manifest.get("nodes")
    if not isinstance(nodes, list):
        return out
    for n in nodes:
        if not isinstance(n, dict):
            continue
        name = n.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        toks: set[str] = set()
        commands = n.get("commands")
        if isinstance(commands, list):
            for c in commands:
                if isinstance(c, dict) and isinstance(c.get("token"), str):
                    toks.add(str(c.get("token")).upper())
        out[name.strip()] = toks
        # Also allow node_id / display_name keys if present.
        for k in ["node_id", "display_name"]:
            if isinstance(n.get(k), str) and n.get(k).strip():
                out[n.get(k).strip()] = toks
    return out


def map_move_to_step(caps: dict[str, Any], allowed: dict[str, set[str]], action: dict[str, Any]) -> list[dict[str, Any]]:
    target = str(caps.get("base_target", "base"))
    fwd = str(caps.get("base_fwd_token", "FWD"))
    turn = str(caps.get("base_turn_token", "TURN"))
    strafe = str(caps.get("base_strafe_token", "STRAFE"))
    speed = float(action.get("speed") or 0.55)

    tokens = allowed.get(target, set())
    token_ok = lambda tok: (not allowed) or (tok.upper() in tokens)

    steps: list[dict[str, Any]] = []
    typ = action.get("type")
    if typ == "TURN":
        ang = float(abs(action.get("angle_deg") or 90.0))
        signed = -ang if action.get("direction") == "left" else ang
        tok = turn if token_ok(turn) else ("MECANUM" if token_ok("MECANUM") else None)
        if tok is None:
            return []
        args = [signed] if tok == turn else (["Q"] if signed < 0 else ["E"])
        steps.append({"type": "RUN", "target": target, "token": tok, "args": args, "duration_ms": 360})
        return steps

    if typ != "MOVE":
        return steps

    direction = action.get("direction")
    distance_m = float(action.get("distance_m") or 1.0)
    duration = int(_clamp(round(distance_m * 1800.0), 250, 8000))
    if direction == "forward":
        if not token_ok(fwd):
            return []
        steps.append({"type": "RUN", "target": target, "token": fwd, "args": [speed], "duration_ms": duration})
        return steps
    if direction == "backward":
        tok = "BWD" if token_ok("BWD") else ("MECANUM" if token_ok("MECANUM") else None)
        if tok is None:
            return []
        args = [speed] if tok == "BWD" else ["B"]
        steps.append({"type": "RUN", "target": target, "token": tok, "args": args, "duration_ms": duration})
        return steps
    if direction in ("left", "right"):
        dir_token = "L" if direction == "left" else "R"
        if token_ok(strafe):
            steps.append({"type": "RUN", "target": target, "token": strafe, "args": [dir_token, speed], "duration_ms": duration})
            return steps
        if token_ok("MECANUM"):
            steps.append({"type": "RUN", "target": target, "token": "MECANUM", "args": [dir_token], "duration_ms": duration})
            return steps
        # Fallback: approximate strafe with a turn.
        if token_ok(turn):
            steps.append({"type": "RUN", "target": target, "token": turn, "args": [-90 if direction == "left" else 90], "duration_ms": 360})
            return steps
        return []
    return steps


def normalize_state(input_state: Any) -> dict[str, Any]:
    default_caps = {
        "base_target": "base",
        "arm_target": "arm",
        "base_turn_token": "TURN",
        "base_fwd_token": "FWD",
        "base_strafe_token": "STRAFE",
        "arm_grip_token": "GRIP",
    }
    if not isinstance(input_state, dict):
        return {
            "stage": "SEARCH",
            "scan_dir": 1,
            "scan_ticks": 0,
            "capabilities": dict(default_caps),
            "instruction_ctx": {"hash": ""},
            "motion_ctx": {"consumed": False, "step_idx": 0, "total_steps": 0},
            "target_lock_ctx": None,
            "perf_ctx": {"recommended_interval_ms": 180},
        }
    caps_in = input_state.get("capabilities") if isinstance(input_state.get("capabilities"), dict) else {}
    return {
        "stage": str(input_state.get("stage") or "SEARCH").upper(),
        "scan_dir": 1 if float(input_state.get("scan_dir") or 1) >= 0 else -1,
        "scan_ticks": int(max(0, float(input_state.get("scan_ticks") or 0))),
        "capabilities": {
            "base_target": str(caps_in.get("base_target") or default_caps["base_target"]),
            "arm_target": str(caps_in.get("arm_target") or default_caps["arm_target"]),
            "base_turn_token": str(caps_in.get("base_turn_token") or default_caps["base_turn_token"]),
            "base_fwd_token": str(caps_in.get("base_fwd_token") or default_caps["base_fwd_token"]),
            "base_strafe_token": str(caps_in.get("base_strafe_token") or default_caps["base_strafe_token"]),
            "arm_grip_token": str(caps_in.get("arm_grip_token") or default_caps["arm_grip_token"]),
        },
        "instruction_ctx": {
            "hash": str((input_state.get("instruction_ctx") or {}).get("hash") or ""),
        },
        "motion_ctx": {
            "consumed": bool((input_state.get("motion_ctx") or {}).get("consumed") or False),
            "step_idx": int(max(0, float((input_state.get("motion_ctx") or {}).get("step_idx") or 0))),
            "total_steps": int(max(0, float((input_state.get("motion_ctx") or {}).get("total_steps") or 0))),
        },
        "target_lock_ctx": None,
        "perf_ctx": {"recommended_interval_ms": int(max(80, min(600, float((input_state.get("perf_ctx") or {}).get("recommended_interval_ms") or 180))))},
    }


def reset_for_instruction(state: dict[str, Any], new_hash: str) -> dict[str, Any]:
    out = dict(state)
    out["stage"] = "SEARCH"
    out["scan_dir"] = 1
    out["scan_ticks"] = 0
    out["instruction_ctx"] = {"hash": new_hash}
    out["motion_ctx"] = {"consumed": False, "step_idx": 0, "total_steps": 0}
    return out


def pick_target(objects: list[DetectedObject], target_spec: dict[str, Optional[str]]) -> Optional[DetectedObject]:
    want_label = (target_spec.get("label") or "").strip().lower()
    want_color = (target_spec.get("color") or "").strip().lower()
    if not objects:
        return None
    if not want_label and not want_color:
        # Nothing requested; pick best.
        return max(objects, key=lambda o: o.confidence)

    def matches(o: DetectedObject) -> bool:
        label = o.label.lower()
        attrs = [a.lower() for a in (o.attributes or [])]
        if want_label and want_label in label:
            return True
        if want_color and (want_color in label or any(want_color in a for a in attrs)):
            return True
        return False

    candidates = [o for o in objects if matches(o)]
    if not candidates:
        return None
    return max(candidates, key=lambda o: o.confidence)


def build_plan_and_state(
    state: dict[str, Any],
    task_type: str,
    actions: list[dict[str, Any]],
    target_spec: dict[str, Optional[str]],
    perception: dict[str, Any],
    allowed: dict[str, set[str]],
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str], str]:
    caps = state.get("capabilities") if isinstance(state.get("capabilities"), dict) else {}
    notes: list[str] = []

    if task_type == "stop":
        return [{"type": "STOP"}], {**state, "stage": "DONE"}, ["Stop requested"], "STOP"

    if task_type == "move-if-clear":
        # If the target (color) is present "in path", stop; else emit a short forward step.
        target = perception.get("selected_target") if isinstance(perception, dict) else None
        in_path = False
        if isinstance(target, dict):
            area = float(perception.get("area") or 0.0)
            off = float(perception.get("offset_x") or 0.0)
            conf = float(perception.get("confidence") or 0.0)
            in_path = conf >= 0.25 and area >= 0.02 and abs(off) <= 0.28
        if in_path:
            notes.append("Obstacle detected in path; stopping")
            return [{"type": "STOP"}], {**state, "stage": "DONE"}, notes, "MOVE/IF_CLEAR"
        notes.append("Path appears clear; stepping forward")
        return (
            [{"type": "RUN", "target": str(caps.get("base_target", "base")), "token": str(caps.get("base_fwd_token", "FWD")), "args": [0.45], "duration_ms": 240}, {"type": "STOP"}],
            {**state, "stage": "SEARCH"},
            notes,
            "MOVE/IF_CLEAR",
        )

    if task_type == "move-pattern":
        # Emit the full macro once per instruction.
        mc = state.get("motion_ctx") if isinstance(state.get("motion_ctx"), dict) else {"step_idx": 0, "total_steps": 0, "consumed": False}
        if mc.get("consumed"):
            return [{"type": "STOP"}], {**state, "stage": "MOTION_ONLY"}, ["motion macro already emitted for current instruction"], "MOVE/PATTERN"
        steps: list[dict[str, Any]] = []
        for act in actions:
            steps.extend(map_move_to_step(caps, allowed, act))
        if not steps:
            steps = [{"type": "STOP"}]
        else:
            steps.append({"type": "STOP"})
        next_state = dict(state)
        next_state["stage"] = "MOTION_ONLY"
        next_state["motion_ctx"] = {"consumed": True, "step_idx": len(steps), "total_steps": len(steps)}
        notes.append(f"motion macro emitted {max(0, len(steps)-1)} steps ({len(steps)} total)")
        return steps, next_state, notes, "MOVE/PATTERN"

    if task_type == "pick-object":
        # Very simple closed-loop behavior:
        # - if target found: align by turning until centered, then approach until close, then close claw
        # - else: small scan turn
        stage = str(state.get("stage") or "SEARCH").upper()
        target = perception.get("selected_target") if isinstance(perception, dict) else None
        if stage == "DONE":
            stage = "SEARCH"
        if not isinstance(target, dict):
            # scan
            scan_dir = int(state.get("scan_dir") or 1)
            scan_ticks = int(state.get("scan_ticks") or 0) + 1
            if scan_ticks % 5 == 0:
                scan_dir *= -1
            next_state = dict(state)
            next_state["scan_dir"] = scan_dir
            next_state["scan_ticks"] = scan_ticks
            next_state["stage"] = "SEARCH"
            notes.append("No target found; scanning")
            plan = [
                {"type": "RUN", "target": str(caps.get("base_target", "base")), "token": str(caps.get("base_turn_token", "TURN")), "args": [12 * scan_dir], "duration_ms": 220},
                {"type": "STOP"},
            ]
            return plan, next_state, notes, "PICK/SEARCH"

        off = float(perception.get("offset_x") or 0.0)
        area = float(perception.get("area") or 0.0)
        if abs(off) > 0.07:
            turn_deg = _clamp(off * 55.0, -20.0, 20.0)
            notes.append("Turning to center target")
            next_state = dict(state)
            next_state["stage"] = "ALIGN"
            plan = [
                {"type": "RUN", "target": str(caps.get("base_target", "base")), "token": str(caps.get("base_turn_token", "TURN")), "args": [round(turn_deg, 2)], "duration_ms": 220},
                {"type": "STOP"},
            ]
            return plan, next_state, notes, "PICK/ALIGN"

        if area < 0.10:
            notes.append("Approaching target")
            next_state = dict(state)
            next_state["stage"] = "APPROACH"
            plan = [
                {"type": "RUN", "target": str(caps.get("base_target", "base")), "token": str(caps.get("base_fwd_token", "FWD")), "args": [0.45], "duration_ms": 240},
                {"type": "STOP"},
            ]
            return plan, next_state, notes, "PICK/APPROACH"

        # close claw
        notes.append("Close enough; closing claw")
        next_state = dict(state)
        next_state["stage"] = "DONE"
        plan = [
            {"type": "RUN", "target": str(caps.get("arm_target", "arm")), "token": str(caps.get("arm_grip_token", "GRIP")), "args": ["close"]},
            {"type": "STOP"},
        ]
        return plan, next_state, notes, "PICK/GRAB"

    return [{"type": "STOP"}], {**state, "stage": "DONE"}, ["Unknown task; stopping"], "UNKNOWN"


class VisionBrain:
    def __init__(self, snapshot_url: str, enable_person: bool):
        self.snapshot_url = snapshot_url
        self.enable_person = enable_person

    def capture_frame(self, timeout_s: float = 1.5) -> "np.ndarray":
        if cv2 is None or np is None:
            raise RuntimeError("OpenCV unavailable (install python3-opencv + python3-numpy)")
        resp = requests.get(self.snapshot_url, timeout=timeout_s)
        if resp.status_code != 200:
            raise RuntimeError(f"snapshot fetch failed: HTTP {resp.status_code}")
        raw = resp.content
        arr = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise RuntimeError("snapshot decode failed")
        return frame

    def perceive(self, frame_bgr: "np.ndarray", target_spec: dict[str, Optional[str]]) -> tuple[dict[str, Any], list[str]]:
        notes: list[str] = []
        objects: list[DetectedObject] = []
        # Always run red + simple shapes; optionally run person.
        red = detect_red(frame_bgr)
        if red:
            objects.append(red)
        cube = detect_cube_like(frame_bgr)
        if cube:
            objects.append(cube)
        ring = detect_ring_like(frame_bgr)
        if ring:
            objects.append(ring)
        if self.enable_person:
            person = detect_person_like(frame_bgr)
            if person:
                objects.append(person)

        selected = pick_target(objects, target_spec)
        summary = f"local_cv: {len(objects)} objects"
        if selected:
            summary += f"; selected={selected.label}"
        else:
            summary += "; selected=none"
        perception = compose_perception(objects, selected, summary)
        notes.append("perception_source=local_cv")
        return perception, notes


def run_server(*, listen: str, port: int, brain: VisionBrain) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _write(self, code: int, payload: dict[str, Any]) -> None:
            raw = _json(payload)
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Correlation-Id")
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Correlation-Id")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path.startswith("/health"):
                self._write(200, {"ok": True, "ts_ms": _now_ms()})
                return
            self._write(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self.path.startswith("/vision_step"):
                self._write(404, {"ok": False, "error": "not_found"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0") or "0")
                raw = self.rfile.read(size) if size > 0 else b"{}"
                body = json.loads(raw.decode("utf-8")) if raw else {}
                if not isinstance(body, dict):
                    raise RuntimeError("Body must be a JSON object")
            except Exception as exc:
                self._write(400, {"error": "BAD_REQUEST", "message": str(exc)})
                return

            instruction = str(body.get("instruction") or "").strip()
            if not instruction:
                self._write(400, {"error": "BAD_REQUEST", "message": "instruction is required"})
                return
            correlation_id = (
                (str(body.get("correlation_id") or "").strip())
                or (self.headers.get("X-Correlation-Id") or "").strip()
                or f"pi-{_now_ms()}"
            )

            t0 = time.time()
            try:
                state = normalize_state(body.get("state"))
                normalized = re.sub(r"\s+", " ", instruction.lower()).strip()
                ihash = _fnv1a_32(normalized)
                notes: list[str] = []
                if state.get("instruction_ctx", {}).get("hash") != ihash:
                    state = reset_for_instruction(state, ihash)
                    notes.append("instruction hash changed; state reset")

                task_type, actions, target_spec = parse_actions(instruction)
                allowed = build_allowed_tokens(body.get("system_manifest"))

                # Perception is local; capture a frame unless motion-only/stop.
                if task_type in ("move-pattern", "stop"):
                    perception = {
                        "objects": [],
                        "selected_target": None,
                        "summary": "perception bypassed (motion-only)",
                        "found": False,
                        "bbox": None,
                        "area": 0.0,
                        "offset_x": 0.0,
                        "center_offset_x": 0.0,
                        "confidence": 0.0,
                        "distance_norm": 0.0,
                    }
                    perception_notes = ["perception_source=none"]
                    perception_source = "none"
                else:
                    frame = brain.capture_frame(timeout_s=1.8)
                    perception, perception_notes = brain.perceive(frame, target_spec)
                    perception_source = "local_cv"
                notes.extend(perception_notes)

                plan, next_state, policy_notes, policy_branch = build_plan_and_state(
                    state,
                    task_type,
                    actions,
                    target_spec,
                    perception,
                    allowed,
                )
                notes.extend(policy_notes)

                total_ms = int((time.time() - t0) * 1000)
                # Recommend a faster loop for conditional motion.
                rec_ms = 140 if task_type in ("move-if-clear", "pick-object") else 220
                next_state["perf_ctx"] = {"recommended_interval_ms": int(_clamp(rec_ms, 80, 600))}

                self._write(
                    200,
                    {
                        "correlation_id": correlation_id,
                        "state": next_state,
                        "perception": perception,
                        "plan": plan,
                        "debug": {
                            "correlation_id": correlation_id,
                            "applied_instruction": instruction,
                            "instruction_hash": ihash,
                            "policy_branch": policy_branch,
                            "perception_source": perception_source,
                            "parsed_instruction": {
                                "task_type": task_type,
                                "canonical_actions": actions if actions else None,
                                "target": {"label": target_spec.get("label"), "color": target_spec.get("color"), "query": None},
                            },
                            "camera_meta": {"source": "pi_internal", "snapshot_url": brain.snapshot_url},
                            "notes": notes,
                            "timings_ms": {"total": total_ms},
                        },
                    },
                )
            except Exception as exc:
                self._write(400, {"error": "VISION_ERROR", "message": str(exc), "correlation_id": correlation_id})

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    httpd = ThreadingHTTPServer((listen, int(port)), Handler)
    print(f"pi_vision_brain listening on http://{listen}:{port}")
    httpd.serve_forever()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--snapshot-url", default="http://127.0.0.1:8081/snapshot.jpg")
    ap.add_argument("--enable-person", action="store_true", help="Enable HOG person detector (slower).")
    args = ap.parse_args()

    brain = VisionBrain(snapshot_url=str(args.snapshot_url), enable_person=bool(args.enable_person))
    run_server(listen=str(args.listen), port=int(args.port), brain=brain)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
