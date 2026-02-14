from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_MODEL = "gpt-5"
DEFAULT_CONFIGS_DIR = "configs"
DEFAULT_PROFILES_DIR = "profiles"
DEFAULT_PUBLISH_URL = "https://daemon-api.vercel.app/api/v1/daemon-configs/ingest"
DEFAULT_PUBLISH_TIMEOUT_SECONDS = 20
MAX_CONTEXT_FILE_BYTES = 300_000
AUTO_FIRMWARE_DIR_HELP = (
    "auto-detect: ./firmware-code, ./daemon-cli/firmware-code, "
    "<daemon-cli>/firmware-code"
)


def resolve_default_firmware_dir() -> Path:
    cwd = Path.cwd()
    cli_root = Path(__file__).resolve().parents[1]
    candidates = (
        cwd / "firmware-code",
        cwd / "daemon-cli" / "firmware-code",
        cli_root / "firmware-code",
    )
    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate.resolve()
    return (cli_root / "firmware-code").resolve()


def resolve_firmware_dir(firmware_dir_arg: str | None) -> Path:
    if firmware_dir_arg:
        return Path(firmware_dir_arg).resolve()
    return resolve_default_firmware_dir()

DEFAULT_SYSTEM_PROMPT = (
    "You are an embedded firmware generation assistant for Daemon. "
    "Generate exactly two artifacts in plain text: DAEMON.yaml and daemon_entry.c. "
    "The YAML must define safe, explicit command-to-function mappings and telemetry/event schemas. "
    "The C file must include a robust command dispatcher, argument validation, safety limits, and clear stubs "
    "for hardware actions (motors, sensors, camera, GPIO, serial, I2C, SPI, PWM, network where relevant). "
    "Keep output deterministic, production-minded, and hardware-agnostic while still concrete."
)

TEXT_EXTENSIONS = {
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".txt",
    ".md",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".ini",
    ".cfg",
    ".cmake",
    ".py",
    ".sh",
    ".make",
    ".mk",
    ".ld",
}

SKIP_DIR_NAMES = {
    ".git",
    "__pycache__",
    ".venv",
    "node_modules",
    "dist",
    "build",
    ".build",
}

