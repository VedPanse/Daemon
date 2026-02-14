from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Iterable

from openai import OpenAI

DEFAULT_SYSTEM_PROMPT = (
    "You are a firmware code generation assistant. "
    "Generate DAEMON.yaml and daemon_entry.c from the provided project context."
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


def main() -> None:
    parser = argparse.ArgumentParser(prog="daemon")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser = subparsers.add_parser("build", help="Generate firmware artifacts")
    build_parser.add_argument(
        "--firmware-dir",
        default="firmware-code",
        help="Directory containing firmware source/context",
    )
    build_parser.add_argument(
        "--model",
        default=os.environ.get("DAEMON_MODEL", "gpt-5"),
        help="OpenAI model to use",
    )
    build_parser.add_argument(
        "--system-prompt-file",
        default=None,
        help="Optional file containing the system prompt",
    )
    build_parser.add_argument(
        "--daemon-yaml-path",
        default=None,
        help="Output path for DAEMON.yaml (defaults to <firmware-dir>/DAEMON.yaml)",
    )
    build_parser.add_argument(
        "--daemon-entry-path",
        default=None,
        help="Output path for daemon_entry.c (defaults to <firmware-dir>/daemon_entry.c)",
    )
    build_parser.set_defaults(handler=handle_build)

    args = parser.parse_args()
    args.handler(args)


def handle_build(args: argparse.Namespace) -> None:
    firmware_dir = Path(args.firmware_dir).resolve()
    if not firmware_dir.exists() or not firmware_dir.is_dir():
        fail(f"Firmware directory not found: {firmware_dir}")

    system_prompt = load_system_prompt(args.system_prompt_file)

    daemon_yaml_path = (
        Path(args.daemon_yaml_path).resolve()
        if args.daemon_yaml_path
        else firmware_dir / "DAEMON.yaml"
    )
    daemon_entry_path = (
        Path(args.daemon_entry_path).resolve()
        if args.daemon_entry_path
        else firmware_dir / "daemon_entry.c"
    )

    context = collect_context(firmware_dir, excluded={daemon_yaml_path, daemon_entry_path})
    if not context.strip():
        fail(f"No text files found in {firmware_dir}")

    api_key = resolve_openai_api_key()
    client = OpenAI(api_key=api_key)
    prompt = build_user_prompt(firmware_dir, context)

    response = client.responses.create(
        model=args.model,
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

    payload = parse_json_output(response)

    daemon_yaml_path.parent.mkdir(parents=True, exist_ok=True)
    daemon_entry_path.parent.mkdir(parents=True, exist_ok=True)

    daemon_yaml_path.write_text(payload["daemon_yaml"], encoding="utf-8")
    daemon_entry_path.write_text(payload["daemon_entry_c"], encoding="utf-8")

    print(f"Wrote {daemon_yaml_path}")
    print(f"Wrote {daemon_entry_path}")


def collect_context(root: Path, excluded: set[Path]) -> str:
    sections: list[str] = []
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

        if is_binary(raw):
            continue

        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("utf-8", errors="replace")

        relative = path.relative_to(root)
        sections.append(f"## FILE: {relative}\n```\n{content}\n```")

    return "\n\n".join(sections)


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            yield path


def should_skip(path: Path) -> bool:
    parts = set(path.parts)
    if ".git" in parts or "__pycache__" in parts:
        return True

    if path.suffix.lower() in TEXT_EXTENSIONS:
        return False

    if path.suffix == "":
        return True

    return False


def is_binary(data: bytes) -> bool:
    if not data:
        return False
    if b"\0" in data:
        return True

    sample = data[:1024]
    text_chars = sum((32 <= b <= 126) or b in (9, 10, 13) for b in sample)
    return (text_chars / len(sample)) < 0.8


def load_system_prompt(prompt_file: str | None) -> str:
    if not prompt_file:
        return DEFAULT_SYSTEM_PROMPT

    path = Path(prompt_file).resolve()
    if not path.exists() or not path.is_file():
        fail(f"System prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def build_user_prompt(firmware_dir: Path, context: str) -> str:
    return (
        "Use the project context to generate exactly two files:\n"
        "1) DAEMON.yaml\n"
        "2) daemon_entry.c\n\n"
        f"Project root for context: {firmware_dir}\n\n"
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
            for c in content:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    return json.loads(c.get("text", "{}"))

    fail("Could not parse JSON output from model response")
    raise AssertionError("unreachable")


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


def fail(message: str) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
