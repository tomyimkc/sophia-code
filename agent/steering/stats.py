# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Effect-size, bootstrap CI, kappa, and the pre-registered SSA verdict (pure stdlib).

Reuses provenance_bench's stdlib helpers verbatim — no new stats deps.
"""
from __future__ import annotations

import random
import statistics

from provenance_bench.aggregate import _ci, KAPPA_FLOOR
from provenance_bench.consensus import cohen_kappa  # re-exported for callers

# Public API. ``cohen_kappa`` is a deliberate re-export (callers use
# ``stats.cohen_kappa``); listing it in ``__all__`` marks the import as used so
# CodeQL's py/unused-import does not flag it.
__all__ = [
    "SSA_THRESHOLDS",
    "cohen_d",
    "bootstrap_diff_ci",
    "binarize_moved",
    "ssa_verdict",
    "residualized_d",
    "holm_bonferroni",
    "benjamini_hochberg",
    "bootstrap_diff_p",
    "cohen_kappa",
]

# Pre-registered SSA thresholds — fixed before any run (spec §"Locked decisions").
SSA_THRESHOLDS = {
    "delta_point_min": 0.30,   # Δd point estimate floor
    "steered_d_min": 0.50,     # absolute residualized d floor
    "off_target_max": 0.20,    # off-target |d| null band
    "kappa_floor": KAPPA_FLOOR,  # 0.40
    "capability_eps": 0.05,    # ≤5% relative capability drop
    "coherence_floor": 75.0,
}


def cohen_d(a: "list[float]", b: "list[float]") -> float:
    if len(a) < 2 or len(b) < 2:
        return 0.0
    va, vb = statistics.pvariance(a), statistics.pvariance(b)
    pooled = ((va + vb) / 2.0) ** 0.5
    if pooled == 0.0:
        return 0.0
    return (statistics.fmean(a) - statistics.fmean(b)) / pooled


def bootstrap_diff_ci(steer: "list[float]", base: "list[float]", *,
                      n_boot: int = 2000, seed: int = 0, alpha: float = 0.05) -> "list[float]":
    """Bootstrap CI of the paired difference (steer_i − base_i). steer/base are
    per-seed effect sizes already, paired by index. Returns _ci([..]) = [lo, hi]."""
    diffs = [s - b for s, b in zip(steer, base)]
    n = len(diffs)
    if n == 0:
        return [0.0, 0.0]
    rng = random.Random(seed)
    boot = []
    for _ in range(n_boot):
        sample = [diffs[rng.randrange(n)] for _ in range(n)]
        boot.append(statistics.fmean(sample))
    return _ci(boot, alpha)


def binarize_moved(scores: "list[float]", neutral: "list[float]") -> "list[int]":
    return [1 if s > nt else 0 for s, nt in zip(scores, neutral)]


def ssa_verdict(cell: dict) -> dict:
    """Apply the six pre-registered SSA conditions; ABSTAIN on the first failure.
    Order matters only for the reported reason; all must hold to be 'enacted'."""
    T = SSA_THRESHOLDS
    checks = {}
    lo, hi = cell["delta_ci"]
    checks["superiority"] = lo > 0.0 and cell["delta_point"] >= T["delta_point_min"]
    checks["floor"] = cell["steered_d"] > T["steered_d_min"]
    checks["orthogonality"] = all(abs(d) < T["off_target_max"] for d in cell["off_target_d"].values())
    checks["corroboration"] = cell["kappa"] >= T["kappa_floor"]
    checks["capability"] = (cell["capability_drop"] < T["capability_eps"]
                            and cell["coherence"] >= T["coherence_floor"])
    checks["non_mock"] = not cell["is_mock"]
    reason_for = {
        "superiority": "steer_not_beats_baseline", "floor": "below_floor",
        "orthogonality": "off_target_halo", "corroboration": "low_kappa",
        "capability": "capability_drop", "non_mock": "mock_subject",
    }
    for key in ("non_mock", "superiority", "floor", "orthogonality", "corroboration", "capability"):
        if not checks[key]:
            return {"status": "abstained", "reason": reason_for[key], "checks": checks}
    return {"status": "enacted", "reason": None, "checks": checks}


def residualized_d(target_per_seed, offtarget_per_seed_by_axis):
    y = list(target_per_seed); n = len(y)
    if n < 2:
        return 0.0
    axes = [k for k, v in offtarget_per_seed_by_axis.items() if len(v) == n]
    X = [[1.0] + [offtarget_per_seed_by_axis[k][i] for k in axes] for i in range(n)]
    p = 1 + len(axes)
    A = [[sum(X[i][r] * X[i][s] for i in range(n)) for s in range(p)] for r in range(p)]
    c = [sum(X[i][r] * y[i] for i in range(n)) for r in range(p)]
    beta = _solve_linear(A, c)
    if beta is None:
        sd = statistics.pstdev(y)
        return 0.0 if sd == 0.0 else statistics.fmean(y) / sd
    resid = [y[i] - sum(beta[r] * X[i][r] for r in range(1, p)) for i in range(n)]
    sd = statistics.pstdev(resid)
    return 0.0 if sd == 0.0 else statistics.fmean(resid) / sd


def _solve_linear(A, c):
    n = len(A)
    M = [list(A[i]) + [c[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            return None
        M[col], M[piv] = M[piv], M[col]
        pv = M[col][col]; M[col] = [v / pv for v in M[col]]
        for r in range(n):
            if r != col and M[r][col] != 0.0:
                f = M[r][col]; M[r] = [M[r][k] - f * M[col][k] for k in range(n + 1)]
    return [M[i][n] for i in range(n)]


def holm_bonferroni(pvalues):
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvalues[i])
    adj = [0.0] * m; running = 0.0
    for rank, idx in enumerate(order):
        running = max(running, (m - rank) * pvalues[idx])
        adj[idx] = min(1.0, running)
    return adj


def benjamini_hochberg(pvalues, q):
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvalues[i])
    k_max = 0
    for rank, idx in enumerate(order, start=1):
        if pvalues[idx] <= (rank / m) * q:
            k_max = rank
    sig = [False] * m
    for rank, idx in enumerate(order, start=1):
        if rank <= k_max:
            sig[idx] = True
    return sig


def bootstrap_diff_p(steer, base, *, n_boot=2000, seed=0):
    diffs = [s - b for s, b in zip(steer, base)]; n = len(diffs)
    if n == 0:
        return 1.0
    rng = random.Random(seed)
    boot = [statistics.fmean([diffs[rng.randrange(n)] for _ in range(n)]) for _ in range(n_boot)]
    frac_lt = sum(1 for m in boot if m < 0.0) / n_boot
    frac_le = sum(1 for m in boot if m <= 0.0) / n_boot
    frac = (frac_lt + frac_le) / 2.0
    return min(1.0, max(1.0 / n_boot, 2.0 * min(frac, 1.0 - frac)))