SAMPLE_CONTEXTS: dict[str, dict[str, str]] = {
    "rc_car_pi_arduino": {
        "README.md": """# RC Car (Raspberry Pi + Arduino) Firmware Context

This profile splits responsibilities:
- Raspberry Pi: camera + higher-level planning
- Arduino: deterministic motor + steering control loop
- Serial protocol: newline-delimited JSON commands

Safety goals:
- Deadman timeout if command stream stalls
- Max PWM clamp
- Steering angle clamp
""",
        "arduino/motor_controller.h": """#ifndef MOTOR_CONTROLLER_H
#define MOTOR_CONTROLLER_H

#include <stdint.h>

void mc_init(void);
void mc_set_drive(int16_t throttle_percent, int16_t steering_percent);
void mc_emergency_stop(void);
void mc_tick_10ms(void);

#endif
""",
        "arduino/motor_controller.c": """#include "motor_controller.h"

static int16_t g_last_throttle = 0;
static int16_t g_last_steering = 0;
static uint16_t g_deadman_ticks = 0;

void mc_init(void) {
    g_last_throttle = 0;
    g_last_steering = 0;
    g_deadman_ticks = 0;
}

void mc_set_drive(int16_t throttle_percent, int16_t steering_percent) {
    if (throttle_percent > 100) throttle_percent = 100;
    if (throttle_percent < -100) throttle_percent = -100;
    if (steering_percent > 100) steering_percent = 100;
    if (steering_percent < -100) steering_percent = -100;

    g_last_throttle = throttle_percent;
    g_last_steering = steering_percent;
    g_deadman_ticks = 0;
}

void mc_emergency_stop(void) {
    g_last_throttle = 0;
}

void mc_tick_10ms(void) {
    g_deadman_ticks++;
    if (g_deadman_ticks > 50) {
        mc_emergency_stop();
    }
}
""",
        "raspberry_pi/vision_bridge.py": """import json
import time

def emit_detection(serial_port, label, confidence, cx):
    payload = {
        "event": "vision.detection",
        "label": label,
        "confidence": confidence,
        "centroid_x": cx,
        "ts_ms": int(time.time() * 1000),
    }
    serial_port.write((json.dumps(payload) + "\\n").encode("utf-8"))
""",
        "protocol/serial_protocol.md": """# Serial JSON Protocol

Command message:
```json
{"cmd":"drive.set","throttle":42,"steering":-10}
```

Emergency stop:
```json
{"cmd":"safety.estop"}
```

Telemetry:
```json
{"event":"telemetry.state","battery_v":7.8,"speed_mps":1.2}
```
""",
    },
    "greenhouse_node": {
        "README.md": """# Greenhouse Sensor Node Context

Target:
- MCU node for environmental monitoring
- Relay control for irrigation and fan
- Periodic telemetry uplink

Focus:
- Sensor polling intervals
- Hysteresis-based actuator control
- Safe defaults on sensor failure
""",
        "src/greenhouse_control.c": """#include <stdbool.h>
#include <stdint.h>

static float g_target_humidity = 55.0f;
static bool g_pump_enabled = false;

void gh_set_target_humidity(float value) {
    if (value < 35.0f) value = 35.0f;
    if (value > 85.0f) value = 85.0f;
    g_target_humidity = value;
}

void gh_apply_humidity_control(float measured_humidity) {
    const float on_threshold = g_target_humidity - 4.0f;
    const float off_threshold = g_target_humidity + 2.0f;

    if (measured_humidity < on_threshold) g_pump_enabled = true;
    if (measured_humidity > off_threshold) g_pump_enabled = false;
}
""",
        "src/board_map.h": """#ifndef BOARD_MAP_H
#define BOARD_MAP_H

#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#define PIN_RELAY_PUMP 5
#define PIN_RELAY_FAN 6

#endif
""",
        "protocol/messages.yaml": """commands:
  - id: climate.set_target_humidity
    args: [percent]
  - id: irrigation.manual_override
    args: [enabled, duration_s]
events:
  - id: telemetry.climate
  - id: alert.sensor_fault
""",
    },
    "arm_manipulator": {
        "README.md": """# Arm Manipulator Context

Six-DOF manipulator with:
- Joint motor drivers
- Limit switches and current sensing
- Cartesian move planner upstream

Firmware responsibilities:
- Enforce joint soft/hard limits
- Execute queued joint targets
- Emit deterministic motion state telemetry
""",
        "src/joint_limits.h": """#ifndef JOINT_LIMITS_H
#define JOINT_LIMITS_H

typedef struct {
    float min_deg;
    float max_deg;
    float max_vel_deg_s;
} joint_limit_t;

extern const joint_limit_t JOINT_LIMITS[6];

#endif
""",
        "src/joint_limits.c": """#include "joint_limits.h"

const joint_limit_t JOINT_LIMITS[6] = {
    {-170.0f, 170.0f, 90.0f},
    {-120.0f, 120.0f, 80.0f},
    {-170.0f, 170.0f, 100.0f},
    {-190.0f, 190.0f, 120.0f},
    {-120.0f, 120.0f, 120.0f},
    {-360.0f, 360.0f, 240.0f},
};
""",
        "src/motion_queue.c": """#include <stdbool.h>

typedef struct {
    float target_deg[6];
    float duration_s;
} motion_segment_t;

bool mq_push(const motion_segment_t *segment);
bool mq_pop(motion_segment_t *segment);
""",
        "protocol/commands.md": """- arm.home
- arm.stop
- arm.move_joint (joint_id, angle_deg, duration_s)
- arm.execute_trajectory (segments[])
""",
    },
}


def main() -> None:
    parser = argparse.ArgumentParser(prog="daemon")
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_build_parser(subparsers)
    add_publish_parser(subparsers)
    add_init_samples_parser(subparsers)

    args = parser.parse_args()
    args.handler(args)


def add_build_parser(subparsers: argparse._SubParsersAction) -> None:
    build_parser = subparsers.add_parser(
        "build",
        help="Generate DAEMON.yaml + daemon_entry.c into a unique config folder",
    )
    build_parser.add_argument(
        "--firmware-dir",
        default=None,
        help=f"Firmware root (default: {AUTO_FIRMWARE_DIR_HELP})",
    )
    build_parser.add_argument(
        "--context-dir",
        default=None,
        help=(
            "Firmware context source directory. Defaults to "
            "<firmware-dir>/context if it exists, else <firmware-dir>."
        ),
    )
    build_parser.add_argument(
        "--profile",
        default="generic",
        help="Hardware profile label (e.g. rc_car_pi_arduino, greenhouse_node)",
    )
    build_parser.add_argument(
        "--config-id",
        default=None,
        help="Optional explicit config id. Defaults to unique generated id.",
    )
    build_parser.add_argument(
        "--generation-mode",
        choices=("model", "template"),
        default="model",
        help="model=OpenAI generation, template=deterministic local template",
    )
    build_parser.add_argument(
        "--model",
        default=os.environ.get("DAEMON_MODEL", DEFAULT_MODEL),
        help=f"OpenAI model for generation mode=model (default: {DEFAULT_MODEL})",
    )
    build_parser.add_argument(
        "--system-prompt-file",
        default=None,
        help="Optional file containing a custom system prompt",
    )
    build_parser.add_argument(
        "--daemon-yaml-path",
        default=None,
        help="Optional extra output path for DAEMON.yaml (legacy compatibility)",
    )
    build_parser.add_argument(
        "--daemon-entry-path",
        default=None,
        help="Optional extra output path for daemon_entry.c (legacy compatibility)",
    )
    build_parser.add_argument(
        "--publish",
        action="store_true",
        help="POST generated artifacts to API endpoint",
    )
    build_parser.add_argument(
        "--publish-url",
        default=os.environ.get("DAEMON_PUBLISH_URL", DEFAULT_PUBLISH_URL),
        help=f"Publish endpoint (default: {DEFAULT_PUBLISH_URL})",
    )
    build_parser.add_argument(
        "--publish-timeout",
        type=int,
        default=DEFAULT_PUBLISH_TIMEOUT_SECONDS,
        help=f"Publish timeout in seconds (default: {DEFAULT_PUBLISH_TIMEOUT_SECONDS})",
    )
    build_parser.set_defaults(handler=handle_build)


