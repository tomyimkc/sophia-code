# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Hard-floor guard for streamed tokens, applied before they reach any client.

The delivery gate (``agent/conscience_runtime.apply_delivery_gate``) evaluates
the FINAL answer at the end of the agent loop. Streaming is emitted while the
model is still generating, so without this guard a client can display raw text
from an answer the gate is about to block — the user has already read it by the
time the verdict lands.

This closes that window on the SERVER side of the bridge protocol rather than in
a particular UI, so the property holds for every client, present and future.

It is a DELAY LINE, not a periodic sampler. Text is buffered and only released
once it has actually passed a floor check. A sampler that checked every N
characters would let the first N characters through unchecked — which is exactly
the leak this exists to close, and is how the first draft of this module failed
its own test.

The trade is that the live preview lags by up to ``check_every_chars`` (~30
tokens). For a progress preview that is imperceptible; for the safety property
it is the whole point.

Cost: the floor check runs ~0.9ms on a few hundred characters, so it cannot run
per token. It runs per released chunk, over a bounded trailing window, so cost
stays flat on a long answer rather than growing with it — while overlap keeps a
phrase that straddles two chunks visible to the check as a whole.

Once tripped it LATCHES. A partial stream legitimately passes through states
that read as violations ("...how to kill" before "...a runaway process"), so
un-latching would flicker withheld content back onto the screen. Latching is
both steadier and the fail-closed direction.

The guard only gates the live preview. It never edits the answer: the real
verdict remains the end-of-loop delivery gate's to make.
"""
from __future__ import annotations

from typing import Callable

# Enough preceding context for the clause-scoped gate to judge a phrase, small
# enough that each check stays around a millisecond.
_WINDOW_CHARS = 800
# Release granularity. At ~4 chars/token this releases every ~30 tokens.
_CHECK_EVERY_CHARS = 120


class StreamFloorGuard:
    """Buffers streamed text and releases only what has passed a floor check.

    Feed every token to :meth:`feed`, which returns the text that is safe to
    forward right now (often ``""`` while buffering). Call :meth:`finish` at the
    end of the stream to release the checked remainder.
    """

    def __init__(
        self,
        *,
        checker: Callable[[str], str] | None = None,
        window_chars: int = _WINDOW_CHARS,
        check_every_chars: int = _CHECK_EVERY_CHARS,
    ) -> None:
        self._checker = checker or _default_checker
        self._window = max(1, window_chars)
        self._every = max(1, check_every_chars)
        self._pending: list[str] = []
        self._pending_len = 0
        self._released = ""  # trailing released text, kept for check context
        self._withheld = False
        self._reason = ""

    @property
    def withheld(self) -> bool:
        return self._withheld

    @property
    def reason(self) -> str:
        return self._reason

    def feed(self, token: str) -> str:
        """Buffer ``token``; return whatever is now cleared for display."""
        if self._withheld:
            return ""
        text = str(token or "")
        if text:
            self._pending.append(text)
            self._pending_len += len(text)
        if self._pending_len >= self._every:
            return self._flush(final=False)
        return ""

    def finish(self) -> str:
        """Release the checked remainder at end of stream."""
        if self._withheld or not self._pending_len:
            return ""
        return self._flush(final=True)

    def _flush(self, *, final: bool) -> str:
        pending = "".join(self._pending)
        if not final:
            # Only ever judge whole clauses. Cutting mid-phrase makes the check
            # see a fragment, and a fragment of benign technical writing can read
            # as a violation on its own: "kill -9 the child process" truncated to
            # "kill -" loses the operand that marks it as ops vocabulary and
            # trips the floor. Hold the tail back until its clause completes.
            cut = _last_clause_end(pending)
            if cut <= 0:
                return ""
            candidate, remainder = pending[:cut], pending[cut:]
            self._pending = [remainder] if remainder else []
            self._pending_len = len(remainder)
            return self._release(candidate)
        self._pending = []
        self._pending_len = 0
        return self._release(pending)

    def _release(self, candidate: str) -> str:
        # Check the candidate WITH its preceding context, so a violation split
        # across two releases is still judged as one phrase.
        context = (self._released + candidate)[-self._window:]
        if self._trips_floor(context):
            self._withheld = True
            self._pending = []
            self._pending_len = 0
            return ""
        self._released = (self._released + candidate)[-self._window:]
        return candidate

    def _trips_floor(self, text: str) -> bool:
        if not text.strip():
            return False
        try:
            verdict = self._checker(text)
        except Exception:  # noqa: BLE001 - a guard that crashes must not open
            self._reason = "stream floor check failed; withholding preview"
            return True
        if verdict == "block":
            self._reason = "hard-floor violation detected in streamed output"
            return True
        return False


_CLAUSE_ENDS = ".!?\n;"


def _last_clause_end(text: str) -> int:
    """Index just past the last clause terminator, or 0 if there is none."""
    best = -1
    for ch in _CLAUSE_ENDS:
        best = max(best, text.rfind(ch))
    return best + 1 if best >= 0 else 0


def _default_checker(text: str) -> str:
    """Hard-floor verdict for a fragment. Imported lazily to keep startup cheap."""
    from agent.public_standard_gate import check_public_standard

    return check_public_standard(text).verdict


__all__ = ["StreamFloorGuard"]
