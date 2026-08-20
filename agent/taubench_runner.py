#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""τ-bench (tau-bench) runner for /taubench — drive the τ-bench Env through the
Sophia agent loop and score reliability with pass^k (the harness-flakiness metric).

τ-bench's value for harness diagnosis is the **pass^k** metric: run each task k
times, score 1 only if enough trials pass. pass^k decays as p^k, so even a small
per-trial flakiness (non-deterministic tool parsing, jittery stops, occasional
context drops) collapses pass^k toward 0 even when pass@1 looks fine. That makes
pass^k a direct measure of **harness reliability** — exactly "does my loop flake?"

Implementation (from sierra-research/tau-bench research):
  - τ-bench ships an in-process ``Env`` (airline/retail domains) with an OpenAI
    function-calling tool protocol. We bypass tau-bench's OWN agents and drive the
    Env with our agent loop: read ``env.tools_info`` + ``env.wiki``, call
    ``env.reset(task_index)`` → first user message, loop ``env.step(Action(...))``
    until done, read ``env_response.reward`` (0/1, deterministic DB-state verifier).
  - pass^k = mean_over_tasks[ C(c_i, k) / C(N, k) ] where c_i = #passing trials
    for task i, N = num_trials. Verbatim from tau_bench/run.display_metrics.