def add_publish_parser(subparsers: argparse._SubParsersAction) -> None:
    publish_parser = subparsers.add_parser(
        "publish",
        help="Publish an existing generated config folder to an API endpoint",
    )
    publish_parser.add_argument(
        "--firmware-dir",
        default=None,
        help=f"Firmware root (default: {AUTO_FIRMWARE_DIR_HELP})",
    )
    publish_parser.add_argument(
        "--config-id",
        default=None,
        help="Config id under <firmware-dir>/configs/<config-id>. Defaults to latest.",
    )
    publish_parser.add_argument(
        "--config-dir",
        default=None,
        help="Optional explicit config directory path (overrides --config-id)",
    )
    publish_parser.add_argument(
        "--publish-url",
        default=os.environ.get("DAEMON_PUBLISH_URL", DEFAULT_PUBLISH_URL),
        help=f"Publish endpoint (default: {DEFAULT_PUBLISH_URL})",
    )
    publish_parser.add_argument(
        "--publish-timeout",
        type=int,
        default=DEFAULT_PUBLISH_TIMEOUT_SECONDS,
        help=f"Publish timeout in seconds (default: {DEFAULT_PUBLISH_TIMEOUT_SECONDS})",
    )
    publish_parser.set_defaults(handler=handle_publish)


def add_init_samples_parser(subparsers: argparse._SubParsersAction) -> None:
    init_parser = subparsers.add_parser(
        "init-samples",
        help="Create sample firmware profile contexts under <firmware-dir>/profiles",
    )
    init_parser.add_argument(
        "--firmware-dir",
        default=None,
        help=f"Firmware root (default: {AUTO_FIRMWARE_DIR_HELP})",
    )
    init_parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite sample files if they already exist",
    )
    init_parser.set_defaults(handler=handle_init_samples)


def handle_build(args: argparse.Namespace) -> None:
    firmware_dir = resolve_firmware_dir(args.firmware_dir)
    firmware_dir.mkdir(parents=True, exist_ok=True)

    context_dir = resolve_context_dir(firmware_dir, args.context_dir)
    if not context_dir.exists() or not context_dir.is_dir():
        fail(f"Context directory not found: {context_dir}")

    config_id = args.config_id.strip() if args.config_id else generate_unique_config_id(
        firmware_dir / DEFAULT_CONFIGS_DIR, args.profile
    )
    if not is_valid_identifier(config_id):
        fail("Invalid --config-id. Use only letters, numbers, underscore, or dash.")

    config_dir = firmware_dir / DEFAULT_CONFIGS_DIR / config_id
    config_dir.mkdir(parents=True, exist_ok=False)

    daemon_yaml_path = config_dir / "DAEMON.yaml"
    daemon_entry_path = config_dir / "daemon_entry.c"
    manifest_path = config_dir / "manifest.json"

    context, context_files = collect_context(context_dir, excluded={daemon_yaml_path, daemon_entry_path})
    if not context.strip():
        fail(f"No text context files found in {context_dir}")

    if args.generation_mode == "model":
        payload = generate_with_model(
            model=args.model,
            system_prompt_file=args.system_prompt_file,
            firmware_dir=firmware_dir,
            context_dir=context_dir,
            profile=args.profile,
            context=context,
        )
    else:
        payload = generate_from_template(config_id=config_id, profile=args.profile)
    validate_generated_artifacts(payload)

    daemon_yaml_path.write_text(payload["daemon_yaml"], encoding="utf-8")
    daemon_entry_path.write_text(payload["daemon_entry_c"], encoding="utf-8")

    if args.daemon_yaml_path:
        extra_yaml = Path(args.daemon_yaml_path).resolve()
        extra_yaml.parent.mkdir(parents=True, exist_ok=True)
        extra_yaml.write_text(payload["daemon_yaml"], encoding="utf-8")

    if args.daemon_entry_path:
        extra_entry = Path(args.daemon_entry_path).resolve()
        extra_entry.parent.mkdir(parents=True, exist_ok=True)
        extra_entry.write_text(payload["daemon_entry_c"], encoding="utf-8")

    manifest = build_manifest(
        config_id=config_id,
        profile=args.profile,
        model=args.model if args.generation_mode == "model" else None,
        generation_mode=args.generation_mode,
        context_dir=context_dir,
        config_dir=config_dir,
        context=context,
        context_files=context_files,
        daemon_yaml_path=daemon_yaml_path,
        daemon_entry_path=daemon_entry_path,
    )

    publish_result: dict[str, object] | None = None
    if args.publish:
        publish_result = publish_generated_config(
            publish_url=args.publish_url,
            publish_timeout=args.publish_timeout,
            manifest=manifest,
            daemon_yaml=payload["daemon_yaml"],
            daemon_entry_c=payload["daemon_entry_c"],
        )
        manifest["publish"] = publish_result

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"Config id: {config_id}")
    print(f"Wrote {daemon_yaml_path}")
    print(f"Wrote {daemon_entry_path}")
    print(f"Wrote {manifest_path}")
    if args.daemon_yaml_path:
        print(f"Wrote {Path(args.daemon_yaml_path).resolve()}")
    if args.daemon_entry_path:
        print(f"Wrote {Path(args.daemon_entry_path).resolve()}")
    if publish_result:
        print(
            "Publish result: "
            f"status={publish_result.get('status')} "
            f"http={publish_result.get('http_status')}"
        )


