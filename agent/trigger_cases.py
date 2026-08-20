#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Sealed intent→tool case set for the /bench trigger benchmark.

Each case is a user intent paired with the tool/skill a correct agent SHOULD call
(or ``None`` for negative cases — plain questions that must NOT trigger a tool).
The benchmark runs the model with surfacing ON, one short turn per case, and
scores whether it triggered the right tool with valid args.

The intents are SYNTHETIC (not eval prompts) and do not overlap any held-out eval
surface — no contamination. They are designed to exercise each surfaced tool's
trigger condition (the whenToUse text) plus negatives for over-trigger.

candidateOnly: true · canClaimAGI: false — methodology cases, not a capability claim.
"""
from __future__ import annotations

from typing import Any

# decision: "must_call" (the model should call a tool) or "no_tool" (it should NOT)
CASES: list[dict[str, Any]] = [
    # ── sophia_source_verify: citation / attribution audit ──────────────
    {
        "id": "src_verify_cite",
        "intent": "Before I publish this, check whether the study it cites is real: "
                  "\"A 2023 Yale study found that polyphenols reverse aging.\" Does that study exist?",
        "expected": "sophia_source_verify",
        "decision": "must_call",
    },
    {
        "id": "src_verify_attrib",
        "intent": "Who really painted the Mona Lisa? A draft says Raphael — verify the attribution "
                  "before I trust it.",
        "expected": "sophia_source_verify",
        "decision": "must_call",
    },
    # ── sophia_conscience_check: safety / over-claim gate ───────────────
    {
        "id": "conscience_publish",
        "intent": "Is it safe to publish this draft reply? Gate it for over-claiming and safety "
                  "before I send it: \"This treatment cures the disease completely.\"",
        "expected": "sophia_conscience_check",
        "decision": "must_call",
    },
    {
        "id": "conscience_action",
        "intent": "I'm about to run a command that deletes user data. Check whether that action "
                  "is safe to take.",
        "expected": "sophia_conscience_check",
        "decision": "must_call",
    },
    # ── sophia_check_claim: provenance/attribution gate ─────────────────
    {
        "id": "check_claim_attrib",
        "intent": "Check this claim against the provenance corpus before I assert it: "
                  "\"The Analects were written by Laozi.\"",
        "expected": "sophia_check_claim",
        "decision": "must_call",
    },
    # ── sophia_memory_store: persist a learning ─────────────────────────
    {
        "id": "memory_remember_fix",
        "intent": "Remember for next time: restarting oMLX fixes the stall we just hit. "
                  "Store that so I don't repeat the debug.",
        "expected": "sophia_memory_store",
        "decision": "must_call",
    },
    {
        "id": "memory_remember_fact",
        "intent": "Save this learning: the regex-log test needs /app paths, so host scoring defers.",
        "expected": "sophia_memory_store",
        "decision": "must_call",
    },
    # ── invoke_skill (skill catalog, surfacing ON only) ─────────────────
    {
        "id": "skill_coding_debug",
        "intent": "Debug this failing test — it's raising AssertionError on line 42 and I can't "
                  "see why. Help me fix it.",
        "expected": "invoke_skill",
        "expected_skill": "coding-debugging",
        "decision": "must_call",
    },
    {
        "id": "skill_tdd",
        "intent": "I need to implement a new feature following TDD — write the failing test first, "
                  "then the code. Walk me through it.",
        "expected": "invoke_skill",
        "expected_skill": "tdd-implementation",
        "decision": "must_call",
    },
    {
        "id": "skill_source_verification",
        "intent": "Audit this answer for fabricated citations and attribution swaps using external "
                  "records, as a structured workflow.",
        "expected": "invoke_skill",
        "expected_skill": "source-verification",
        "decision": "must_call",
    },
    # ── web_search: current/web information lookup ─────────────────────
    {
        "id": "web_search_news",
        "intent": "What's the latest news on AI agent frameworks? Search the web for recent "
                  "developments this month.",
        "expected": "web_search",
        "decision": "must_call",
    },
    {
        "id": "web_search_docs",
        "intent": "Look up the current MLX documentation — what fine-tuning APIs does it support "
                  "now? I need the latest, not your training data.",
        "expected": "web_search",
        "decision": "must_call",
    },
    {
        "id": "web_search_papers",
        "intent": "Search for recent papers on mixture-of-experts scaling laws published in 2026. "
                  "I need actual search results, not your memory.",
        "expected": "web_search",
        "decision": "must_call",
    },
    # ── NEGATIVES: plain questions that must NOT trigger a tool ─────────
    {
        "id": "neg_general_knowledge",
        "intent": "What is the capital of France? Just answer directly.",
        "expected": None,
        "decision": "no_tool",
    },
    {
        "id": "neg_smalltalk",
        "intent": "Thanks, that's helpful. How are you today?",
        "expected": None,
        "decision": "no_tool",
    },
    {
        "id": "neg_opinion",
        "intent": "Do you prefer mountains or beaches? I'm curious what you think.",
        "expected": None,
        "decision": "no_tool",
    },
    {
        "id": "neg_definition",
        "intent": "Define 'recursion' in one sentence.",
        "expected": None,
        "decision": "no_tool",
    },
    {
        "id": "neg_math",
        "intent": "What is 17 times 24?",
        "expected": None,
        "decision": "no_tool",
    },
]


def load_cases(*, include_skills: bool = True) -> list[dict[str, Any]]:
    """Return the case set. ``include_skills=False`` drops the invoke_skill cases
    (used when surfacing is OFF, since those cases are unsolvable without it)."""
    if include_skills:
        return list(CASES)
    return [c for c in CASES if c["expected"] != "invoke_skill"]
