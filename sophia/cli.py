# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Console entrypoint for the Sophia AGI package."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from sophia import __version__

PACKAGE_COMMANDS = {"experiment", "train", "eval", "promote", "app-bridge"}


def _add_config_args(parser: argparse.ArgumentParser, *, allow_execute: bool) -> None:
    parser.add_argument("--config", required=True, help="experiment config JSON/TOML")
    parser.add_argument("--repo-root", default=".", help="repository root for script execution")
    parser.add_argument("--json", action="store_true", help="print the command plan as JSON")
    parser.add_argument(
        "--live",
        action="store_true",
        help="compile live commands without --dry-run; requires explicit --execute to run",
    )
    if allow_execute:
        parser.add_argument(
            "--execute",
            action="store_true",
            help="run the compiled commands in order; defaults remain dry-run unless --live is set",
        )


def _render_plan(config_path: str, config_name: str, plan: list, *, json_output: bool) -> None:
    payload = {
        "config": config_path,
        "name": config_name,
        "commands": [spec.to_dict() for spec in plan],
    }
    if json_output:
        print(json.dumps(payload, indent=2))
        return
    print(f"Sophia experiment: {config_name}")
    if not plan:
        print("No enabled stages selected.")
        return
    for spec in plan:
        mode = "dry-run" if spec.dry_run else "live"
        gpu = " (GPU when live)" if spec.gpu_required_when_live else ""
        print(f"[{spec.stage}] {mode}{gpu}: {spec.shell()}")


def _handle_configured_command(
    args: argparse.Namespace, stages: tuple[str, ...] | None, *, execute: bool
) -> int:
    from sophia.trainer import build_experiment_plan, execute_plan, load_experiment_config

    config = load_experiment_config(args.config)
    plan = build_experiment_plan(config, stages=stages, dry_run=not args.live)
    _render_plan(args.config, config.name, plan, json_output=args.json)
    if execute:
        return execute_plan(plan, cwd=Path(args.repo_root))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sophia",
        description=(
            "Sophia verifier-gated training/proof CLI. This packages AGI-candidate "
            "workflow machinery, not an AGI claim."
        ),
    )
    parser.add_argument("--version", action="version", version=f"sophia {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    experiment = subparsers.add_parser("experiment", help="plan or run a full experiment config")
    experiment_sub = experiment.add_subparsers(dest="experiment_command", required=True)
    plan = experiment_sub.add_parser("plan", help="print the full command plan")
    _add_config_args(plan, allow_execute=False)
    run = experiment_sub.add_parser("run", help="print or execute the full command plan")
    _add_config_args(run, allow_execute=True)

    train = subparsers.add_parser("train", help="plan or execute data/SFT/DPO/RLVR stages")
    _add_config_args(train, allow_execute=True)
    eval_cmd = subparsers.add_parser("eval", help="plan or execute eval-ladder stage")
    _add_config_args(eval_cmd, allow_execute=True)
    promote = subparsers.add_parser("promote", help="plan or execute promotion gate stage")
    _add_config_args(promote, allow_execute=True)
    code = subparsers.add_parser(
        "code",
        help="run the Sophia Code terminal agent (interactive, headless, or JSON)",
        add_help=False,
    )
    code.add_argument(
        "code_args",
        nargs=argparse.REMAINDER,
        help="arguments passed through to the Sophia Code terminal agent",
    )
    app_bridge = subparsers.add_parser(
        "app-bridge",
        help="JSON bridge for Sophia App and GUI shells",
        add_help=False,
    )
    app_bridge.add_argument(
        "app_bridge_args",
        nargs=argparse.REMAINDER,
        help="arguments passed through to the Sophia App bridge",
    )
    return parser


def lite_main(argv: list[str] | None = None) -> int:
    """Console script ``sophia-lite`` — same as ``sophia lite``."""
    extra = list(sys.argv[1:] if argv is None else argv)
    return main(["lite", *extra])


def main(argv: list[str] | None = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    # Sophia is primarily a terminal agent command. Keep the older training/proof
    # subcommands intact, but make ``sophia`` / ``sophia -p ...`` / ``sophia
    # --json ...`` behave like a normal CLI tool instead of forcing users through
    # ``sophia code``. This mirrors agent-native CLI harnesses: a single command
    # offers REPL, help, JSON/script mode, and direct task execution.
    if not raw_argv:
        from agent.cli import main as code_main

        return code_main([])
    if raw_argv and raw_argv[0] in {"lite", "--lite"}:
        from sophia.lite import prepare_lite_env, wants_python_cli

        rest, patch = prepare_lite_env(raw_argv, env=os.environ)
        os.environ.update(patch)
        if wants_python_cli(rest) or os.environ.get("SOPHIA_UI") == "python":
            from agent.cli import main as code_main

            return code_main(rest)
        from sophia.tui_launch import run_tui

        # Windows cannot exec the POSIX bash launcher. Keep bash+stty on
        # Unix when the file is executable; otherwise use the portable TUI
        # spawn (also the path `bin/sophia.cmd` takes via this module).
        if os.name != "nt":
            launcher = Path(__file__).resolve().parents[1] / "bin" / "sophia"
            if launcher.is_file() and os.access(launcher, os.X_OK):
                os.execv(str(launcher), [str(launcher), "lite", *rest])
        return run_tui(rest)
    if raw_argv and raw_argv[0] == "code":
        from agent.cli import main as code_main

        return code_main(raw_argv[1:])
    if raw_argv and raw_argv[0] == "app-bridge":
        from agent.app_bridge import main as app_bridge_main

        return app_bridge_main(raw_argv[1:])
    if raw_argv[0] != "--version" and raw_argv[0] not in PACKAGE_COMMANDS:
        from agent.cli import main as code_main

        return code_main(raw_argv)
    parser = build_parser()
    args = parser.parse_args(raw_argv)
    try:
        if args.command == "experiment":
            execute = bool(getattr(args, "execute", False))
            return _handle_configured_command(args, None, execute=execute)
        if args.command in {"train", "eval", "promote"}:
            from sophia.trainer.plan import EVAL_STAGES, PROMOTION_STAGES, TRAINING_STAGES
            stages = {"train": TRAINING_STAGES, "eval": EVAL_STAGES, "promote": PROMOTION_STAGES}[args.command]
            return _handle_configured_command(args, stages, execute=args.execute)
        if args.command == "code":
            from agent.cli import main as code_main

            return code_main(args.code_args)
        if args.command == "app-bridge":
            from agent.app_bridge import main as app_bridge_main

            return app_bridge_main(getattr(args, "app_bridge_args", []))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"sophia: {exc}", file=sys.stderr)
        return 2
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
