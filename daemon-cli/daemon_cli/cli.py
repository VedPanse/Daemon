from __future__ import annotations

import argparse
import os
from pathlib import Path

from daemon_cli.build import BuildError, run_build, run_clean


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="daemon", description="DAEMON CLI generator")
    sub = parser.add_subparsers(dest="command")

    build = sub.add_parser("build", help="Generate DAEMON artifacts in firmware_repo/generated")
    build.add_argument("--firmware-dir", default=os.getcwd(), help="Firmware repo path (default: cwd)")

    clean = sub.add_parser("clean", help="Remove generated folder")
    clean.add_argument("--firmware-dir", default=os.getcwd(), help="Firmware repo path (default: cwd)")

    sub.add_parser("help", help="Show help")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command in (None, "help"):
        parser.print_help()
        return 0

    firmware_dir = Path(args.firmware_dir).resolve()

    if args.command == "clean":
        cleaned = run_clean(firmware_dir)
        print(f"Removed {cleaned}")
        return 0

    if args.command == "build":
        try:
            result = run_build(firmware_dir)
        except BuildError as exc:
            print(f"ERROR: {exc}")
            return 1

        print("DAEMON build succeeded")
        print(f"- firmware: {result.firmware_dir}")
        print(f"- output: {result.generated_dir}")
        print(f"- commands: {', '.join([cmd.token for cmd in result.commands])}")
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