def handle_publish(args: argparse.Namespace) -> None:
    firmware_dir = resolve_firmware_dir(args.firmware_dir)
    config_dir = resolve_config_dir(
        firmware_dir=firmware_dir,
        explicit_config_dir=args.config_dir,
        config_id=args.config_id,
    )

    daemon_yaml_path = config_dir / "DAEMON.yaml"
    daemon_entry_path = config_dir / "daemon_entry.c"
    manifest_path = config_dir / "manifest.json"

    if not daemon_yaml_path.exists():
        fail(f"Missing file: {daemon_yaml_path}")
    if not daemon_entry_path.exists():
        fail(f"Missing file: {daemon_entry_path}")
    if not manifest_path.exists():
        fail(f"Missing file: {manifest_path}")

    daemon_yaml = daemon_yaml_path.read_text(encoding="utf-8")
    daemon_entry_c = daemon_entry_path.read_text(encoding="utf-8")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    publish_result = publish_generated_config(
        publish_url=args.publish_url,
        publish_timeout=args.publish_timeout,
        manifest=manifest,
        daemon_yaml=daemon_yaml,
        daemon_entry_c=daemon_entry_c,
    )

    manifest["publish"] = publish_result
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"Published {config_dir}")
    print(
        "Publish result: "
        f"status={publish_result.get('status')} "
        f"http={publish_result.get('http_status')}"
    )
    print(f"Wrote {manifest_path}")


def handle_init_samples(args: argparse.Namespace) -> None:
    firmware_dir = resolve_firmware_dir(args.firmware_dir)
    profiles_dir = firmware_dir / DEFAULT_PROFILES_DIR
    profiles_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    skipped = 0
    for profile, files in SAMPLE_CONTEXTS.items():
        for rel_path, content in files.items():
            out_path = profiles_dir / profile / rel_path
            if out_path.exists() and not args.force:
                skipped += 1
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(content, encoding="utf-8")
            written += 1

    print(f"Profiles directory: {profiles_dir}")
    print(f"Sample files written: {written}")
    print(f"Sample files skipped: {skipped}")
    print("Profiles:")
    for profile in sorted(SAMPLE_CONTEXTS):
        print(f"- {profile}")


def resolve_context_dir(firmware_dir: Path, context_dir_arg: str | None) -> Path:
    if context_dir_arg:
        return Path(context_dir_arg).resolve()
    candidate = firmware_dir / "context"
    if candidate.exists() and candidate.is_dir():
        return candidate.resolve()
    return firmware_dir


def resolve_config_dir(
    firmware_dir: Path,
    explicit_config_dir: str | None,
    config_id: str | None,
) -> Path:
    if explicit_config_dir:
        config_dir = Path(explicit_config_dir).resolve()
        if not config_dir.exists() or not config_dir.is_dir():
            fail(f"Config directory not found: {config_dir}")
        return config_dir

    configs_dir = firmware_dir / DEFAULT_CONFIGS_DIR
    if not configs_dir.exists() or not configs_dir.is_dir():
        fail(f"Configs directory not found: {configs_dir}")

    if config_id:
        safe_id = config_id.strip()
        if not is_valid_identifier(safe_id):
            fail(f"Invalid --config-id: {config_id}")
        config_dir = configs_dir / safe_id
        if not config_dir.exists() or not config_dir.is_dir():
            fail(f"Config id not found: {safe_id}")
        return config_dir

    candidates = sorted(p for p in configs_dir.iterdir() if p.is_dir())
    if not candidates:
        fail(f"No config folders found under {configs_dir}")
    return candidates[-1]


