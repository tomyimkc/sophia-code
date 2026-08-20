# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Reusable skill registry + router for the Sophia agent harness.

A skill is a data file (skills/registry/*.json) describing WHEN to use it, the
TOOLS it needs, a step-by-step WORKFLOW, an IO SCHEMA, a VERIFICATION method,
COMMON FAILURES, and EXAMPLES. The harness injects the selected skill's workflow
and verification into the planner/executor prompts.

Routing (``select`` / ``select_ranked``) is a dependency-free hybrid matcher:

  - stemmed token overlap (so "debugging" matches trigger "debug"),
  - a small domain synonym map (so "attribution" matches "provenance"),
  - IDF weighting over the skill corpus (a token shared by many skills counts
    for less than a distinctive one, killing spurious "test"/"code" wins),
  - a character n-gram fuzzy fallback for paraphrases the keyword path misses,
  - an optional injected ``embed_fn`` for real embedding retrieval (Voyager-style)
    when a model is available — never a hard dependency, so CI stays import-safe.

It stays import-safe in CI (no third-party deps) and never raises into the caller.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
# Callable is referenced only inside quoted (forward-ref) annotations below, so the
# name is never evaluated at runtime — importing it is unnecessary (CodeQL: unused).
from typing import Any

from agent.config import ROOT

SKILL_DIR = ROOT / "skills" / "registry"

REQUIRED_FIELDS = (
    "name",
    "whenToUse",
    "requiredTools",
    "workflow",
    "ioSchema",
    "verification",
    "commonFailures",
    "examples",
)

# Domain synonyms → canonical token. Folded in before scoring so a goal phrased
# one way still matches a skill whose triggers use the sibling term. Extend freely;
# keys and values are stemmed automatically.
SYNONYMS: dict[str, str] = {
    "attribution": "provenance",
    "citation": "provenance",
    "cite": "provenance",
    "author": "provenance",
    "authorship": "provenance",
    "source": "provenance",
    "debug": "debug",
    "debugging": "debug",
    "bugfix": "debug",
    "traceback": "error",
    "exception": "error",
    "stacktrace": "error",
    "gpu": "runpod",
    "pod": "runpod",
    "serverless": "runpod",
    "summarise": "summarize",
    "summarisation": "summarize",
    "summarization": "summarize",
    "retrieve": "rag",
    "retrieval": "rag",
    "embedding": "rag",
}

# Suffixes stripped (longest-first) for a cheap, dependency-free stemmer.
_SUFFIXES = ("ization", "isation", "ations", "ation", "ing", "ies", "ed", "es", "s", "er", "ly")

# Function words that must not ANCHOR a keyword match on their own. Without
# this, an out-of-domain goal ("book me a flight to lisbon") clears
# min_score=1.0 purely on stopwords shared with a skill's whenToUse prose
# ("a"+"to" = 2 x 0.7), and "what is the capital of mongolia" rides the bare
# interrogative trigger "what". Stopwords still add weight once a non-stopword
# token (or a multiword trigger phrase) has hit — see _score.
_STOPWORDS = frozenset({
    "a", "an", "the", "this", "that", "these", "those", "there", "here",
    "i", "you", "we", "they", "it", "he", "she", "me", "my", "your", "our", "their", "its",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "do", "does", "did", "done", "have", "has", "had",
    "will", "would", "can", "could", "should", "shall", "may", "might", "must", "please",
    "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "about",
    "and", "or", "but", "not", "no", "so", "if", "then", "than", "as",
    "what", "who", "whom", "whose", "when", "where", "why", "how", "which",
    "some", "any", "all", "each", "very", "just", "also",
})


def validate_skill(skill: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in REQUIRED_FIELDS:
        if field not in skill:
            errors.append(f"missing field: {field}")
    for list_field in ("requiredTools", "workflow", "verification", "commonFailures", "examples"):
        if list_field in skill and not isinstance(skill[list_field], list):
            errors.append(f"{list_field} must be a list")
    if "workflow" in skill and isinstance(skill["workflow"], list) and not skill["workflow"]:
        errors.append("workflow must be non-empty")
    if "ioSchema" in skill and not isinstance(skill["ioSchema"], dict):
        errors.append("ioSchema must be an object")
    return errors


def load_all(skill_dir: Path = SKILL_DIR) -> dict[str, dict[str, Any]]:
    skills: dict[str, dict[str, Any]] = {}
    if not skill_dir.exists():
        return skills
    for path in sorted(skill_dir.glob("*.json")):
        skill = json.loads(path.read_text(encoding="utf-8"))
        # ``skills/registry`` now also holds Skill Forge bookkeeping such as
        # ``forge_index.json`` and the unified ``index.json``. Those files are
        # registries/manifests, not executable Agent Harness skill specs, so do
        # not try to validate/load them as skills. This keeps the registry
        # extensible without breaking older harness code that globbed every JSON.
        if _is_metadata_file(skill):
            continue
        errors = validate_skill(skill)
        if errors:
            raise ValueError(f"invalid skill {path.name}: {errors}")
        skills[skill["name"]] = skill
    return skills


def _is_metadata_file(data: dict[str, Any]) -> bool:
    schema = str(data.get("schema", ""))
    return bool(schema and schema.startswith("sophia.") and "registry" in schema)


def get(name: str, skill_dir: Path = SKILL_DIR) -> dict[str, Any] | None:
    return load_all(skill_dir).get(name)


def list_skills(skill_dir: Path = SKILL_DIR) -> list[dict[str, str]]:
    return [{"name": s["name"], "whenToUse": s["whenToUse"]} for s in load_all(skill_dir).values()]


# --------------------------------------------------------------------------- #
# Tokenisation / normalisation
# --------------------------------------------------------------------------- #

def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _stem(token: str) -> str:
    """Cheap, dependency-free stemmer: longest-suffix strip, keep >=3 chars."""
    for suf in _SUFFIXES:
        if len(token) > len(suf) + 2 and token.endswith(suf):
            return token[: -len(suf)]
    return token


# Stemmed forms too, so post-stem artifacts ("this" -> "thi") are still caught.
_STOP_STEMS = frozenset(_stem(w) for w in _STOPWORDS) | _STOPWORDS


def _norm(token: str) -> str:
    """Stem, then map through the synonym table (also stemmed)."""
    stemmed = _stem(token)
    syn = SYNONYMS.get(token) or SYNONYMS.get(stemmed)
    return _stem(syn) if syn else stemmed


def _norm_set(text: str) -> set[str]:
    return {_norm(t) for t in _tokens(text)}


def _char_ngrams(text: str, n: int = 3) -> set[str]:
    s = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    s = f" {s} "
    return {s[i : i + n] for i in range(max(0, len(s) - n + 1))} if len(s) >= n else {s}


def _cosine(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / math.sqrt(len(a) * len(b))


# --------------------------------------------------------------------------- #
# Routing
# --------------------------------------------------------------------------- #

def _idf(skills: list[dict[str, Any]]) -> dict[str, float]:
    """Inverse document frequency of each normalised trigger/name token across
    the skill corpus. Distinctive tokens score higher than ubiquitous ones."""
    n = max(1, len(skills))
    df: dict[str, int] = {}
    for sk in skills:
        toks = _norm_set(sk["name"].replace("-", " "))
        toks |= {_norm(t) for t in sk.get("triggers", [])}
        for t in toks:
            df[t] = df.get(t, 0) + 1
    # smoothed idf, floored at a small positive so common tokens still count a bit
    return {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}


def _score(goal: str, skill: dict[str, Any], idf: dict[str, float]) -> float:
    goal_norm = _norm_set(goal)
    triggers = {_norm(t) for t in skill.get("triggers", [])}
    name_tokens = _norm_set(skill["name"].replace("-", " "))
    when_tokens = _norm_set(skill.get("whenToUse", ""))
    lowered_goal = goal.lower()

    score = 0.0
    anchored = False  # at least one non-stopword hit (or phrase hit) required
    for tok in goal_norm:
        w = idf.get(tok, 0.7)  # tokens unseen in triggers still get a small base weight
        if tok in triggers:
            score += 3.0 * w
        elif tok in name_tokens:
            score += 2.0 * w
        elif tok in when_tokens:
            score += 1.0 * w
        else:
            continue
        if tok not in _STOP_STEMS:
            anchored = True
    # multiword trigger phrases (use the raw, unstemmed phrase for precision)
    for trigger in (t.lower() for t in skill.get("triggers", [])):
        if " " in trigger and trigger in lowered_goal:
            score += 4.0
            anchored = True
    # Content-anchor guard: a match built ONLY from function words is noise
    # ("book me a flight to lisbon" sharing "a"/"to" with whenToUse prose, or
    # a bare "what"). Zero it so the goal falls through to the fuzzy path,
    # where junk stays below the default min_score.
    return score if anchored else 0.0


def select_ranked(
    goal: str,
    skill_dir: Path = SKILL_DIR,
    *,
    top_k: int = 3,
    min_score: float = 1.0,
    embed_fn: "Callable[[str], list[float]] | None" = None,
) -> list[dict[str, Any]]:
    """Return up to ``top_k`` skills ranked by hybrid relevance to ``goal``.

    Each item is ``{"skill": <spec>, "score": float, "via": "keyword"|"fuzzy"|"embed"}``.
    Deterministic: ties break by descending score then skill name.
    """
    skills = list(load_all(skill_dir).values())
    if not skills:
        return []
    idf = _idf(skills)
    goal_grams = _char_ngrams(goal)

    scored: list[dict[str, Any]] = []
    for sk in skills:
        kw = _score(goal, sk, idf)
        via = "keyword"
        score = kw
        if kw < min_score:
            # fuzzy fallback: char-ngram cosine over name+triggers+whenToUse
            surface = " ".join([sk["name"], " ".join(sk.get("triggers", [])), sk.get("whenToUse", "")])
            fuzzy = _cosine(goal_grams, _char_ngrams(surface))
            if fuzzy > 0.0:
                score = fuzzy * 2.0  # scale into the keyword range; stays below a real keyword hit
                via = "fuzzy"
        scored.append({"skill": sk, "score": round(float(score), 4), "via": via})

    # optional real-embedding rerank, only if a model was injected
    if embed_fn is not None:
        try:
            gvec = embed_fn(goal)
            for item in scored:
                sk = item["skill"]
                svec = embed_fn(f'{sk["name"]} {sk.get("whenToUse", "")} {" ".join(sk.get("triggers", []))}')
                sim = _vec_cosine(gvec, svec)
                if sim > 0:
                    # blend: embedding can rescue a zero-keyword match
                    item["score"] = round(max(item["score"], sim * 3.0), 4)
                    if item["via"] != "keyword":
                        item["via"] = "embed"
        except Exception:
            pass  # embeddings are best-effort; never break routing

    scored.sort(key=lambda x: (-x["score"], x["skill"]["name"]))
    return [s for s in scored if s["score"] >= min_score][:top_k]


def select(
    goal: str,
    skill_dir: Path = SKILL_DIR,
    *,
    min_score: float = 1.0,
    embed_fn: "Callable[[str], list[float]] | None" = None,
    log_path: "Path | None" = None,
) -> dict[str, Any] | None:
    """Pick the best-matching skill for a goal, or None (backward-compatible).

    Now backed by the hybrid scorer (stemming + synonyms + IDF + fuzzy fallback).
    Pass ``log_path`` to append a telemetry row for the trigger learner
    (``tools/learn_triggers.py``); logging is best-effort and never raises.
    """
    ranked = select_ranked(goal, skill_dir, top_k=1, min_score=min_score, embed_fn=embed_fn)
    best = ranked[0]["skill"] if ranked else None
    if log_path is not None:
        _log_selection(log_path, goal, ranked[0] if ranked else None)
    return best


def _vec_cosine(a: "list[float]", b: "list[float]") -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _log_selection(log_path: Path, goal: str, top: "dict[str, Any] | None") -> None:
    """Append one routing decision to the telemetry log (JSONL). Best-effort."""
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "goal": goal,
            "skill_id": (top["skill"]["name"] if top else None),
            "score": (top["score"] if top else 0.0),
            "via": (top["via"] if top else "none"),
        }
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        # Telemetry logging is best-effort: a routing decision must never fail just
        # because the log path is unwritable. Swallow and continue (behavior unchanged).
        pass
