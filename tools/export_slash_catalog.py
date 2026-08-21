#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Export the Sophia-native slash/product catalog for TUI consumers."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.slash_catalog import public_catalog, validate_catalog  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--out",
        default=str(ROOT / "apps" / "sophia-tui" / "src" / "lib" / "slash-commands.json"),
        help="output JSON path",
    )
    p.add_argument("--check", action="store_true", help="fail if output is not the deterministic catalog")
    args = p.parse_args(argv)
    out = Path(args.out)
    errors = validate_catalog()
    if errors:
        print("slash catalog invalid:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 2
    cat = public_catalog()
    rendered = json.dumps(cat, indent=2, sort_keys=False) + "\n"
    if args.check:
        try:
            current = out.read_text(encoding="utf-8")
        except OSError:
            print(f"slash catalog missing: {out}", file=sys.stderr)
            return 1
        if current != rendered:
            print(f"slash catalog drift: {out}", file=sys.stderr)
            return 1
        profiles = ",".join(cat["product_defaults"]["profile_order"])
        print(
            f"slash catalog OK: {out} "
            f"(v{cat['version']}, profiles={profiles}, sha256={cat['hash']})"
        )
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(rendered, encoding="utf-8")
    print(
        f"wrote {out} "
        f"({len(cat['commands'])} commands, v{cat['version']}, sha256={cat['hash']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
