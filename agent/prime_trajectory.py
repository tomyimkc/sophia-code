# SPDX-License-Identifier: Apache-2.0
"""Quarantined Prime trajectories and fail-closed training eligibility.

Runtime traces are *candidate data*, not automatically training data.  Default
capture stores hashes and policy/evaluation metadata only.  Full prompt/output
content requires ``SOPHIA_PRIME_TRAJECTORY_CAPTURE=1`` and is still ineligible
until a human approves it and the contamination guard reports CLEAN.
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "sophia.prime_trajectory.v1"


def _sha256(text: str) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class PrimeTrajectory:
    sessionId: str
    runId: str
    runtimeVersion: str
    promptSha256: str
    outputSha256: str
    outcome: str
    floorChecked: bool
    floorVerdict: str
    toolPolicyChecked: bool
    executionAuthority: str
    tools: tuple[dict[str, Any], ...] = ()
    prompt: str | None = None
    output: str | None = None
    humanApproved: bool = False
    contaminationStatus: str = "unchecked"
    # Adapter regression is evaluated only after training by the normal
    # promotion gate. It is provenance here, not a pre-training row criterion.
    protectedSuiteRegression: str = "unknown"
    trajectoryId: str = field(
        default_factory=lambda: f"prime-traj-{uuid.uuid4().hex[:12]}"
    )
    createdAt: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    schema: str = SCHEMA
    candidateOnly: bool = True
    canClaimAGI: bool = False

    def eligibility(self) -> tuple[bool, tuple[str, ...]]:
        reasons: list[str] = []
        if self.outcome != "succeeded":
            reasons.append("runtime outcome was not succeeded")
        if not self.floorChecked:
            reasons.append("final output floor was not checked")
        if not self.toolPolicyChecked:
            reasons.append("external tool policy was not verified")
        if self.prompt is None or self.output is None:
            reasons.append("content capture is absent")
        if not self.humanApproved:
            reasons.append("human approval is absent")
        if self.contaminationStatus != "clean":
            reasons.append("contamination status is not clean")
        return not reasons, tuple(reasons)

    def to_dict(self) -> dict[str, Any]:
        eligible, reasons = self.eligibility()
        body = asdict(self)
        body["tools"] = [dict(tool) for tool in self.tools]
        body["trainingEligible"] = eligible
        body["quarantineReasons"] = list(reasons)
        body["requiresHumanReview"] = True
        body["summary_en"] = (
            "Quarantined Prime Agent trajectory; external policy and floor "
            "metadata are recorded without implying capability uplift."
        )
        body["summary_zh"] = (
            "隔离的 Prime Agent 轨迹；记录外部工具政策与输出门控信息，"
            "不代表能力提升或 AGI 证据。"
        )
        return body


def make_prime_trajectory(
    *,
    session_id: str,
    run_id: str,
    runtime_version: str,
    prompt: str,
    output: str,
    outcome: str,
    floor_checked: bool,
    floor_verdict: str,
    tool_policy_checked: bool,
    tools: list[dict[str, Any]] | tuple[dict[str, Any], ...] = (),
    capture_content: bool = False,
) -> PrimeTrajectory:
    return PrimeTrajectory(
        sessionId=session_id,
        runId=run_id,
        runtimeVersion=runtime_version,
        promptSha256=_sha256(prompt),
        outputSha256=_sha256(output),
        outcome=outcome,
        floorChecked=bool(floor_checked),
        floorVerdict=str(floor_verdict or ""),
        toolPolicyChecked=bool(tool_policy_checked),
        executionAuthority="external-user-process",
        tools=tuple(dict(tool) for tool in tools),
        prompt=prompt if capture_content else None,
        output=output if capture_content else None,
    )


def append_prime_trajectory(
    trajectory: PrimeTrajectory,
    path: str | Path | None = None,
) -> Path:
    target = Path(
        path
        or os.environ.get("SOPHIA_PRIME_TRAJECTORY_PATH")
        or (
            Path.home()
            / ".sophia"
            / "prime-agent"
            / "trajectories"
            / "quarantine.jsonl"
        )
    ).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(trajectory.to_dict(), ensure_ascii=False, sort_keys=True) + "\n"
    fd = os.open(target, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return target


__all__ = [
    "SCHEMA",
    "PrimeTrajectory",
    "make_prime_trajectory",
    "append_prime_trajectory",
]
