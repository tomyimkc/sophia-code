# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Budgeted, receipt-producing system-prompt compiler.

The compiler keeps policy precedence explicit and gives local models compact
module variants instead of sending one ever-growing monolith.  It is deliberately
dependency-free: token counts are conservative character estimates and optional
modules are truncated or dropped deterministically when the budget is tight.

candidateOnly; canClaimAGI:false — prompt assembly infrastructure only.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Iterable, Literal

PromptProfile = Literal["classic", "cloud", "local"]


@dataclass(frozen=True)
class PromptModule:
    """One independently budgeted system-prompt module."""

    name: str
    text: str
    priority: int
    source: str
    required: bool = False
    local_text: str | None = None
    min_chars: int = 240

    def render(self, profile: PromptProfile) -> str:
        if profile == "local" and self.local_text is not None:
            return self.local_text.strip()
        return self.text.strip()


@dataclass(frozen=True)
class PromptModuleReceipt:
    name: str
    source: str
    priority: int
    required: bool
    action: str
    characters: int
    estimated_tokens: int


@dataclass(frozen=True)
class PromptReceipt:
    schema: str
    profile: PromptProfile
    budget_tokens: int
    estimated_tokens: int
    included: tuple[PromptModuleReceipt, ...] = field(default_factory=tuple)
    dropped: tuple[PromptModuleReceipt, ...] = field(default_factory=tuple)
    candidateOnly: bool = True
    canClaimAGI: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class CompiledPrompt:
    text: str
    receipt: PromptReceipt


def estimate_tokens(text: str) -> int:
    """Conservative provider-independent prompt-token estimate."""
    if not text:
        return 0
    # Four characters/token is common for English source/code prompts.  Round
    # upward so a short tail is never represented as free.
    return max(1, (len(text) + 3) // 4)


def default_prompt_budget(
    profile: PromptProfile,
    *,
    context_window: int | None = None,
) -> int:
    """Return the system-prompt budget for one provider profile.

    A local prompt is capped aggressively while still scaling a little for a
    model that reports a larger context window.  Classic/cloud preserve the
    historical full prompt unless an explicit lower budget is configured.
    """
    if profile == "local":
        if context_window and context_window > 0:
            return max(2_500, min(7_500, int(context_window * 0.12)))
        return 4_500
    if profile == "cloud":
        if context_window and context_window > 0:
            return max(8_000, min(24_000, int(context_window * 0.10)))
        return 16_000
    return 64_000


def _truncate(text: str, chars: int) -> str:
    if len(text) <= chars:
        return text
    if chars <= 1:
        return "…"
    cut = text[: chars - 1].rstrip()
    # Prefer a paragraph/line boundary without throwing away most of the slot.
    for marker in ("\n\n", "\n", ". "):
        idx = cut.rfind(marker)
        if idx >= chars // 2:
            cut = cut[: idx + (1 if marker == ". " else 0)].rstrip()
            break
    return cut + "…"


def compile_prompt(
    modules: Iterable[PromptModule],
    *,
    profile: PromptProfile = "classic",
    budget_tokens: int | None = None,
    context_window: int | None = None,
) -> CompiledPrompt:
    """Compile modules by precedence, preserving required policy fail-closed."""
    budget = max(
        256,
        int(
            budget_tokens
            if budget_tokens is not None
            else default_prompt_budget(profile, context_window=context_window)
        ),
    )
    char_budget = budget * 4
    ordered = sorted(
        enumerate(modules),
        key=lambda item: (-item[1].priority, item[0]),
    )
    included: list[PromptModuleReceipt] = []
    dropped: list[PromptModuleReceipt] = []
    rendered: list[str] = []
    used = 0

    for position, (_, module) in enumerate(ordered):
        body = module.render(profile)
        if not body:
            continue
        separator = 2 if rendered else 0
        # Reserve one visible character plus the join separator for every later
        # required module. This prevents an earlier optional or oversized
        # required block from consuming the entire budget and forcing the final
        # prompt beyond the caller's declared ceiling.
        future_required = [
            future
            for _, future in ordered[position + 1 :]
            if future.required and future.render(profile)
        ]
        minimum_reserve = len(future_required) * 3
        preferred_reserve = sum(
            2 + max(1, min(future.min_chars, len(future.render(profile))))
            for future in future_required
        )
        remaining_capacity = max(0, char_budget - used - separator)
        reserve = (
            preferred_reserve
            if remaining_capacity > preferred_reserve
            else minimum_reserve
        )
        available = max(0, remaining_capacity - reserve)
        action = "included"
        chosen = body
        if len(body) > available:
            if module.required:
                # Hard policy is never silently dropped.  When a caller sets an
                # unrealistically small budget, retain a bounded prefix and make
                # the truncation visible in the receipt. Never let one required
                # module silently expand the compiled prompt beyond the caller's
                # declared budget.
                chosen = _truncate(body, max(1, available))
                action = "truncated-required"
            elif available >= module.min_chars:
                chosen = _truncate(body, available)
                action = "truncated"
            else:
                receipt = PromptModuleReceipt(
                    name=module.name,
                    source=module.source,
                    priority=module.priority,
                    required=module.required,
                    action="dropped-budget",
                    characters=0,
                    estimated_tokens=0,
                )
                dropped.append(receipt)
                continue

        rendered.append(chosen)
        used += separator + len(chosen)
        included.append(
            PromptModuleReceipt(
                name=module.name,
                source=module.source,
                priority=module.priority,
                required=module.required,
                action=action,
                characters=len(chosen),
                estimated_tokens=estimate_tokens(chosen),
            )
        )

    text = "\n\n".join(rendered)
    receipt = PromptReceipt(
        schema="sophia.prompt-compiler.receipt.v1",
        profile=profile,
        budget_tokens=budget,
        estimated_tokens=estimate_tokens(text),
        included=tuple(included),
        dropped=tuple(dropped),
    )
    return CompiledPrompt(text=text, receipt=receipt)


__all__ = [
    "CompiledPrompt",
    "PromptModule",
    "PromptModuleReceipt",
    "PromptProfile",
    "PromptReceipt",
    "compile_prompt",
    "default_prompt_budget",
    "estimate_tokens",
]
