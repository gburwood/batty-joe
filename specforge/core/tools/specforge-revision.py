#!/usr/bin/env python3
"""Capture and verify provider-neutral immutable material revisions."""
from pathlib import Path
import argparse
import json
import subprocess
import sys

from specforge_project import (
    discover_layout,
    git_worktree_root,
    material_snapshot,
    verify_source_revision,
)


def capture(layout):
    if git_worktree_root(layout) is not None:
        result = subprocess.run(
            ["git", "-C", str(layout.root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
        )
        if result.returncode:
            return {"captured": False, "provider": "git", "blockers": ["git_head_unavailable"]}
        revision = result.stdout.strip()
        check = verify_source_revision(
            layout,
            {
                "system": "git",
                "before": revision,
                "after": revision,
                "material_effects": False,
            },
            mode="transition",
            require_provider=True,
        )
        return {
            "captured": check.get("valid", False),
            "provider": "git",
            "revision": revision,
            "blockers": check.get("blockers") or [],
            "details": check.get("details") or {},
        }

    snapshot = material_snapshot(layout)
    return {
        "captured": True,
        "provider": "specforge_snapshot",
        "revision": snapshot["revision"],
        "file_count": snapshot["file_count"],
        "blockers": [],
    }


def verify(layout, args):
    check = verify_source_revision(
        layout,
        {
            "system": args.provider,
            "before": args.before,
            "after": args.after,
            "material_effects": not args.allow_same,
        },
        mode=args.mode,
        require_provider=args.mode == "transition",
    )
    return {
        "valid": check.get("valid", False),
        "provider": check.get("provider"),
        "blockers": check.get("blockers") or [],
        "details": check.get("details") or {},
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    capture_parser = sub.add_parser("capture")
    capture_parser.add_argument("--root", default=".")
    capture_parser.add_argument("--json", action="store_true")

    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--root", default=".")
    verify_parser.add_argument("--provider", required=True)
    verify_parser.add_argument("--before", required=True)
    verify_parser.add_argument("--after", required=True)
    verify_parser.add_argument("--mode", choices=("static", "transition"), default="transition")
    verify_parser.add_argument("--allow-same", action="store_true")
    verify_parser.add_argument("--json", action="store_true")

    args = parser.parse_args()
    try:
        layout = discover_layout(Path(args.root).resolve())
    except Exception as exc:
        out = {"captured": False, "valid": False, "blockers": [f"project_discovery_failed:{exc}"]}
        print(json.dumps(out, indent=2) if getattr(args, "json", False) else "REFUSED\n - " + out["blockers"][0])
        sys.exit(1)

    out = capture(layout) if args.command == "capture" else verify(layout, args)
    ok = out.get("captured", out.get("valid", False))
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        print(("CAPTURED" if args.command == "capture" else "VALID") if ok else "REFUSED")
        for blocker in out.get("blockers") or []:
            print(" - " + blocker)
        if out.get("revision"):
            print(" revision: " + out["revision"])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
