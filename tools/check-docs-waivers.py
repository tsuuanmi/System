#!/usr/bin/env python3
"""Fail when the docs-waivers file (default .system/docs-waivers) has a waiver line: they are cleared at release."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else ".system/docs-waivers"
try:
    with open(path, encoding="utf-8") as f:
        lines = [l.rstrip("\n") for l in f if l.strip() and not l.lstrip().startswith("#")]
except FileNotFoundError:
    lines = []
if lines:
    print(f"{path} still has waiver lines; clear them in a release pull request (runbook, Release):", file=sys.stderr)
    for l in lines:
        print(f"  {l}", file=sys.stderr)
    sys.exit(1)