def collect_context(root: Path, excluded: set[Path]) -> tuple[str, list[str]]:
    sections: list[str] = []
    context_files: list[str] = []
    for path in iter_files(root):
        resolved = path.resolve()
        if resolved in excluded:
            continue
        if should_skip(path):
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue

        if len(raw) > MAX_CONTEXT_FILE_BYTES:
            continue
        if is_binary(raw):
            continue

        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("utf-8", errors="replace")

        relative = path.relative_to(root).as_posix()
        context_files.append(relative)
        sections.append(f"## FILE: {relative}\n```\n{content}\n```")

    return "\n\n".join(sections), context_files


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            yield path


def should_skip(path: Path) -> bool:
    lower_parts = {part.lower() for part in path.parts}
    if any(skip in lower_parts for skip in SKIP_DIR_NAMES):
        return True
    if DEFAULT_CONFIGS_DIR in lower_parts:
        return True

    return path.suffix.lower() not in TEXT_EXTENSIONS


def is_binary(data: bytes) -> bool:
    if not data:
        return False
    if b"\0" in data:
        return True

    sample = data[:1024]
    text_chars = sum((32 <= b <= 126) or b in (9, 10, 13) for b in sample)
    return (text_chars / len(sample)) < 0.8


def generate_with_model(
    model: str,
    system_prompt_file: str | None,
    firmware_dir: Path,
    context_dir: Path,
    profile: str,
    context: str,
) -> dict[str, str]:
    try:
        from openai import OpenAI
    except ModuleNotFoundError:
        fail("Missing dependency 'openai'. Install with: pip install -e daemon-cli")
        raise AssertionError("unreachable")

    system_prompt = load_system_prompt(system_prompt_file)
    api_key = resolve_openai_api_key()
    client = OpenAI(api_key=api_key)
    prompt = build_user_prompt(firmware_dir=firmware_dir, context_dir=context_dir, profile=profile, context=context)

    response = client.responses.create(
        model=model,
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        text={
            "format": {
                "type": "json_schema",
                "name": "daemon_build_output",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["daemon_yaml", "daemon_entry_c"],
                    "properties": {
                        "daemon_yaml": {"type": "string"},
                        "daemon_entry_c": {"type": "string"},
                    },
                },
            }
        },
    )
    return parse_json_output(response)


def generate_from_template(config_id: str, profile: str) -> dict[str, str]:
    created_at = utc_now()
    safe_profile = sanitize_slug(profile) or "generic"
    if safe_profile == "rc_car_pi_arduino":
        daemon_yaml, daemon_entry_c = rc_car_templates(config_id, safe_profile, created_at)
    elif safe_profile == "greenhouse_node":
        daemon_yaml, daemon_entry_c = greenhouse_templates(config_id, safe_profile, created_at)
    elif safe_profile == "arm_manipulator":
        daemon_yaml, daemon_entry_c = arm_templates(config_id, safe_profile, created_at)
    else:
        daemon_yaml, daemon_entry_c = generic_templates(config_id, safe_profile, created_at)

    return {"daemon_yaml": daemon_yaml, "daemon_entry_c": daemon_entry_c}


def validate_generated_artifacts(payload: dict[str, str]) -> None:
    daemon_yaml = payload.get("daemon_yaml", "")
    daemon_entry_c = payload.get("daemon_entry_c", "")
    if not daemon_yaml.strip() or not daemon_entry_c.strip():
        fail("Generation returned empty artifacts.")

    required_yaml_markers = (
        "command_direction_mapping:",
        "telemetry:",
        "safety:",
    )
    missing_yaml = [marker for marker in required_yaml_markers if marker not in daemon_yaml]
    if missing_yaml:
        fail(f"Generated DAEMON.yaml missing required sections: {', '.join(missing_yaml)}")

    required_c_markers = (
        "daemon_dispatch_command(",
        "return -1;",
    )
    missing_c = [marker for marker in required_c_markers if marker not in daemon_entry_c]
    if missing_c:
        fail(f"Generated daemon_entry.c missing required dispatcher markers: {', '.join(missing_c)}")


