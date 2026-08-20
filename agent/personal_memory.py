# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 tomyimkc
"""Local-first personal memory ontology with lexical retrieval and audit receipts.

Markdown is canonical; SQLite FTS is a rebuildable derived index.  Only explicit
user-stated durable facts are auto-written.  Sensitive facts require explicit
approval and are encrypted with AES-GCM using an OS/keyring-backed key.

candidateOnly; canClaimAGI:false — personal context infrastructure only.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

from agent import runtime_paths

CORE_NAMESPACES = frozenset(
    {"profile", "preferences", "projects", "people", "topics", "decisions", "procedures", "custom"}
)
SUBJECT_NAMESPACES = frozenset(
    {"projects", "people", "topics", "decisions", "procedures", "custom"}
)
_SENSITIVE_PATTERNS = (
    r"\b(?:race|ethnicity|national origin|nationality|religion|caste|age|"
    r"date of birth|born on|sex|sexual orientation|gender identity|"
    r"immigration status|disability|disabled|serious illness|union membership)\b",
    r"\b(?:passport|social security|ssn|driver'?s license|credit card|bank account)\b",
    r"\b(?:salary|income|net worth|debt|account balance|financial details)\b",
    r"\b(?:diagnos(?:is|ed)|medication|therapy|counseling|mental health|"
    r"addiction|recovery program|genetic test|lab result|abuse)\b",
    r"\b(?:political belief|political affiliation|criminal history|convicted|"
    r"arrested|victim of crime|domestic violence)\b",
    r"\b(?:mbti|enneagram|big five|attachment style|psychological assessment)\b",
    r"\b(?:home address|personal phone)\b",
    r"\b(?:my child|my children|my son|my daughter|minor child|my spouse|"
    r"my husband|my wife|my partner|my mother|my father|my mom|my dad)\b",
)
_SENSITIVE_RX = tuple(re.compile(pattern, re.IGNORECASE) for pattern in _SENSITIVE_PATTERNS)
_TOKEN_RX = re.compile(r"[a-z0-9\u3400-\u9fff]+", re.IGNORECASE)
_KEY_SERVICE = "sophia-personal-memory"
_KEY_ACCOUNT = "default-aes-gcm"


class PersonalMemoryError(RuntimeError):
    """Base personal-memory failure."""


class SensitiveMemoryUnavailable(PersonalMemoryError):
    """Raised when approved sensitive storage has no secure key backend."""


@dataclass(frozen=True)
class MemoryWriteResult:
    status: Literal["saved", "needs_confirmation", "queued_review", "unchanged"]
    path: str | None = None
    reason: str = ""
    sensitive: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class MemoryHit:
    source: str
    kind: str
    subject: str
    text: str
    score: float
    role: str = "user"
    sensitive: bool = False

    def receipt_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "kind": self.kind,
            "subject": self.subject,
            "score": round(self.score, 4),
            "role": self.role,
            "sensitive": self.sensitive,
        }


@dataclass(frozen=True)
class MemoryCandidate:
    namespace: str
    subject: str
    fact: str


def personal_memory_root() -> Path:
    override = (os.environ.get("SOPHIA_PERSONAL_MEMORY_DIR") or "").strip()
    if override:
        return Path(override).expanduser()
    return runtime_paths.user_state_dir() / "personal-memory"


def _slug(value: str, *, fallback: str = "general") -> str:
    raw = value.strip().lower()
    slug = re.sub(r"[^a-z0-9\u3400-\u9fff]+", "-", raw).strip("-")
    return slug[:80] or fallback


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _frontmatter(name: str, description: str, aliases: Iterable[str] = ()) -> str:
    alias_list = [str(alias).strip() for alias in aliases if str(alias).strip()][:8]
    lines = [
        "---",
        f"name: {json.dumps(name, ensure_ascii=False)}",
        f"description: {json.dumps(description, ensure_ascii=False)}",
        "sources: [chat]",
    ]
    if alias_list:
        lines.append(
            "aliases: ["
            + ", ".join(json.dumps(alias, ensure_ascii=False) for alias in alias_list)
            + "]"
        )
    lines.extend(["---", ""])
    return "\n".join(lines)


def _line_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def is_sensitive_fact(fact: str) -> bool:
    return any(rx.search(fact) for rx in _SENSITIVE_RX)


def _tokens(text: str) -> set[str]:
    return {m.group(0).casefold() for m in _TOKEN_RX.finditer(text)}


def _score(query: str, text: str) -> float:
    q = _tokens(query)
    if not q:
        return 0.0
    t = _tokens(text)
    overlap = q & t
    if not overlap:
        return 0.0
    coverage = len(overlap) / len(q)
    phrase = 0.75 if query.casefold() in text.casefold() else 0.0
    return coverage * 4.0 + len(overlap) * 0.35 + phrase


def extract_explicit_memory_candidates(
    user_text: str,
    *,
    workspace: str | Path | None = None,
) -> list[MemoryCandidate]:
    """Conservatively extract only explicit first-person durable statements.

    This is intentionally narrow so local models do not have to infer memory
    writes, while ordinary task requests are not silently converted into facts.
    """
    subject = _slug(Path(workspace).name) if workspace else "general"
    candidates: list[MemoryCandidate] = []
    sentences = re.split(r"(?:[\n\r]+|(?<=[.!?])\s+)", str(user_text or ""))
    patterns: tuple[tuple[re.Pattern[str], str, str], ...] = (
        (re.compile(r"^(?:my name is|call me)\s+(.+)$", re.I), "profile", "identity"),
        (
            re.compile(r"^i work (?:on|at|as)\s+(.+)$", re.I),
            "profile",
            "work",
        ),
        (
            re.compile(r"^(?:i prefer|please always|from now on)\s+(.+)$", re.I),
            "preferences",
            "communication",
        ),
        (
            re.compile(r"^i want sophia to\s+(.+)$", re.I),
            "preferences",
            "sophia-behavior",
        ),
        (
            re.compile(
                r"^(?:i decided to|we decided to|let'?s use|we(?:'ll| will) use)\s+(.+)$",
                re.I,
            ),
            "decisions",
            subject,
        ),
    )
    seen: set[tuple[str, str, str]] = set()
    for raw in sentences:
        sentence = " ".join(raw.split()).strip(" \t-•")
        if not sentence or len(sentence) > 320:
            continue
        for pattern, namespace, candidate_subject in patterns:
            match = pattern.match(sentence)
            if not match:
                continue
            value = match.group(1).strip(" .")
            if len(value) < 2:
                break
            # Preserve the person's first-person statement rather than
            # upgrading it into a generalized trait.
            fact = sentence.rstrip(".")
            key = (namespace, candidate_subject, fact.casefold())
            if key not in seen:
                seen.add(key)
                candidates.append(
                    MemoryCandidate(namespace, candidate_subject, fact)
                )
            break
    return candidates


def _key_from_python_keyring(*, create: bool) -> bytes | None:
    try:
        import keyring  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        return None
    raw = keyring.get_password(_KEY_SERVICE, _KEY_ACCOUNT)
    if raw is None and create:
        raw = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        keyring.set_password(_KEY_SERVICE, _KEY_ACCOUNT, raw)
    if not raw:
        return None
    try:
        key = base64.urlsafe_b64decode(raw.encode("ascii"))
    except Exception as exc:  # noqa: BLE001
        raise SensitiveMemoryUnavailable("stored personal-memory key is invalid") from exc
    return key if len(key) == 32 else None


def _key_from_macos_keychain(*, create: bool) -> bytes | None:
    if sys.platform != "darwin":
        return None
    try:
        find = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                _KEY_SERVICE,
                "-a",
                _KEY_ACCOUNT,
                "-w",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    raw = find.stdout.strip() if find.returncode == 0 else ""
    if not raw and create:
        raw = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
        try:
            added = subprocess.run(
                [
                    "security",
                    "add-generic-password",
                    "-U",
                    "-s",
                    _KEY_SERVICE,
                    "-a",
                    _KEY_ACCOUNT,
                    "-w",
                    raw,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            return None
        if added.returncode != 0:
            return None
    if not raw:
        return None
    try:
        key = base64.urlsafe_b64decode(raw.encode("ascii"))
    except Exception as exc:  # noqa: BLE001
        raise SensitiveMemoryUnavailable("macOS Keychain returned an invalid memory key") from exc
    return key if len(key) == 32 else None


def _encryption_key(*, create: bool) -> bytes:
    key = _key_from_python_keyring(create=create) or _key_from_macos_keychain(create=create)
    if key is None:
        raise SensitiveMemoryUnavailable(
            "sensitive memory requires Python keyring or macOS Keychain; nothing was stored"
        )
    return key


def _encrypt(payload: dict[str, Any]) -> dict[str, str]:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ModuleNotFoundError as exc:
        raise SensitiveMemoryUnavailable(
            "sensitive memory requires the cryptography package; nothing was stored"
        ) from exc
    nonce = secrets.token_bytes(12)
    aad = b"sophia.personal-memory.v1"
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    cipher = AESGCM(_encryption_key(create=True)).encrypt(nonce, body, aad)
    return {
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(cipher).decode("ascii"),
    }


def _decrypt(row: dict[str, Any]) -> dict[str, Any]:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = base64.b64decode(str(row["nonce"]))
    cipher = base64.b64decode(str(row["ciphertext"]))
    plain = AESGCM(_encryption_key(create=False)).decrypt(
        nonce,
        cipher,
        b"sophia.personal-memory.v1",
    )
    value = json.loads(plain.decode("utf-8"))
    if not isinstance(value, dict):
        raise PersonalMemoryError("encrypted memory payload is not an object")
    return value


def _portable_key(passphrase: str, salt: bytes) -> bytes:
    if len(passphrase) < 10:
        raise ValueError("export passphrase must be at least 10 characters")
    try:
        from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    except ModuleNotFoundError as exc:
        raise SensitiveMemoryUnavailable(
            "encrypted memory export requires the cryptography package; nothing was written"
        ) from exc

    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(
        passphrase.encode("utf-8")
    )


def _portable_encrypt(payload: dict[str, Any], passphrase: str) -> dict[str, str]:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ModuleNotFoundError as exc:
        raise SensitiveMemoryUnavailable(
            "encrypted memory export requires the cryptography package; nothing was written"
        ) from exc

    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ciphertext = AESGCM(_portable_key(passphrase, salt)).encrypt(
        nonce,
        encoded,
        b"sophia.personal-memory.export.v1",
    )
    return {
        "schema": "sophia.personal-memory.portable-export.v1",
        "kdf": "scrypt-n32768-r8-p1",
        "salt": base64.b64encode(salt).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def _portable_decrypt(container: dict[str, Any], passphrase: str) -> dict[str, Any]:
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ModuleNotFoundError as exc:
        raise SensitiveMemoryUnavailable(
            "encrypted memory import requires the cryptography package; nothing was changed"
        ) from exc

    if container.get("schema") != "sophia.personal-memory.portable-export.v1":
        raise PersonalMemoryError("unsupported personal-memory export schema")
    try:
        salt = base64.b64decode(str(container["salt"]))
        nonce = base64.b64decode(str(container["nonce"]))
        ciphertext = base64.b64decode(str(container["ciphertext"]))
        plaintext = AESGCM(_portable_key(passphrase, salt)).decrypt(
            nonce,
            ciphertext,
            b"sophia.personal-memory.export.v1",
        )
    except (KeyError, ValueError, InvalidTag) as exc:
        raise PersonalMemoryError(
            "personal-memory import failed: wrong passphrase or corrupt export"
        ) from exc
    payload = json.loads(plaintext.decode("utf-8"))
    if not isinstance(payload, dict):
        raise PersonalMemoryError("personal-memory export payload is not an object")
    return payload


class PersonalMemoryStore:
    """Canonical Markdown store plus rebuildable lexical index."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or personal_memory_root()).expanduser()
        self.audit_path = self.root / "audit.jsonl"
        self.index_path = self.root / "index.sqlite"
        self.encrypted_path = self.root / "private.enc.jsonl"

    def initialize(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        created_canonical = False
        for namespace in SUBJECT_NAMESPACES:
            (self.root / namespace).mkdir(exist_ok=True)
        for name, description in (
            ("profile", "Stable facts about the user and their work."),
            ("preferences", "How the user wants Sophia to communicate and operate."),
        ):
            path = self.root / f"{name}.md"
            if not path.exists():
                _atomic_write(path, _frontmatter(name, description))
                created_canonical = True
        # Search reads canonical Markdown directly, so an existing derived
        # index never needs to be rebuilt on every prompt. Writes and explicit
        # reindex operations refresh it.
        if created_canonical or not self.index_path.exists():
            self.rebuild_index()

    def _path(self, namespace: str, subject: str) -> Path:
        ns = namespace.strip().lower()
        if ns not in CORE_NAMESPACES:
            raise ValueError(f"unknown memory namespace {namespace!r}")
        if ns in {"profile", "preferences"}:
            return self.root / f"{ns}.md"
        return self.root / ns / f"{_slug(subject)}.md"

    def _audit(self, action: str, **fields: Any) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        row = {
            "schema": "sophia.personal-memory.audit.v1",
            "timestamp": _now(),
            "action": action,
            "candidateOnly": True,
            "canClaimAGI": False,
            **fields,
        }
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")

    def write_fact(
        self,
        *,
        namespace: str,
        subject: str,
        fact: str,
        source_role: str = "user",
        approved_sensitive: bool = False,
        aliases: Iterable[str] = (),
    ) -> MemoryWriteResult:
        fact = " ".join(str(fact).split()).strip()
        if not fact:
            raise ValueError("fact is required")
        if source_role != "user":
            self._audit(
                "review_required",
                namespace=namespace,
                subject=_slug(subject),
                reason="only explicit user statements are auto-writable",
                factHash=_line_hash(fact),
            )
            return MemoryWriteResult(
                "queued_review",
                reason="Only explicit user statements can be written automatically.",
            )
        sensitive = is_sensitive_fact(fact)
        if sensitive and not approved_sensitive:
            self._audit(
                "sensitive_confirmation_required",
                namespace=namespace,
                subject=_slug(subject),
                factHash=_line_hash(fact),
            )
            return MemoryWriteResult(
                "needs_confirmation",
                reason="Sensitive memory requires explicit approval before encrypted storage.",
                sensitive=True,
            )
        self.initialize()
        if sensitive:
            encrypted = _encrypt(
                {
                    "namespace": namespace,
                    "subject": subject,
                    "fact": fact,
                    "sourceRole": source_role,
                    "createdAt": _now(),
                }
            )
            row = {
                "schema": "sophia.personal-memory.encrypted.v1",
                "id": _line_hash(f"{namespace}:{subject}:{fact}"),
                **encrypted,
            }
            with self.encrypted_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, sort_keys=True) + "\n")
            self._audit(
                "encrypted_fact_saved",
                namespace=namespace,
                subject=_slug(subject),
                factHash=_line_hash(fact),
            )
            return MemoryWriteResult(
                "saved",
                path=str(self.encrypted_path),
                sensitive=True,
            )

        path = self._path(namespace, subject)
        line = f"- [stated] {fact}"
        if path.exists():
            current = path.read_text(encoding="utf-8")
            if line in current.splitlines():
                return MemoryWriteResult("unchanged", path=str(path), reason="fact already present")
            updated = current.rstrip() + "\n" + line + "\n"
        else:
            name = _slug(subject)
            description = f"User-stated context about {subject.strip() or name}."
            updated = _frontmatter(name, description, aliases) + line + "\n"
        _atomic_write(path, updated)
        self.rebuild_index()
        self._audit(
            "fact_saved",
            namespace=namespace,
            subject=_slug(subject),
            path=str(path.relative_to(self.root)),
            factHash=_line_hash(fact),
        )
        return MemoryWriteResult("saved", path=str(path), sensitive=False)

    def _canonical_rows(self) -> list[tuple[str, str, str, str]]:
        rows: list[tuple[str, str, str, str]] = []
        for path in sorted(self.root.rglob("*.md")):
            if not path.is_file():
                continue
            rel = path.relative_to(self.root)
            namespace = rel.parts[0] if len(rel.parts) > 1 else path.stem
            subject = path.stem
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeError):
                continue
            for line in lines:
                if not line.startswith("- [stated] "):
                    continue
                fact = line[len("- [stated] ") :].strip()
                if fact:
                    rows.append((str(rel), namespace, subject, fact))
        return rows

    def rebuild_index(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.index_path)
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS facts "
                "(source TEXT, namespace TEXT, subject TEXT, text TEXT)"
            )
            conn.execute("DELETE FROM facts")
            conn.executemany(
                "INSERT INTO facts(source, namespace, subject, text) VALUES (?, ?, ?, ?)",
                self._canonical_rows(),
            )
            try:
                conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5("
                    "source UNINDEXED, namespace, subject, text)"
                )
                conn.execute("DELETE FROM facts_fts")
                conn.execute(
                    "INSERT INTO facts_fts(source, namespace, subject, text) "
                    "SELECT source, namespace, subject, text FROM facts"
                )
            except sqlite3.OperationalError:
                # Some minimal Python builds omit FTS5; the plain table remains a
                # valid rebuildable index and search falls back to in-process scoring.
                pass
            conn.commit()
        finally:
            conn.close()

    def search(
        self,
        query: str,
        *,
        limit: int = 8,
        workspace: str | Path | None = None,
        include_sensitive: bool = False,
    ) -> list[MemoryHit]:
        self.initialize()
        root_name = Path(workspace).name.casefold() if workspace else ""
        hits: list[MemoryHit] = []
        for source, namespace, subject, fact in self._canonical_rows():
            score = _score(query, f"{namespace} {subject} {fact}")
            if root_name and (
                root_name in subject.casefold() or root_name in source.casefold()
            ):
                score += 0.8
            if score <= 0:
                continue
            hits.append(
                MemoryHit(
                    source=source,
                    kind=namespace,
                    subject=subject,
                    text=fact,
                    score=score,
                )
            )
        if include_sensitive and self.encrypted_path.exists():
            try:
                rows = [
                    json.loads(line)
                    for line in self.encrypted_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                for row in rows:
                    payload = _decrypt(row)
                    fact = str(payload.get("fact") or "")
                    score = _score(query, fact)
                    if score > 0:
                        hits.append(
                            MemoryHit(
                                source=f"encrypted:{row.get('id', '')}",
                                kind=str(payload.get("namespace") or "private"),
                                subject=str(payload.get("subject") or "private"),
                                text=fact,
                                score=score,
                                sensitive=True,
                            )
                        )
            except Exception:  # noqa: BLE001 - locked/corrupt private rows fail closed
                pass
        hits.sort(key=lambda hit: (-hit.score, hit.source, hit.text))
        return hits[: max(0, limit)]

    def export_encrypted(self, destination: str | Path, *, passphrase: str) -> Path:
        """Write a passphrase-encrypted, portable export.

        Private rows are decrypted only in memory and immediately wrapped by
        the portable export encryption, so the destination can re-encrypt them
        under its own OS/keyring key on import.
        """
        self.initialize()
        files = {
            str(path.relative_to(self.root)): path.read_text(encoding="utf-8")
            for path in sorted(self.root.rglob("*.md"))
            if path.is_file()
        }
        private: list[dict[str, Any]] = []
        if self.encrypted_path.exists():
            for line in self.encrypted_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                private.append(_decrypt(json.loads(line)))
        payload = {
            "schema": "sophia.personal-memory.payload.v1",
            "createdAt": _now(),
            "files": files,
            "private": private,
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        target = Path(destination).expanduser()
        if target.exists() and target.is_dir():
            raise IsADirectoryError(target)
        _atomic_write(
            target,
            json.dumps(
                _portable_encrypt(payload, passphrase),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n",
        )
        self._audit(
            "portable_export",
            destination=str(target),
            markdownFiles=len(files),
            privateFacts=len(private),
        )
        return target

    def import_encrypted(self, source: str | Path, *, passphrase: str) -> dict[str, int]:
        """Merge a portable export into this store without deleting local facts."""
        source_path = Path(source).expanduser()
        try:
            container = json.loads(source_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise PersonalMemoryError(f"cannot read personal-memory export: {source_path}") from exc
        if not isinstance(container, dict):
            raise PersonalMemoryError("personal-memory export container is not an object")
        payload = _portable_decrypt(container, passphrase)
        if payload.get("schema") != "sophia.personal-memory.payload.v1":
            raise PersonalMemoryError("unsupported personal-memory payload schema")
        files = payload.get("files")
        private = payload.get("private")
        if not isinstance(files, dict) or not isinstance(private, list):
            raise PersonalMemoryError("personal-memory payload is malformed")

        self.initialize()
        imported_facts = 0
        for rel, text in sorted(files.items()):
            rel_path = Path(str(rel))
            if (
                rel_path.is_absolute()
                or ".." in rel_path.parts
                or len(rel_path.parts) > 2
                or rel_path.suffix != ".md"
            ):
                raise PersonalMemoryError(f"unsafe path in personal-memory export: {rel}")
            namespace = rel_path.parts[0] if len(rel_path.parts) > 1 else rel_path.stem
            subject = rel_path.stem
            if namespace not in CORE_NAMESPACES:
                raise PersonalMemoryError(f"unknown namespace in personal-memory export: {namespace}")
            for line in str(text).splitlines():
                if not line.startswith("- [stated] "):
                    continue
                result = self.write_fact(
                    namespace=namespace,
                    subject=subject,
                    fact=line[len("- [stated] ") :].strip(),
                    source_role="user",
                )
                if result.status == "saved":
                    imported_facts += 1

        existing_ids: set[str] = set()
        if self.encrypted_path.exists():
            for line in self.encrypted_path.read_text(encoding="utf-8").splitlines():
                try:
                    existing_ids.add(str(json.loads(line).get("id") or ""))
                except json.JSONDecodeError:
                    continue
        imported_private = 0
        for value in private:
            if not isinstance(value, dict):
                raise PersonalMemoryError("private personal-memory row is malformed")
            namespace = str(value.get("namespace") or "")
            subject = str(value.get("subject") or "")
            fact = str(value.get("fact") or "").strip()
            if namespace not in CORE_NAMESPACES or not subject or not fact:
                raise PersonalMemoryError("private personal-memory row is incomplete")
            row_id = _line_hash(f"{namespace}:{subject}:{fact}")
            if row_id in existing_ids:
                continue
            encrypted = _encrypt(
                {
                    "namespace": namespace,
                    "subject": subject,
                    "fact": fact,
                    "sourceRole": "user",
                    "createdAt": str(value.get("createdAt") or _now()),
                }
            )
            with self.encrypted_path.open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "schema": "sophia.personal-memory.encrypted.v1",
                            "id": row_id,
                            **encrypted,
                        },
                        sort_keys=True,
                    )
                    + "\n"
                )
            existing_ids.add(row_id)
            imported_private += 1

        self.rebuild_index()
        self._audit(
            "portable_import",
            source=str(source_path),
            importedFacts=imported_facts,
            importedPrivate=imported_private,
        )
        return {"facts": imported_facts, "private": imported_private}


def search_transcripts(
    query: str,
    *,
    current_history: Iterable[dict[str, Any]] = (),
    current_session: str = "",
    limit: int = 6,
) -> list[MemoryHit]:
    """Search current-session turns first, then other local transcript JSON."""
    candidates: list[MemoryHit] = []
    seen: set[str] = set()

    def add_turns(turns: Iterable[dict[str, Any]], source: str, bonus: float) -> None:
        for idx, turn in enumerate(turns):
            role = str(turn.get("role") or "unknown").lower()
            if role not in {"user", "assistant"}:
                continue
            text = str(turn.get("content") or "").strip()
            if not text:
                continue
            score = _score(query, text) + bonus
            if score <= bonus:
                continue
            key = _line_hash(f"{role}:{text}")
            if key in seen:
                continue
            seen.add(key)
            candidates.append(
                MemoryHit(
                    source=f"{source}#turn-{idx + 1}",
                    kind="conversation",
                    subject=current_session or Path(source).stem,
                    text=text[:600],
                    score=score,
                    role=role,
                )
            )

    add_turns(current_history, f"session:{current_session or 'current'}", 1.0)
    try:
        from agent.cli import _conversations_dir

        paths = sorted(
            _conversations_dir().glob("*.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )[:80]
    except Exception:  # noqa: BLE001
        paths = []
    for path in paths:
        if current_session and path.stem == current_session:
            continue
        try:
            turns = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if isinstance(turns, list):
            add_turns(
                (turn for turn in turns if isinstance(turn, dict)),
                str(path),
                0.0,
            )
    candidates.sort(key=lambda hit: (-hit.score, hit.source))
    return candidates[: max(0, limit)]


__all__ = [
    "CORE_NAMESPACES",
    "MemoryHit",
    "MemoryCandidate",
    "MemoryWriteResult",
    "PersonalMemoryError",
    "PersonalMemoryStore",
    "SensitiveMemoryUnavailable",
    "is_sensitive_fact",
    "extract_explicit_memory_candidates",
    "personal_memory_root",
    "search_transcripts",
]


def _main(argv: list[str] | None = None) -> int:
    """Small local-only operator CLI for encrypted export/import."""
    import argparse
    import getpass

    parser = argparse.ArgumentParser(description="Sophia personal-memory utilities")
    sub = parser.add_subparsers(dest="command", required=True)
    export_cmd = sub.add_parser("export", help="create a passphrase-encrypted export")
    export_cmd.add_argument("path")
    import_cmd = sub.add_parser("import", help="merge a passphrase-encrypted export")
    import_cmd.add_argument("path")
    sub.add_parser("reindex", help="rebuild the derived SQLite index")
    args = parser.parse_args(argv)
    store = PersonalMemoryStore()
    if args.command == "reindex":
        store.initialize()
        print(store.index_path)
        return 0
    passphrase = getpass.getpass("Export passphrase: ")
    if args.command == "export":
        confirm = getpass.getpass("Confirm passphrase: ")
        if passphrase != confirm:
            parser.error("passphrases do not match")
        print(store.export_encrypted(args.path, passphrase=passphrase))
        return 0
    result = store.import_encrypted(args.path, passphrase=passphrase)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - interactive operator path
    raise SystemExit(_main())
