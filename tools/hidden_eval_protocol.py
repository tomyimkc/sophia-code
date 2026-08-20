#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
from __future__ import annotations
"""Validate, template, and score Sophia hidden evaluation packs.

The hidden pack itself should stay outside git. Public repos should contain only
schema, protocols, aggregate reports, and salted commitments.
"""

import argparse
import json
import re
from pathlib import Path
from typing import Any

DOMAINS = {
    "philosophy",
    "psychology",
    "history",
    "logic",
    "coding",
    "planning",
    "tool_use",
    "learning",
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_pack(pack: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not pack.get("packId"):
        errors.append("missing packId")
    if pack.get("visibility") not in {"private-hidden", "revealed-after-eval"}:
        errors.append("visibility must be private-hidden or revealed-after-eval")
    cases = pack.get("cases")
    if not isinstance(cases, list) or not cases:
        errors.append("cases must be a non-empty list")
        return errors
    seen: set[str] = set()
    for index, case in enumerate(cases):
        prefix = f"cases[{index}]"
        case_id = case.get("id")
        if not case_id:
            errors.append(f"{prefix}: missing id")
        elif case_id in seen:
            errors.append(f"{prefix}: duplicate id {case_id}")
        else:
            seen.add(case_id)
        if case.get("domain") not in DOMAINS:
            errors.append(f"{prefix}: unknown domain {case.get('domain')!r}")
        if not case.get("prompt"):
            errors.append(f"{prefix}: missing prompt")
        scoring = case.get("scoring")
        if not isinstance(scoring, dict):
            errors.append(f"{prefix}: missing scoring object")
            continue
        max_points = scoring.get("maxPoints")
        if "maxPoints" not in scoring:
            errors.append(f"{prefix}: missing scoring.maxPoints")
        elif not isinstance(max_points, (int, float)) or max_points <= 0:
            errors.append(f"{prefix}: scoring.maxPoints must be a positive number")
        if not scoring.get("rubric"):
            errors.append(f"{prefix}: missing scoring.rubric")
        for field in ("mustInclude", "mustAvoid"):
            if field in scoring and not isinstance(scoring[field], list):
                errors.append(f"{prefix}: scoring.{field} must be a list")
            for item_index, item in enumerate(scoring.get(field, [])):
                errors.extend(_validate_match_item(item, f"{prefix}: scoring.{field}[{item_index}]"))
        if "aliases" in scoring and not isinstance(scoring["aliases"], dict):
            errors.append(f"{prefix}: scoring.aliases must be an object")
        for alias_key, alias_values in scoring.get("aliases", {}).items() if isinstance(scoring.get("aliases"), dict) else []:
            if not isinstance(alias_values, list):
                errors.append(f"{prefix}: scoring.aliases[{alias_key!r}] must be a list")
                continue
            for alias_index, alias in enumerate(alias_values):
                errors.extend(_validate_match_item(alias, f"{prefix}: scoring.aliases[{alias_key!r}][{alias_index}]"))
        if "semanticChecks" in scoring and not isinstance(scoring["semanticChecks"], list):
            errors.append(f"{prefix}: scoring.semanticChecks must be a list")
        for semantic_index, item in enumerate(scoring.get("semanticChecks", [])):
            if not isinstance(item, dict) or not item.get("id") or not item.get("description"):
                errors.append(f"{prefix}: scoring.semanticChecks[{semantic_index}] must include id and description")
        if "manualReview" in scoring and not isinstance(scoring["manualReview"], str):
            errors.append(f"{prefix}: scoring.manualReview must be a string")
        if case.get("requiresToolLog") and case.get("domain") != "tool_use":
            errors.append(f"{prefix}: requiresToolLog is only valid for tool_use cases")
        if case.get("requiresMemoryDiff") and case.get("domain") != "learning":
            errors.append(f"{prefix}: requiresMemoryDiff is only valid for learning cases")
        if "learningProtocol" in case and case.get("domain") != "learning":
            errors.append(f"{prefix}: learningProtocol is only valid for learning cases")
    return errors


def response_template(pack: dict[str, Any]) -> dict[str, Any]:
    return {
        "packId": pack["packId"],
        "model": "model-under-test",
        "date": "YYYY-MM-DD",
        "responses": {case["id"]: "" for case in pack["cases"]},
        "logs": {},
        "artifacts": {},
    }


def _validate_match_item(item: Any, prefix: str) -> list[str]:
    errors: list[str] = []
    if isinstance(item, str):
        pattern = item
    elif isinstance(item, dict):
        pattern = item.get("match")
        if not isinstance(pattern, str) or not pattern:
            errors.append(f"{prefix}: object item must include non-empty match")
            return errors
        aliases = item.get("aliases", [])
        if aliases and not isinstance(aliases, list):
            errors.append(f"{prefix}: aliases must be a list")
        for alias_index, alias in enumerate(aliases if isinstance(aliases, list) else []):
            if not isinstance(alias, str):
                errors.append(f"{prefix}: aliases[{alias_index}] must be a string")
            else:
                errors.extend(_validate_match_item(alias, f"{prefix}: aliases[{alias_index}]"))
    else:
        errors.append(f"{prefix}: item must be a string or object")
        return errors
    if pattern.startswith("re:"):
        try:
            re.compile(pattern[3:])
        except re.error as exc:
            errors.append(f"{prefix}: invalid regex: {exc}")
    return errors


def _match_text(text: str, pattern: str) -> bool:
    if pattern.startswith("re:"):
        try:
            return bool(re.search(pattern[3:], text, re.IGNORECASE))
        except re.error:
            return False
    return pattern.lower() in text.lower()


def _match_any(text: str, options: list[str]) -> bool:
    return any(_match_text(text, option) for option in options)


def _include_passed(text: str, item: Any, aliases: dict[str, list[str]]) -> bool:
    if isinstance(item, dict):
        options = [str(item.get("match", "")), *[str(v) for v in item.get("aliases", [])]]
        return _match_any(text, [option for option in options if option])
    key = str(item)
    return _match_any(text, [key, *aliases.get(key, [])])


def _avoid_failed(text: str, item: Any, aliases: dict[str, list[str]]) -> bool:
    if isinstance(item, dict):
        options = [str(item.get("match", "")), *[str(v) for v in item.get("aliases", [])]]
        return _match_any(text, [option for option in options if option])
    key = str(item)
    return _match_any(text, [key, *aliases.get(key, [])])


def score_case(
    case: dict[str, Any],
    response: str,
    *,
    tool_log: dict[str, Any] | None = None,
    memory_diff: dict[str, Any] | None = None,
    manual_judgement: dict[str, Any] | None = None,
) -> dict[str, Any]:
    scoring = case["scoring"]
    text = response
    must_include = scoring.get("mustInclude", [])
    must_avoid = scoring.get("mustAvoid", [])
    semantic_checks = scoring.get("semanticChecks", [])
    aliases = scoring.get("aliases", {})
    passed_include = [item for item in must_include if _include_passed(text, item, aliases)]
    failed_include = [item for item in must_include if not _include_passed(text, item, aliases)]
    failed_avoid = [item for item in must_avoid if _avoid_failed(text, item, aliases)]
    checks = len(must_include) + len(must_avoid)
    passed_checks = len(passed_include) + (len(must_avoid) - len(failed_avoid))
    manual_semantic = (manual_judgement or {}).get("semanticChecks", {})
    semantic_results: list[dict[str, Any]] = []
    for index, item in enumerate(semantic_checks, 1):
        check_id = str(item.get("id") or f"semantic_{index}") if isinstance(item, dict) else f"semantic_{index}"
        judgement = manual_semantic.get(check_id, {}) if isinstance(manual_semantic, dict) else {}
        review_state = _manual_review_state(judgement)
        semantic_results.append(
            {
                "id": check_id,
                "description": item.get("description", "") if isinstance(item, dict) else str(item),
                "status": review_state["status"],
                "judge": review_state["judge"],
                "notes": review_state["notes"],
                "reviewers": review_state["reviewers"],
            }
        )
    checks += len(semantic_checks)
    passed_checks += sum(1 for result in semantic_results if result["status"] == "passed")
    tool_ok = True
    memory_ok = True
    operational_failures: list[str] = []
    pending_semantic = [result["id"] for result in semantic_results if result["status"] == "pending-manual-review"]
    adjudication_needed = [result["id"] for result in semantic_results if result["status"] == "needs-adjudication"]
    if pending_semantic:
        operational_failures.append(f"manual semantic review pending: {', '.join(pending_semantic)}")
    if adjudication_needed:
        operational_failures.append(f"manual semantic review needs adjudication: {', '.join(adjudication_needed)}")
    if case.get("requiresToolLog"):
        commands = tool_log.get("commands", []) if tool_log else []
        tool_ok = bool(commands) and all("returncode" in command for command in commands)
        tool_ok = tool_ok and all(
            command.get("returncode") == 0 or command.get("allowFailure") is True
            for command in commands
        )
        checks += 1
        passed_checks += 1 if tool_ok else 0
        if not tool_ok:
            operational_failures.append("missing or failing required tool log")
    if case.get("requiresMemoryDiff"):
        memory_ok = bool(memory_diff and memory_diff.get("appended") and not memory_diff.get("oldHashChanged"))
        checks += 1
        passed_checks += 1 if memory_ok else 0
        if not memory_ok:
            operational_failures.append("missing append-only memory diff or old hash changed")
    empty_response = not response.strip()
    if empty_response:
        operational_failures.append("empty model response")
    max_points = scoring.get("maxPoints", 1)
    score = 0 if empty_response else (round(max_points * (passed_checks / checks), 2) if checks else max_points)
    return {
        "id": case["id"],
        "domain": case["domain"],
        "score": score,
        "maxPoints": max_points,
        "passed": bool(not empty_response and checks > 0 and passed_checks == checks),
        "passedChecks": 0 if empty_response else passed_checks,
        "totalChecks": checks,
        "emptyResponse": empty_response,
        "failedInclude": failed_include,
        "failedAvoid": failed_avoid,
        "semanticResults": semantic_results,
        "operationalFailures": operational_failures,
        "missedRubric": missed_rubric_summary(failed_include, failed_avoid, semantic_results, operational_failures),
        "requiresManualReview": bool(scoring.get("manualReview") or semantic_checks),
        "manualReview": scoring.get(
            "manualReview",
            "semantic-review-required" if semantic_checks else "pending",
        ),
        "manualRubric": scoring.get("rubric", []),
    }


def _manual_review_state(judgement: Any) -> dict[str, Any]:
    if not isinstance(judgement, dict):
        return {"status": "pending-manual-review", "judge": None, "notes": None, "reviewers": []}
    reviewers = judgement.get("reviewers")
    if isinstance(reviewers, list) and reviewers:
        normalized = [review for review in reviewers if isinstance(review, dict)]
        passed_values = [review.get("passed") for review in normalized if isinstance(review.get("passed"), bool)]
        if len(passed_values) < 2:
            return {
                "status": "pending-manual-review",
                "judge": None,
                "notes": "requires two independent reviewers",
                "reviewers": normalized,
            }
        if all(value is True for value in passed_values):
            return {
                "status": "passed",
                "judge": "two-pass-review",
                "notes": _join_review_notes(normalized),
                "reviewers": normalized,
            }
        if all(value is False for value in passed_values):
            return {
                "status": "failed",
                "judge": "two-pass-review",
                "notes": _join_review_notes(normalized),
                "reviewers": normalized,
            }
        adjudication = judgement.get("adjudication", {})
        if isinstance(adjudication, dict) and isinstance(adjudication.get("passed"), bool):
            return {
                "status": "passed" if adjudication["passed"] else "failed",
                "judge": adjudication.get("judge", "adjudicator"),
                "notes": adjudication.get("notes", ""),
                "reviewers": normalized,
            }
        return {
            "status": "needs-adjudication",
            "judge": None,
            "notes": "reviewers disagree; adjudication required",
            "reviewers": normalized,
        }
    if isinstance(judgement.get("passed"), bool):
        return {
            "status": "passed" if judgement["passed"] else "failed",
            "judge": judgement.get("judge"),
            "notes": judgement.get("notes"),
            "reviewers": [],
        }
    return {"status": "pending-manual-review", "judge": None, "notes": None, "reviewers": []}


def _join_review_notes(reviewers: list[dict[str, Any]]) -> str:
    notes = [str(review.get("notes", "")).strip() for review in reviewers if str(review.get("notes", "")).strip()]
    return " | ".join(notes)


def _public_label(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("label") or item.get("id") or item.get("match") or "unnamed check")
    return str(item)


def missed_rubric_summary(
    failed_include: list[Any],
    failed_avoid: list[Any],
    semantic_results: list[dict[str, Any]],
    operational_failures: list[str],
) -> list[dict[str, str]]:
    missed: list[dict[str, str]] = []
    for item in failed_include:
        missed.append(
            {
                "type": "missing-required-evidence",
                "label": _public_label(item),
                "repairHint": "Add the required concept, evidence, or operational proof explicitly.",
            }
        )
    for item in failed_avoid:
        missed.append(
            {
                "type": "forbidden-claim-present",
                "label": _public_label(item),
                "repairHint": "Remove or qualify the forbidden claim and explain the safer alternative.",
            }
        )
    for result in semantic_results:
        if result["status"] in {"failed", "pending-manual-review", "needs-adjudication"}:
            missed.append(
                {
                    "type": f"semantic-{result['status']}",
                    "label": result["id"],
                    "repairHint": result.get("description") or "Address the semantic judge criterion.",
                }
            )
    for failure in operational_failures:
        missed.append(
            {
                "type": "operational-evidence",
                "label": failure,
                "repairHint": "Provide concrete logs, memory diffs, or review evidence instead of assertions.",
            }
        )
    return missed


def score_pack(pack: dict[str, Any], responses: dict[str, Any]) -> dict[str, Any]:
    response_map = responses.get("responses", responses)
    tool_logs = responses.get("toolLogs", {})
    memory_diffs = responses.get("memoryDiffs", {})
    manual_judgements = responses.get("manualJudgements", {})
    results = [
        score_case(
            case,
            str(response_map.get(case["id"], "")),
            tool_log=tool_logs.get(case["id"]),
            memory_diff=memory_diffs.get(case["id"]),
            manual_judgement=manual_judgements.get(case["id"]),
        )
        for case in pack["cases"]
    ]
    total = sum(float(result["maxPoints"]) for result in results)
    earned = sum(float(result["score"]) for result in results)
    return {
        "packId": pack["packId"],
        "model": responses.get("model", "unknown"),
        "passed": sum(1 for result in results if result["passed"]),
        "totalCases": len(results),
        "score": earned,
        "maxScore": total,
        "scorePct": round((earned / total) * 100, 2) if total else 0,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Sophia hidden evaluation protocol")
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate")
    p_validate.add_argument("pack", type=Path)

    p_template = sub.add_parser("template")
    p_template.add_argument("pack", type=Path)
    p_template.add_argument("--out", type=Path, required=True)

    p_score = sub.add_parser("score")
    p_score.add_argument("pack", type=Path)
    p_score.add_argument("responses", type=Path)
    p_score.add_argument("--out", type=Path)
    p_score.add_argument("--manual-review", type=Path)

    args = parser.parse_args()
    pack = load_json(args.pack)
    errors = validate_pack(pack)
    if errors:
        print(json.dumps({"ok": False, "errors": errors}, indent=2, ensure_ascii=False))
        return 1

    if args.command == "validate":
        print(json.dumps({"ok": True, "packId": pack["packId"], "cases": len(pack["cases"])}, indent=2))
        return 0

    if args.command == "template":
        payload = response_template(pack)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {args.out}")
        return 0

    if args.command == "score":
        responses = load_json(args.responses)
        if args.manual_review:
            review = load_json(args.manual_review)
            responses["manualJudgements"] = review.get("manualJudgements", review)
        report = score_pack(pack, responses)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"Wrote {args.out}")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