def rc_car_templates(config_id: str, profile: str, created_at: str) -> tuple[str, str]:
    daemon_yaml = f"""schema_version: "1.0"
daemon:
  config_id: "{config_id}"
  profile: "{profile}"
  created_at: "{created_at}"
  safety:
    deadman_timeout_ms: 500
    max_abs_throttle_pct: 100
    max_abs_steering_pct: 100
transport:
  command_ingress:
    type: serial_json
    baud_rate: 115200
  telemetry_egress:
    type: serial_json
command_direction_mapping:
  drive.set:
    function: daemon_drive_set
    args:
      throttle_pct: int
      steering_pct: int
  drive.brake:
    function: daemon_drive_brake
  camera.snapshot:
    function: daemon_camera_snapshot
  safety.estop:
    function: daemon_emergency_stop
telemetry:
  events:
    - id: telemetry.state
      fields: [battery_v, speed_mps, steering_pct, throttle_pct]
    - id: vision.detection
      fields: [label, confidence, centroid_x]
"""

    daemon_entry_c = f"""#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {{
    int throttle_pct;
    int steering_pct;
    bool estop;
}} daemon_state_t;

static daemon_state_t g_state = {{0, 0, false}};

static int clamp_i32(int value, int lo, int hi) {{
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}}

static void daemon_drive_set(int throttle_pct, int steering_pct) {{
    if (g_state.estop) return;
    g_state.throttle_pct = clamp_i32(throttle_pct, -100, 100);
    g_state.steering_pct = clamp_i32(steering_pct, -100, 100);
    // TODO: map throttle/steering to PWM + servo outputs for platform wiring.
}}

static void daemon_drive_brake(void) {{
    g_state.throttle_pct = 0;
}}

static void daemon_camera_snapshot(void) {{
    // TODO: signal Raspberry Pi camera service over UART/SPI/shared memory.
}}

static void daemon_emergency_stop(void) {{
    g_state.estop = true;
    g_state.throttle_pct = 0;
}}

void daemon_clear_estop(void) {{
    g_state.estop = false;
}}

int daemon_dispatch_command(const char *cmd, int a, int b) {{
    if (strcmp(cmd, "drive.set") == 0) {{
        daemon_drive_set(a, b);
        return 0;
    }}
    if (strcmp(cmd, "drive.brake") == 0) {{
        daemon_drive_brake();
        return 0;
    }}
    if (strcmp(cmd, "camera.snapshot") == 0) {{
        daemon_camera_snapshot();
        return 0;
    }}
    if (strcmp(cmd, "safety.estop") == 0) {{
        daemon_emergency_stop();
        return 0;
    }}
    return -1;
}}

void daemon_emit_state_telemetry(void) {{
    printf(
        "{{\\\"event\\\":\\\"telemetry.state\\\",\\\"throttle_pct\\\":%d,\\\"steering_pct\\\":%d}}\\n",
        g_state.throttle_pct,
        g_state.steering_pct
    );
}}
"""
    return daemon_yaml, daemon_entry_c


def greenhouse_templates(config_id: str, profile: str, created_at: str) -> tuple[str, str]:
    daemon_yaml = f"""schema_version: "1.0"
daemon:
  config_id: "{config_id}"
  profile: "{profile}"
  created_at: "{created_at}"
  safety:
    min_target_humidity_pct: 35
    max_target_humidity_pct: 85
transport:
  command_ingress:
    type: mqtt_json
    topic: "daemon/greenhouse/cmd"
  telemetry_egress:
    type: mqtt_json
    topic: "daemon/greenhouse/events"
command_direction_mapping:
  climate.set_target_humidity:
    function: daemon_set_target_humidity
    args:
      humidity_pct: float
  irrigation.manual_override:
    function: daemon_set_irrigation_override
    args:
      enabled: bool
      duration_s: int
telemetry:
  events:
    - id: telemetry.climate
      fields: [temp_c, humidity_pct, soil_moisture_pct]
    - id: alert.sensor_fault
      fields: [sensor_name, error_code]
"""

    daemon_entry_c = """#include <stdbool.h>
#include <string.h>
#include <stdint.h>

static float g_target_humidity_pct = 55.0f;
static bool g_irrigation_override = false;
static uint32_t g_irrigation_override_until_s = 0;

static float clampf(float value, float lo, float hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

void daemon_set_target_humidity(float humidity_pct) {
    g_target_humidity_pct = clampf(humidity_pct, 35.0f, 85.0f);
}

void daemon_set_irrigation_override(bool enabled, uint32_t duration_s, uint32_t now_s) {
    g_irrigation_override = enabled;
    g_irrigation_override_until_s = now_s + duration_s;
}

bool daemon_should_run_pump(float measured_humidity_pct, uint32_t now_s) {
    if (g_irrigation_override && now_s < g_irrigation_override_until_s) {
        return true;
    }
    return measured_humidity_pct < (g_target_humidity_pct - 4.0f);
}

int daemon_dispatch_command(const char *cmd, float value_a, uint32_t value_b, uint32_t now_s) {
    if (strcmp(cmd, "climate.set_target_humidity") == 0) {
        daemon_set_target_humidity(value_a);
        return 0;
    }
    if (strcmp(cmd, "irrigation.manual_override") == 0) {
        daemon_set_irrigation_override(value_a > 0.5f, value_b, now_s);
        return 0;
    }
    return -1;
}
"""
    return daemon_yaml, daemon_entry_c


