#!/usr/bin/env python3
"""Record a Time Profiler trace with xcrun xctrace."""

from __future__ import annotations

import argparse
import subprocess


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record a macOS/iOS Time Profiler trace by attach or launch.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--attach", metavar="PID", help="process id to attach to")
    mode.add_argument("--launch", metavar="BINARY", help="binary path to launch")
    parser.add_argument("--trace", required=True, metavar="PATH", help="output .trace path")
    parser.add_argument("--duration", default="90s", help="capture duration, default: 90s")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    command = [
        "xcrun",
        "xctrace",
        "record",
        "--template",
        "Time Profiler",
        "--time-limit",
        args.duration,
        "--output",
        args.trace,
    ]
    if args.attach:
        command.extend(["--attach", args.attach])
    else:
        command.extend(["--launch", "--", args.launch])
    return subprocess.run(command).returncode


if __name__ == "__main__":
    raise SystemExit(main())