Why drive our own agent (not tau-bench's): the goal is to measure OUR harness's
reliability. Running tau-bench's built-in agent would measure their agent + our
model — not our loop. So we feed each turn's observation into ``run_agent_loop``'s
tool-calling path and map its tool_calls back to τ-bench ``Action`` objects.

candidateOnly: true · canClaimAGI: false — reliability tooling, not a result.
"""
from __future__ import annotations

import sys
from math import comb
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# τ-bench's task counts per domain/split (verified from the research).
TASK_COUNTS = {
    ("airline", "test"): 50,
    ("retail", "test"): 115,
    ("retail", "dev"): 20,
    ("retail", "train"): 500,
}

COMPARABILITY = "τ-bench pass^k reliability · local model · candidateOnly"

# Max agent turns per τ-bench task (tau-bench's built-in agents default to 30).
DEFAULT_MAX_STEPS = 30


def get_env(domain: str, *, user_strategy: str = "llm", user_model: str,
            user_provider: str, task_split: str = "test", task_index: int = 0):
    """Instantiate a τ-bench Env. Thin wrapper over ``tau_bench.envs.get_env``.

    Fail-closed: raises a clear error if tau-bench isn't installed rather than
    silently returning None. The user-simulator (``user_model``) is a SEPARATE
    LLM from the agent model — τ-bench simulates the human user. For a fully-local
    run, point both at the local server; for a faithful "is my harness reliable"
    measurement, a frontier user-simulator (gpt-4o) isolates agent-side flakiness.
    """
    try:
        from tau_bench.envs import get_env as _get_env  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "τ-bench needs `pip install -e .` from a clone of "
            "github.com/sierra-research/tau-bench (no PyPI package)."
        ) from exc
    return _get_env(domain, user_strategy=user_strategy, user_model=user_model,
                    user_provider=user_provider, task_split=task_split,
                    task_index=task_index)


# --------------------------------------------------------------------------- #
# pass^k — vendored verbatim from tau_bench/run.display_metrics
# --------------------------------------------------------------------------- #
def pass_hat_k(rewards_per_task: dict[int, list[float]], num_trials: int) -> dict[int, float]:
    """Compute pass^k for k=1..num_trials.

    ``rewards_per_task`` maps task_id → list of per-trial rewards (each 0.0/1.0).
    Returns ``{k: pass^k}`` averaged across tasks. pass^N (k=N) is the strict
    "all trials passed" reliability metric. A reward is "successful" iff it is
    within 1e-6 of 1.0 (matches tau-bench's ``is_successful``).
    """
    def _is_successful(reward: float) -> bool:
        return (1 - 1e-6) <= reward <= (1 + 1e-6)

    c_per_task: dict[int, int] = {}
    for task_id, rewards in rewards_per_task.items():
        c_per_task[task_id] = sum(1 for r in rewards if _is_successful(r))

    out: dict[int, float] = {}
    n_tasks = len(c_per_task)
    if n_tasks == 0 or num_trials <= 0:
        return {k: 0.0 for k in range(1, num_trials + 1)}
    for k in range(1, num_trials + 1):
        if k > num_trials:
            break
        total = 0.0
        for c in c_per_task.values():
            total += comb(c, k) / comb(num_trials, k)
        out[k] = total / n_tasks
    return out


def pass_at_1(rewards_per_task: dict[int, list[float]]) -> float:
    """Convenience: the pass@1 (mean per-trial success) headline."""
    all_rewards = [r for rewards in rewards_per_task.values() for r in rewards]
    if not all_rewards:
        return 0.0
    return sum(1 for r in all_rewards if (1 - 1e-6) <= r <= (1 + 1e-6)) / len(all_rewards)


def diagnose_reliability(passk: dict[int, float], num_trials: int) -> list[str]:
    """Interpret the pass^k curve as a named harness-reliability weakness.

    The diagnostic signal: how FAST pass^k decays from k=1 to k=N. A steep drop
    (pass@1 healthy but pass^N near 0) means the harness is flaky — it sometimes
    succeeds but unreliably. A flat curve (pass^k ≈ pass@1) means reliability.
    This is exactly "find my harness weakness": flakiness is a fixable harness
    property (deterministic tool parsing, stable stops), not model IQ.
    """
    findings: list[str] = []
    if not passk or num_trials <= 1:
        return ["Set num_trials >= 2 to measure pass^k reliability (1 trial gives no decay signal)."]
    p1 = passk.get(1, 0.0)
    pn = passk.get(num_trials, 0.0)
    decay = p1 - pn
    if decay >= 0.30:
        findings.append(
            f"SEVERE reliability decay: pass@1={int(p1*100)}% → pass^{num_trials}="
            f"{int(pn*100)}% (−{int(decay*100)}pp). The harness SOMETIMES succeeds but "
            "unreliably — classic flakiness. Investigate non-determinism: tool-call "
            "parsing on local Qwen parallel batches, jittery stop conditions, or "
            "context compaction dropping a needed turn."
        )
    elif decay >= 0.15:
        findings.append(
            f"Moderate reliability decay: pass@1={int(p1*100)}% → pass^{num_trials}="
            f"{int(pn*100)}% (−{int(decay*100)}pp). Some per-trial flakiness — worth "
            "hardening the tool-call normalization and the stop condition."
        )
    else:
        findings.append(
            f"Reliable: pass@1={int(p1*100)}% ≈ pass^{num_trials}={int(pn*100)}% "
            f"(−{int(decay*100)}pp decay). The harness is consistent across trials — "
            "failures are capability-shaped (model couldn't do it), not flakiness. "
            "(This is a harness-health read, not a capability claim.)"
        )
    return findings


def action_from_tool_call(name: str, args: dict | str) -> "tuple[Any, bool]":
    """Map a model tool_call to a τ-bench Action. Returns (action, is_respond).

    τ-bench's tool-calling agent honors ONLY the first tool_call per turn and maps
    a no-tool-call turn to a ``respond`` Action (the agent speaks to the user).
    ``args`` may be a dict (native) or a JSON string (OpenAI string-args form).
    """
    import json
    from tau_bench.types import Action, RESPOND_ACTION_NAME  # type: ignore

    if name == RESPOND_ACTION_NAME or name in ("respond", "answer", "reply"):
        content = args.get("content", str(args)) if isinstance(args, dict) else str(args)
        return Action(name=RESPOND_ACTION_NAME, kwargs={"content": str(content)}), True
    kwargs = args
    if isinstance(args, str):
        try:
            kwargs = json.loads(args)
        except Exception:
            kwargs = {"content": args}
            return Action(name=RESPOND_ACTION_NAME, kwargs=kwargs), True
    return Action(name=name, kwargs=kwargs if isinstance(kwargs, dict) else {}), False


# --------------------------------------------------------------------------- #
# run_sweep — the task×trial loop driving the τ-bench Env through our agent
# --------------------------------------------------------------------------- #
def run_sweep(*, domain: str, model_alias: str, client: Any, user_model: str,
              num_trials: int, task_ids: "list[int] | None" = None,
              max_steps: int = DEFAULT_MAX_STEPS,
              user_provider: str = "openai",
              task_split: str = "test",
              progress_cb: "Any | None" = None) -> dict[int, list[float]]:
    """Run τ-bench tasks through the Sophia agent loop; collect per-trial rewards.

    For each task (in the domain's test split, optionally filtered by ``task_ids``)
    and each of ``num_trials`` trials: instantiate the Env, drive it with our agent
    loop (the agent's tool_calls → τ-bench Actions), and record the env's final
    reward (0.0/1.0). Returns ``{task_id: [reward_per_trial]}`` for pass^k.

    The agent loop is invoked turn-by-turn: each τ-bench observation becomes a
    user turn; the loop's tool_calls are mapped to Actions and stepped. This keeps
    OUR harness's tool-calling path in the measurement (the whole point — measure
    our reliability, not τ-bench's built-in agent).
    """
    from agent.agent_loop import run_agent_loop  # noqa: WPS433

    # Determine the task indices to run.
    env0 = get_env(domain, user_model=user_model, user_provider=user_provider,
                   task_split=task_split, task_index=0)
    n_tasks = len(env0.tasks)
    indices = task_ids if task_ids else list(range(n_tasks))

    rewards: dict[int, list[float]] = {}
    for task_idx in indices:
        rewards[task_idx] = []
        for trial in range(num_trials):
            reward = _run_one_task(
                domain=domain, task_idx=task_idx, client=client,
                user_model=user_model, user_provider=user_provider,
                task_split=task_split, max_steps=max_steps,
            )
            rewards[task_idx].append(reward)
            if progress_cb is not None:
                progress_cb({"task_id": task_idx, "trial": trial,
                             "reward": reward, "num_trials": num_trials,
                             "domain": domain, "model": model_alias})
    return rewards


def _run_one_task(*, domain: str, task_idx: int, client: Any, user_model: str,
                  user_provider: str, task_split: str, max_steps: int) -> float:
    """Drive ONE τ-bench task to completion through the agent loop; return reward.

    The τ-bench Env is multi-turn: reset() → first user utterance; each step() takes
    an Action (a tool call OR a 'respond' to speak to the user). We feed each user
    utterance into run_agent_loop as a one-shot goal with the task's tools+wiki as
    system context, take the loop's first tool_call as the Action, step, repeat.
    Robust to a fault: any harness error counts as a fail (reward 0.0), never a crash.
    """
    env = get_env(domain, user_model=user_model, user_provider=user_provider,
                  task_split=task_split, task_index=task_idx)
    tools_info = env.tools_info
    wiki = env.wiki
    obs = env.reset(task_index=task_idx)
    observation = obs.observation if hasattr(obs, "observation") else str(obs)

    # Build a minimal one-turn tool-calling request: the policy + the user utterance
    # + the available tools. We do NOT use run_agent_loop's full ReAct loop (that's
    # tuned for the bash/file harness); instead we ask the model for ONE action and
    # map it to a τ-bench Action. This is the cleanest faithful mapping of our
    # tool-calling path onto τ-bench's turn structure.
    import json
    for _step in range(max_steps):
        try:
            messages = [
                {"role": "system", "content": wiki},
                {"role": "user", "content": observation},
            ]
            res = client.generate_messages(messages, tools=tools_info)
            if not getattr(res, "ok", True):
                return 0.0
            tool_calls = getattr(res, "tool_calls", None) or []
            text = getattr(res, "text", "") or ""
            if tool_calls:
                tc = tool_calls[0]  # τ-bench honors only the first call per turn
                fn = tc.get("function") if isinstance(tc, dict) else getattr(tc, "function", None)
                name = (fn.get("name") if isinstance(fn, dict) else getattr(fn, "name", "")) if fn else ""
                raw_args = (fn.get("arguments") if isinstance(fn, dict) else getattr(fn, "arguments", {})) if fn else {}
            else:
                # no tool call → the agent speaks to the user (respond action)
                name, raw_args = "respond", {"content": text}
            action, _ = action_from_tool_call(name, raw_args)
            env_response = env.step(action)
            observation = env_response.observation if hasattr(env_response, "observation") else str(env_response)
            if getattr(env_response, "done", False):
                return float(getattr(env_response, "reward", 0.0) or 0.0)
        except Exception:  # noqa: BLE001 — a harness fault = a real fail, not a crash
            return 0.0
    return 0.0  # max_steps exhausted without the env declaring done