def arm_templates(config_id: str, profile: str, created_at: str) -> tuple[str, str]:
    daemon_yaml = f"""schema_version: "1.0"
daemon:
  config_id: "{config_id}"
  profile: "{profile}"
  created_at: "{created_at}"
  safety:
    enforce_joint_limits: true
    max_segment_duration_s: 10
transport:
  command_ingress:
    type: grpc
    service: "daemon.arm.CommandService"
  telemetry_egress:
    type: grpc_stream
    stream: "daemon.arm.TelemetryStream"
command_direction_mapping:
  arm.home:
    function: daemon_arm_home
  arm.stop:
    function: daemon_arm_stop
  arm.move_joint:
    function: daemon_arm_move_joint
    args:
      joint_id: int
      angle_deg: float
      duration_s: float
telemetry:
  events:
    - id: telemetry.arm_state
      fields: [joint_id, angle_deg, in_motion, error_code]
"""

    daemon_entry_c = """#include <stdbool.h>
#include <stddef.h>
#include <string.h>

typedef struct {
    float min_deg;
    float max_deg;
} limit_t;

static const limit_t JOINT_LIMITS[6] = {
    {-170.0f, 170.0f},
    {-120.0f, 120.0f},
    {-170.0f, 170.0f},
    {-190.0f, 190.0f},
    {-120.0f, 120.0f},
    {-360.0f, 360.0f},
};

static bool within_limits(size_t joint_id, float angle_deg) {
    if (joint_id >= 6) return false;
    return angle_deg >= JOINT_LIMITS[joint_id].min_deg && angle_deg <= JOINT_LIMITS[joint_id].max_deg;
}

int daemon_arm_move_joint(size_t joint_id, float angle_deg, float duration_s) {
    if (!within_limits(joint_id, angle_deg)) return -1;
    if (duration_s <= 0.0f || duration_s > 10.0f) return -2;
    // TODO: enqueue segment and stream progress telemetry.
    return 0;
}

int daemon_arm_home(void) {
    // TODO: run deterministic homing sequence with limit-switch checks.
    return 0;
}

int daemon_arm_stop(void) {
    // TODO: clear queued segments and disable motor outputs safely.
    return 0;
}

int daemon_dispatch_command(const char *cmd, size_t joint_id, float angle_deg, float duration_s) {
    if (strcmp(cmd, "arm.home") == 0) return daemon_arm_home();
    if (strcmp(cmd, "arm.stop") == 0) return daemon_arm_stop();
    if (strcmp(cmd, "arm.move_joint") == 0) return daemon_arm_move_joint(joint_id, angle_deg, duration_s);
    return -1;
}
"""
    return daemon_yaml, daemon_entry_c


def generic_templates(config_id: str, profile: str, created_at: str) -> tuple[str, str]:
    daemon_yaml = f"""schema_version: "1.0"
daemon:
  config_id: "{config_id}"
  profile: "{profile}"
  created_at: "{created_at}"
  safety:
    max_command_rate_hz: 20
transport:
  command_ingress:
    type: serial_json
    baud_rate: 115200
  telemetry_egress:
    type: serial_json
command_direction_mapping:
  device.set_mode:
    function: daemon_set_mode
    args:
      mode: string
  device.stop:
    function: daemon_stop
telemetry:
  events:
    - id: telemetry.status
      fields: [mode, uptime_s]
"""

    daemon_entry_c = """#include <string.h>

static char g_mode[16] = "idle";

void daemon_set_mode(const char *mode) {
    (void)strncpy(g_mode, mode, sizeof(g_mode) - 1);
    g_mode[sizeof(g_mode) - 1] = '\\0';
}

void daemon_stop(void) {
    daemon_set_mode("idle");
}

int daemon_dispatch_command(const char *cmd, const char *mode) {
    if (strcmp(cmd, "device.set_mode") == 0) {
        daemon_set_mode(mode);
        return 0;
    }
    if (strcmp(cmd, "device.stop") == 0) {
        daemon_stop();
        return 0;
    }
    return -1;
}
"""
    return daemon_yaml, daemon_entry_c


def build_manifest(
    config_id: str,
    profile: str,
    model: str | None,
    generation_mode: str,
    context_dir: Path,
    config_dir: Path,
    context: str,
    context_files: list[str],
    daemon_yaml_path: Path,
    daemon_entry_path: Path,
) -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "config_id": config_id,
        "profile": sanitize_slug(profile) or "generic",
        "created_at": utc_now(),
        "generation_mode": generation_mode,
        "model": model,
        "context": {
            "source_dir": str(context_dir),
            "file_count": len(context_files),
            "files": context_files,
            "sha256": hashlib.sha256(context.encode("utf-8")).hexdigest(),
        },
        "artifacts": {
            "config_dir": str(config_dir),
            "daemon_yaml_path": str(daemon_yaml_path),
            "daemon_entry_path": str(daemon_entry_path),
        },
        "api_target": {
            "collection": "daemon-configs",
            "subfolder": config_id,
        },
    }


def publish_generated_config(
    publish_url: str,
    publish_timeout: int,
    manifest: dict[str, object],
    daemon_yaml: str,
    daemon_entry_c: str,
) -> dict[str, object]:
    payload = {
        "config_id": manifest["config_id"],
        "storage_path": f"configs/{manifest['config_id']}",
        "profile": manifest["profile"],
        "created_at": manifest["created_at"],
        "manifest": manifest,
        "artifacts": {
            "DAEMON.yaml": daemon_yaml,
            "daemon_entry.c": daemon_entry_c,
        },
    }

    api_key = resolve_publish_api_key()
    body = json.dumps(payload).encode("utf-8")
    request = Request(publish_url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")

    try:
        with urlopen(request, timeout=publish_timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            return {
                "status": "success",
                "http_status": getattr(response, "status", response.getcode()),
                "url": publish_url,
                "response_body": truncate(text, 3000),
            }
    except HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        return {
            "status": "error",
            "http_status": exc.code,
            "url": publish_url,
            "error": f"HTTPError: {exc.reason}",
            "response_body": truncate(body_text, 3000),
        }
    except URLError as exc:
        return {
            "status": "error",
            "http_status": None,
            "url": publish_url,
            "error": f"URLError: {exc.reason}",
        }


def load_system_prompt(prompt_file: str | None) -> str:
    if not prompt_file:
        return DEFAULT_SYSTEM_PROMPT

    path = Path(prompt_file).resolve()
    if not path.exists() or not path.is_file():
        fail(f"System prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def build_user_prompt(
    firmware_dir: Path,
    context_dir: Path,
    profile: str,
    context: str,
) -> str:
    return (
        "Use the project context to generate exactly two files:\n"
        "1) DAEMON.yaml\n"
        "2) daemon_entry.c\n\n"
        "Hard requirements:\n"
        "- Include explicit command_direction_mapping entries in DAEMON.yaml.\n"
        "- Include function-level mapping between commands and firmware handlers.\n"
        "- Include safety checks and bounded parameters.\n"
        "- Support streaming/telemetry events that can feed downstream learning.\n"
        "- Keep code portable and suitable for embedded C toolchains.\n\n"
        f"Firmware root: {firmware_dir}\n"
        f"Context directory: {context_dir}\n"
        f"Profile label: {profile}\n\n"
        "Project context follows:\n\n"
        f"{context}"
    )


def parse_json_output(response: object) -> dict[str, str]:
    text = getattr(response, "output_text", None)
    if text:
        return json.loads(text)

    output = getattr(response, "output", None)
    if isinstance(output, list):
        for item in output:
            content = item.get("content", []) if isinstance(item, dict) else []
            for entry in content:
                if isinstance(entry, dict) and entry.get("type") == "output_text":
                    return json.loads(entry.get("text", "{}"))

    fail("Could not parse JSON output from model response")
    raise AssertionError("unreachable")


def generate_unique_config_id(configs_dir: Path, profile: str) -> str:
    safe_profile = sanitize_slug(profile) or "generic"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dt%H%M%Sz")
    configs_dir.mkdir(parents=True, exist_ok=True)
    for _ in range(100):
        candidate = f"{safe_profile}-{stamp}-{secrets.token_hex(3)}"
        if not (configs_dir / candidate).exists():
            return candidate
    fail("Failed to generate unique config id")
    raise AssertionError("unreachable")


def sanitize_slug(value: str | None) -> str:
    if not value:
        return ""
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug


def is_valid_identifier(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]+", value))


def resolve_openai_api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("OPEN_AI_API_KEY")
    if key:
        return key

    for env_file in find_env_files():
        env_vars = parse_dotenv(env_file)
        key = env_vars.get("OPENAI_API_KEY") or env_vars.get("OPEN_AI_API_KEY")
        if key:
            return key

    fail("Missing OpenAI API key. Set OPENAI_API_KEY or OPEN_AI_API_KEY (env or .env).")
    raise AssertionError("unreachable")


def resolve_publish_api_key() -> str | None:
    key = os.environ.get("DAEMON_PUBLISH_API_KEY")
    if key:
        return key
    for env_file in find_env_files():
        env_vars = parse_dotenv(env_file)
        key = env_vars.get("DAEMON_PUBLISH_API_KEY")
        if key:
            return key
    return None


def find_env_files() -> list[Path]:
    files: list[Path] = []
    for parent in [Path.cwd(), *Path.cwd().parents]:
        candidate = parent / ".env"
        if candidate.exists() and candidate.is_file():
            files.append(candidate)
    return files


def parse_dotenv(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value and len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        result[key] = value

    return result


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 3] + "..."


def fail(message: str) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
