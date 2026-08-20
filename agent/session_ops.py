# SPDX-License-Identifier: Apache-2.0
"""Atomic local session operations shared by non-UI callers.

The terminal transcript contract remains unchanged: every live conversation is a
top-level JSON array at ``<conversations>/<safe-session>.json``. New metadata,
checkpoints, archives, and the rebuildable search index live in hidden sidecars,
so older Sophia builds continue to read the same transcript bytes.

All storage is local-only. This module performs no network calls and never
implicitly includes transcript bodies in support/diagnostic artifacts.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SESSION_METADATA_SCHEMA = "sophia.tui.session.v1"
SESSION_EXPORT_SCHEMA = "sophia.tui.session_export.v1"
SESSION_ARCHIVE_SCHEMA = "sophia.tui.session_archive.v1"
SESSION_INDEX_SCHEMA = "sophia.tui.session_index.v1"

LOCAL_ONLY_POLICY: dict[str, Any] = {
    "scope": "local-only",
    "remoteSync": False,
    "supportBundleTranscriptDefault": False,
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(now: datetime | None = None) -> str:
    value = now or _utc_now()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_session_filename(name: str) -> str:
    """Mirror ``agent.cli._conversation_path`` character-for-character."""
    raw = str(name or "tui-default")
    safe = "".join(char if char.isalnum() or char in "-_." else "_" for char in raw)
    return f"{safe or 'default'}.json"


def canonical_session_id(name: str) -> str:
    return Path(safe_session_filename(name)).stem


def session_storage_key(name: str) -> str:
    digest = hashlib.sha256(canonical_session_id(name).encode("utf-8")).hexdigest()
    return f"s-{digest[:24]}"


def _default_root() -> Path:
    from agent import cli

    return Path(cli._conversations_dir())


def _normalize_tags(tags: Iterable[Any]) -> list[str]:
    normalized: set[str] = set()
    for value in tags:
        tag = str(value or "").strip().lower()
        if not tag:
            continue
        if len(tag) > 64:
            raise ValueError("session tag must be at most 64 characters")
        if any(ord(char) < 32 or ord(char) == 127 for char in tag):
            raise ValueError("session tag contains control characters")
        normalized.add(tag)
    return sorted(normalized)


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        # Directory fsync is best-effort on filesystems that do not support it.
        pass
    finally:
        os.close(fd)


def _ensure_private_dir(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        directory.chmod(0o700)
    except OSError:
        # The mkdir mode already requests privacy; preserve compatibility with
        # filesystems that do not permit a follow-up chmod.
        pass


def _write_temp_sibling(path: Path, text: str) -> Path:
    _ensure_private_dir(path.parent)
    fd, raw_tmp = tempfile.mkstemp(
        prefix=f".{path.name}.{os.getpid()}.", suffix=".tmp", dir=path.parent,
    )
    tmp = Path(raw_tmp)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", closefd=True) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            # Preserve the original write failure instead of masking it with a
            # secondary close error.
            pass
        tmp.unlink(missing_ok=True)
        raise
    return tmp


def atomic_write_text(path: str | Path, text: str) -> Path:
    target = Path(path)
    tmp = _write_temp_sibling(target, text)
    try:
        os.replace(tmp, target)
        try:
            target.chmod(0o600)
        except OSError:
            # Atomic publication succeeded; chmod is best-effort on filesystems
            # that do not expose POSIX permission changes.
            pass
        _fsync_dir(target.parent)
        return target
    finally:
        tmp.unlink(missing_ok=True)


def atomic_create_text(path: str | Path, text: str) -> Path:
    """Publish a fully-flushed file without ever clobbering an existing one."""
    target = Path(path)
    tmp = _write_temp_sibling(target, text)
    try:
        os.link(tmp, target)
        try:
            target.chmod(0o600)
        except OSError:
            # Atomic publication succeeded; chmod is best-effort on filesystems
            # that do not expose POSIX permission changes.
            pass
        _fsync_dir(target.parent)
        return target
    finally:
        tmp.unlink(missing_ok=True)


def atomic_write_json(path: str | Path, value: Any) -> Path:
    return atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def atomic_create_json(path: str | Path, value: Any) -> Path:
    return atomic_create_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _strict_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8", errors="strict"))


def _transcript(path: Path) -> list[Any]:
    value = _strict_json(path)
    if not isinstance(value, list):
        raise ValueError("conversation file is not a JSON array")
    return value


def _topic(turns: Sequence[Any]) -> str:
    first_user = ""
    nudge_patterns = (
        re.compile(r"^\[auto-continue \d+/", re.I),
        re.compile(r"^You just received output from `", re.I),
        re.compile(r"^The last tool `[^`]*` FAILED:", re.I),
        re.compile(r"^You announced an action but did not call a tool\b", re.I),
        re.compile(r"^STOP NARRATING\b", re.I),
        re.compile(r"^You executed \d+ tool calls?\b", re.I),
        re.compile(r"^\(reached \d+-iteration ceiling\b", re.I),
    )
    for item in turns:
        if not isinstance(item, Mapping) or str(item.get("role") or "user") != "user":
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        if not first_user:
            first_user = content
        if content.startswith(("[tool", "[native tool calls", "[incomplete native")):
            continue
        if any(pattern.search(content) for pattern in nudge_patterns):
            continue
        return content
    return first_user


def _last_user(turns: Sequence[Any]) -> str:
    for item in reversed(turns):
        if isinstance(item, Mapping) and str(item.get("role") or "user") == "user":
            content = str(item.get("content") or "").strip()
            if content:
                return content
    return ""


@dataclass(frozen=True)
class SessionOpResult:
    session_id: str
    path: Path
    metadata: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": True,
            "sessionId": self.session_id,
            "path": str(self.path),
            "metadata": self.metadata,
        }


class SessionOps:
    """Filesystem-backed session lifecycle operations."""

    def __init__(self, root: str | Path | None = None):
        self.root = Path(root).expanduser().resolve() if root is not None else _default_root().resolve()
        _ensure_private_dir(self.root)

    # --- safe paths ----------------------------------------------------- #
    def conversation_path(self, session: str) -> Path:
        target = self.root / safe_session_filename(session)
        if target.parent.resolve() != self.root:
            raise ValueError("session path escaped conversations root")
        return target

    def metadata_dir(self) -> Path:
        return self.root / ".session-meta"

    def metadata_path(self, session: str) -> Path:
        return self.metadata_dir() / f"{session_storage_key(session)}.json"

    def checkpoint_dir(self, session: str) -> Path:
        return self.metadata_dir() / "checkpoints" / session_storage_key(session)

    def archive_dir(self) -> Path:
        return self.root / ".archive"

    def index_path(self) -> Path:
        return self.root / ".session-index.json"

    def _relative(self, target: Path) -> str:
        resolved = target.resolve(strict=False)
        try:
            relative = resolved.relative_to(self.root)
        except ValueError as exc:
            raise ValueError("session artifact escaped conversations root") from exc
        if not relative.parts or ".." in relative.parts:
            raise ValueError("unsafe session artifact path")
        return relative.as_posix()

    def _from_relative(self, relative: str) -> Path:
        value = Path(relative)
        if value.is_absolute() or ".." in value.parts:
            raise ValueError("unsafe session artifact path")
        target = (self.root / value).resolve(strict=False)
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise ValueError("session artifact escaped conversations root") from exc
        return target

    # --- metadata ------------------------------------------------------- #
    def _synthesized_metadata(self, session: str) -> dict[str, Any]:
        session_id = canonical_session_id(session)
        transcript = self.conversation_path(session_id)
        now = _iso()
        created_at = now
        updated_at = now
        try:
            stat = transcript.stat()
            created_at = datetime.fromtimestamp(stat.st_ctime, timezone.utc).isoformat().replace("+00:00", "Z")
            updated_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
        except OSError:
            # A missing or unreadable transcript is represented with the
            # synthesized current timestamps initialized above.
            pass
        return {
            "schema": SESSION_METADATA_SCHEMA,
            "sessionId": session_id,
            "name": session_id,
            "title": session_id,
            "tags": [],
            "createdAt": created_at,
            "updatedAt": updated_at,
            "checkpoints": [],
            "storagePolicy": dict(LOCAL_ONLY_POLICY),
            "candidateOnly": True,
            "canClaimAGI": False,
        }

    def _normalize_checkpoint(self, value: Any) -> dict[str, Any] | None:
        if not isinstance(value, Mapping):
            return None
        checkpoint_id = str(value.get("id") or "").strip()
        relative = str(value.get("relativePath") or "").strip()
        rel_path = Path(relative)
        if not checkpoint_id or not relative or rel_path.is_absolute() or ".." in rel_path.parts:
            return None
        out = {
            "id": checkpoint_id,
            "createdAt": str(value.get("createdAt") or _iso()),
            "turns": max(0, int(value.get("turns") or 0)),
            "sha256": str(value.get("sha256") or ""),
            "relativePath": rel_path.as_posix(),
        }
        if value.get("label"):
            out["label"] = str(value["label"])[:120]
        return out

    def _normalize_metadata(self, session: str, value: Any) -> dict[str, Any]:
        fallback = self._synthesized_metadata(session)
        if not isinstance(value, Mapping):
            return fallback
        raw_id = str(value.get("sessionId") or fallback["sessionId"])
        session_id = canonical_session_id(raw_id)
        parent_value = value.get("parent")
        parent: dict[str, Any] | None = None
        if isinstance(parent_value, Mapping) and str(parent_value.get("sessionId") or "").strip():
            parent = {
                "sessionId": canonical_session_id(str(parent_value["sessionId"])),
                "forkedAt": str(parent_value.get("forkedAt") or fallback["createdAt"]),
            }
            for key, cap in (("checkpointId", 160), ("nodeId", 160), ("nodeTitle", 240)):
                if parent_value.get(key):
                    parent[key] = str(parent_value[key])[:cap]
            if parent_value.get("turn") is not None:
                parent["turn"] = max(0, int(parent_value["turn"]))
        checkpoints = [
            checkpoint
            for item in (value.get("checkpoints") or [])
            if (checkpoint := self._normalize_checkpoint(item)) is not None
        ] if isinstance(value.get("checkpoints") or [], list) else []
        metadata = {
            "schema": SESSION_METADATA_SCHEMA,
            "sessionId": session_id,
            "name": str(value.get("name") or session_id),
            "title": (str(value.get("title") or value.get("name") or session_id).strip()[:240] or session_id),
            "tags": _normalize_tags(value.get("tags") or []),
            "createdAt": str(value.get("createdAt") or fallback["createdAt"]),
            "updatedAt": str(value.get("updatedAt") or fallback["updatedAt"]),
            "checkpoints": checkpoints,
            "storagePolicy": dict(LOCAL_ONLY_POLICY),
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if value.get("archivedAt"):
            metadata["archivedAt"] = str(value["archivedAt"])
        if parent:
            metadata["parent"] = parent
        return metadata

    def load_metadata(self, session: str) -> dict[str, Any]:
        try:
            return self._normalize_metadata(session, _strict_json(self.metadata_path(session)))
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
            return self._synthesized_metadata(session)

    def _save_metadata(self, metadata: Mapping[str, Any]) -> None:
        normalized = self._normalize_metadata(str(metadata.get("sessionId") or ""), metadata)
        atomic_write_json(self.metadata_path(normalized["sessionId"]), normalized)

    # --- lifecycle ------------------------------------------------------ #
    def create(
        self,
        session: str,
        *,
        title: str | None = None,
        tags: Iterable[str] = (),
        parent_session_id: str | None = None,
        copy_parent_transcript: bool = True,
        parent_checkpoint_id: str | None = None,
        fork_node_id: str | None = None,
        fork_node_title: str | None = None,
        fork_turn: int | None = None,
        turns: Sequence[Mapping[str, Any]] | None = None,
        now: datetime | None = None,
    ) -> SessionOpResult:
        session_id = canonical_session_id(session)
        transcript_path = self.conversation_path(session_id)
        created_at = _iso(now)
        transcript: list[Any] = list(turns or [])
        parent: dict[str, Any] | None = None
        if parent_session_id:
            parent_id = canonical_session_id(parent_session_id)
            parent_path = self.conversation_path(parent_id)
            if not parent_path.exists():
                raise FileNotFoundError(f"parent session does not exist: {parent_id}")
            if turns is None and copy_parent_transcript:
                transcript = _transcript(parent_path)
            parent = {"sessionId": parent_id, "forkedAt": created_at}
            if parent_checkpoint_id:
                parent["checkpointId"] = str(parent_checkpoint_id)[:160]
            if fork_node_id:
                parent["nodeId"] = str(fork_node_id)[:160]
            if fork_node_title:
                parent["nodeTitle"] = str(fork_node_title)[:240]
            if fork_turn is not None:
                parent["turn"] = max(0, int(fork_turn))
        metadata = {
            "schema": SESSION_METADATA_SCHEMA,
            "sessionId": session_id,
            "name": session_id,
            "title": (str(title or session_id).strip()[:240] or session_id),
            "tags": _normalize_tags(tags),
            "createdAt": created_at,
            "updatedAt": created_at,
            "checkpoints": [],
            "storagePolicy": dict(LOCAL_ONLY_POLICY),
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if parent:
            metadata["parent"] = parent
        atomic_create_text(
            transcript_path,
            json.dumps(transcript, ensure_ascii=False, indent=2) + "\n",
        )
        try:
            atomic_create_json(self.metadata_path(session_id), metadata)
        except BaseException:
            transcript_path.unlink(missing_ok=True)
            raise
        return SessionOpResult(session_id, transcript_path, metadata)

    new = create

    def checkpoint(
        self,
        session: str,
        *,
        label: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        session_id = canonical_session_id(session)
        transcript_path = self.conversation_path(session_id)
        turns = _transcript(transcript_path)
        raw = transcript_path.read_bytes()
        created_at = _iso(now)
        stamp = re.sub(r"\D", "", created_at)[:17]
        digest = hashlib.sha256(raw).hexdigest()
        checkpoint_id = f"cp-{stamp}-{digest[:10]}"
        checkpoint_path = self.checkpoint_dir(session_id) / f"{checkpoint_id}.json"
        atomic_create_text(checkpoint_path, raw.decode("utf-8", errors="strict"))
        checkpoint = {
            "id": checkpoint_id,
            "createdAt": created_at,
            "turns": len(turns),
            "sha256": digest,
            "relativePath": self._relative(checkpoint_path),
        }
        if label:
            checkpoint["label"] = str(label).strip()[:120]
        metadata = self.load_metadata(session_id)
        metadata["updatedAt"] = created_at
        metadata["checkpoints"] = [
            item for item in metadata["checkpoints"] if item.get("id") != checkpoint_id
        ] + [checkpoint]
        try:
            self._save_metadata(metadata)
        except BaseException:
            checkpoint_path.unlink(missing_ok=True)
            raise
        return {
            **SessionOpResult(session_id, transcript_path, metadata).to_dict(),
            "checkpoint": checkpoint,
            "checkpointPath": str(checkpoint_path),
        }

    def fork(
        self,
        parent_session: str,
        new_session: str,
        **kwargs: Any,
    ) -> SessionOpResult:
        checkpoint = self.checkpoint(
            parent_session,
            label=f"fork:{canonical_session_id(new_session)}",
            now=kwargs.get("now"),
        )
        kwargs["parent_session_id"] = checkpoint["sessionId"]
        kwargs["parent_checkpoint_id"] = checkpoint["checkpoint"]["id"]
        return self.create(new_session, **kwargs)

    def tag(
        self,
        session: str,
        tags: Iterable[str] | None = None,
        *,
        add: Iterable[str] = (),
        remove: Iterable[str] = (),
        replace: Iterable[str] | None = None,
        now: datetime | None = None,
    ) -> SessionOpResult:
        session_id = canonical_session_id(session)
        transcript_path = self.conversation_path(session_id)
        if not transcript_path.exists():
            raise FileNotFoundError(f"session does not exist: {session_id}")
        metadata = self.load_metadata(session_id)
        if tags is not None:
            next_tags = _normalize_tags(tags)
        elif replace is not None:
            next_tags = _normalize_tags(replace)
        else:
            next_set = set(metadata["tags"])
            next_set.update(_normalize_tags(add))
            next_set.difference_update(_normalize_tags(remove))
            next_tags = sorted(next_set)
        metadata["tags"] = next_tags
        metadata["updatedAt"] = _iso(now)
        self._save_metadata(metadata)
        return SessionOpResult(session_id, transcript_path, metadata)

    def _projection_paths(self, session_id: str) -> dict[str, Path]:
        transcript = self.conversation_path(session_id)
        return {
            "markdown": transcript.with_suffix(".md"),
            "rag": self.root / "rag" / f"{session_id}.jsonl",
            "okf": self.root / "okf" / session_id,
        }

    def rename(
        self,
        session: str,
        new_name: str,
        *,
        now: datetime | None = None,
    ) -> SessionOpResult:
        source_id = canonical_session_id(session)
        destination_id = canonical_session_id(new_name)
        source = self.conversation_path(source_id)
        destination = self.conversation_path(destination_id)
        if source_id == destination_id:
            return SessionOpResult(source_id, source, self.load_metadata(source_id))
        if not source.exists():
            raise FileNotFoundError(f"session does not exist: {source_id}")
        if destination.exists():
            raise FileExistsError(f"session already exists: {destination_id}")
        os.link(source, destination)
        moved: list[tuple[Path, Path]] = []
        try:
            source_projection = self._projection_paths(source_id)
            destination_projection = self._projection_paths(destination_id)
            pairs = [
                (source_projection["markdown"], destination_projection["markdown"]),
                (source_projection["rag"], destination_projection["rag"]),
                (source_projection["okf"], destination_projection["okf"]),
                (self.checkpoint_dir(source_id), self.checkpoint_dir(destination_id)),
            ]
            for old, new in pairs:
                if not old.exists():
                    continue
                if new.exists():
                    raise FileExistsError(f"destination already exists: {new}")
                _ensure_private_dir(new.parent)
                old.rename(new)
                moved.append((old, new))
            metadata = self.load_metadata(source_id)
            checkpoint_prefix = self._relative(self.checkpoint_dir(destination_id))
            metadata["sessionId"] = destination_id
            metadata["name"] = destination_id
            if metadata.get("title") == source_id:
                metadata["title"] = destination_id
            metadata["updatedAt"] = _iso(now)
            metadata["checkpoints"] = [
                {
                    **item,
                    "relativePath": f"{checkpoint_prefix}/{Path(item['relativePath']).name}",
                }
                for item in metadata["checkpoints"]
            ]
            atomic_create_json(self.metadata_path(destination_id), metadata)
            source.unlink()
            self.metadata_path(source_id).unlink(missing_ok=True)
            _fsync_dir(self.root)
            return SessionOpResult(destination_id, destination, metadata)
        except BaseException:
            for old, new in reversed(moved):
                try:
                    new.rename(old)
                except OSError:
                    # Rollback is best-effort; keep the original operation
                    # failure as the exception reported to the caller.
                    pass
            destination.unlink(missing_ok=True)
            self.metadata_path(destination_id).unlink(missing_ok=True)
            raise

    def _remove_derived(self, session_id: str) -> None:
        paths = self._projection_paths(session_id)
        paths["markdown"].unlink(missing_ok=True)
        paths["rag"].unlink(missing_ok=True)
        shutil.rmtree(paths["okf"], ignore_errors=True)

    def reset(
        self,
        session: str,
        *,
        create_checkpoint: bool = True,
        checkpoint_label: str = "before-reset",
        now: datetime | None = None,
    ) -> dict[str, Any]:
        session_id = canonical_session_id(session)
        transcript_path = self.conversation_path(session_id)
        if not transcript_path.exists():
            raise FileNotFoundError(f"session does not exist: {session_id}")
        checkpoint = (
            self.checkpoint(session_id, label=checkpoint_label, now=now)
            if create_checkpoint else None
        )
        atomic_write_text(transcript_path, "[]\n")
        self._remove_derived(session_id)
        metadata = self.load_metadata(session_id)
        metadata["updatedAt"] = _iso(now)
        self._save_metadata(metadata)
        result = SessionOpResult(session_id, transcript_path, metadata).to_dict()
        if checkpoint:
            result["checkpoint"] = checkpoint["checkpoint"]
        return result

    def archive(
        self,
        session: str,
        *,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        session_id = canonical_session_id(session)
        transcript_path = self.conversation_path(session_id)
        if not transcript_path.exists():
            raise FileNotFoundError(f"session does not exist: {session_id}")
        archived_at = _iso(now)
        archive_stamp = re.sub(r"\D", "", archived_at)[:17]
        archive_name = f"{archive_stamp}-{session_storage_key(session_id)}"
        archive_root = self.archive_dir()
        _ensure_private_dir(archive_root)
        final_dir = archive_root / archive_name
        if final_dir.exists():
            raise FileExistsError(f"session archive already exists: {archive_name}")
        temp_dir = Path(tempfile.mkdtemp(prefix=f".{archive_name}.", suffix=".tmp", dir=archive_root))
        try:
            os.link(transcript_path, temp_dir / "transcript.json")
            projections = self._projection_paths(session_id)
            if projections["markdown"].exists():
                os.link(projections["markdown"], temp_dir / "transcript.md")
            metadata = self.load_metadata(session_id)
            archived_checkpoints: list[dict[str, Any]] = []
            for item in metadata["checkpoints"]:
                try:
                    source_checkpoint = self._from_relative(item["relativePath"])
                    checkpoint_dir = temp_dir / "checkpoints"
                    _ensure_private_dir(checkpoint_dir)
                    os.link(source_checkpoint, checkpoint_dir / source_checkpoint.name)
                    archived_checkpoints.append({
                        **item,
                        "relativePath": f"checkpoints/{source_checkpoint.name}",
                    })
                except OSError:
                    continue
            metadata["archivedAt"] = archived_at
            metadata["updatedAt"] = archived_at
            metadata["checkpoints"] = archived_checkpoints
            atomic_write_json(temp_dir / "metadata.json", metadata)
            atomic_write_json(temp_dir / "archive.json", {
                "schema": SESSION_ARCHIVE_SCHEMA,
                "archivedAt": archived_at,
                "session": metadata,
                "transcript": "transcript.json",
                "storagePolicy": dict(LOCAL_ONLY_POLICY),
                "candidateOnly": True,
                "canClaimAGI": False,
            })
            temp_dir.rename(final_dir)
            transcript_path.unlink()
            self.metadata_path(session_id).unlink(missing_ok=True)
            self._remove_derived(session_id)
            shutil.rmtree(self.checkpoint_dir(session_id), ignore_errors=True)
            _fsync_dir(archive_root)
            return {
                **SessionOpResult(session_id, final_dir / "transcript.json", metadata).to_dict(),
                "archivePath": str(final_dir),
            }
        except BaseException:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise

    def export(
        self,
        session: str,
        destination: str | Path,
        *,
        include_transcript: bool = True,
        overwrite: bool = False,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        session_id = canonical_session_id(session)
        transcript_path = self.conversation_path(session_id)
        if not transcript_path.exists():
            raise FileNotFoundError(f"session does not exist: {session_id}")
        output = Path(destination).expanduser().resolve()
        if output.exists() and output.is_dir():
            output = output / f"{session_storage_key(session_id)}.export.json"
        if output in {transcript_path.resolve(), self.metadata_path(session_id).resolve()}:
            raise ValueError("export destination must not overwrite live session storage")
        metadata = self.load_metadata(session_id)
        value = {
            "schema": SESSION_EXPORT_SCHEMA,
            "exportedAt": _iso(now),
            "storagePolicy": dict(LOCAL_ONLY_POLICY),
            "session": metadata,
            "transcriptIncluded": bool(include_transcript),
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if include_transcript:
            value["transcript"] = _transcript(transcript_path)
        writer = atomic_write_json if overwrite else atomic_create_json
        writer(output, value)
        return {
            **SessionOpResult(session_id, transcript_path, metadata).to_dict(),
            "exportPath": str(output),
            "transcriptIncluded": bool(include_transcript),
        }

    # --- rebuildable index/search -------------------------------------- #
    def _active_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for transcript_path in self.root.glob("*.json"):
            if transcript_path.name.startswith("."):
                continue
            try:
                turns = _transcript(transcript_path)
                stat = transcript_path.stat()
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                continue
            session_id = transcript_path.stem
            metadata = self.load_metadata(session_id)
            rows.append(self._index_entry(
                session_id, transcript_path, turns, metadata, stat.st_mtime * 1000, archived=False,
            ))
        return rows

    def _archived_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        archive_root = self.archive_dir()
        if not archive_root.is_dir():
            return rows
        for archive in archive_root.iterdir():
            if archive.name.startswith(".") or not archive.is_dir():
                continue
            transcript_path = archive / "transcript.json"
            try:
                turns = _transcript(transcript_path)
                metadata = self._normalize_metadata(
                    archive.name, _strict_json(archive / "metadata.json"),
                )
                updated = datetime.fromisoformat(
                    str(metadata["updatedAt"]).replace("Z", "+00:00"),
                ).timestamp() * 1000
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError):
                continue
            rows.append(self._index_entry(
                metadata["sessionId"], transcript_path, turns, metadata, updated, archived=True,
            ))
        return rows

    def _index_entry(
        self,
        session_id: str,
        transcript_path: Path,
        turns: Sequence[Any],
        metadata: Mapping[str, Any],
        updated_at: float,
        *,
        archived: bool,
    ) -> dict[str, Any]:
        topic = re.sub(r"\s+", " ", _topic(turns)).strip()[:80]
        last = re.sub(r"\s+", " ", _last_user(turns)).strip()[:120]
        parent = metadata.get("parent") if isinstance(metadata.get("parent"), Mapping) else {}
        entry = {
            "id": session_id,
            "name": str(metadata.get("name") or session_id),
            "title": str(metadata.get("title") or session_id),
            "path": str(transcript_path),
            "turns": len(turns),
            "createdAt": str(metadata.get("createdAt") or ""),
            "updatedAt": updated_at,
            "description": topic,
            "lastPreview": last,
            "tags": list(metadata.get("tags") or []),
            "archived": archived,
            "checkpointCount": len(metadata.get("checkpoints") or []),
            "storagePolicy": dict(LOCAL_ONLY_POLICY),
        }
        if parent.get("sessionId"):
            entry["parentSessionId"] = str(parent["sessionId"])
        if parent.get("forkedAt"):
            entry["forkedAt"] = str(parent["forkedAt"])
        return entry

    def rebuild_index(
        self,
        *,
        include_archived: bool = True,
        persist: bool = False,
        now: datetime | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        entries = self._active_rows()
        if include_archived:
            entries.extend(self._archived_rows())
        entries.sort(key=lambda item: (-float(item["updatedAt"]), str(item["id"])))
        if limit is not None:
            entries = entries[:max(0, int(limit))]
        index = {
            "schema": SESSION_INDEX_SCHEMA,
            "generatedAt": _iso(now),
            "entries": entries,
            "storagePolicy": dict(LOCAL_ONLY_POLICY),
            "candidateOnly": True,
            "canClaimAGI": False,
        }
        if persist:
            atomic_write_json(self.index_path(), index)
        return index

    @staticmethod
    def search(
        index_or_entries: Mapping[str, Any] | Sequence[Mapping[str, Any]],
        *,
        query: str = "",
        tags: Iterable[str] = (),
        tag_mode: str = "all",
        archived: bool | None = None,
        parent_session_id: str | None = None,
        updated_after: float | datetime | None = None,
        updated_before: float | datetime | None = None,
        min_turns: int | None = None,
        max_turns: int | None = None,
    ) -> list[dict[str, Any]]:
        entries_raw = (
            index_or_entries.get("entries", [])
            if isinstance(index_or_entries, Mapping)
            else index_or_entries
        )
        entries = [dict(item) for item in entries_raw if isinstance(item, Mapping)]
        terms = [term for term in str(query).strip().lower().split() if term]
        required_tags = set(_normalize_tags(tags))

        def millis(value: float | datetime | None) -> float | None:
            if value is None:
                return None
            if isinstance(value, datetime):
                return value.timestamp() * 1000
            return float(value)

        after = millis(updated_after)
        before = millis(updated_before)
        out: list[dict[str, Any]] = []
        for entry in entries:
            if archived is not None and bool(entry.get("archived")) is not archived:
                continue
            if parent_session_id and entry.get("parentSessionId") != parent_session_id:
                continue
            updated = float(entry.get("updatedAt") or 0)
            turns = int(entry.get("turns") or 0)
            if after is not None and updated < after:
                continue
            if before is not None and updated > before:
                continue
            if min_turns is not None and turns < min_turns:
                continue
            if max_turns is not None and turns > max_turns:
                continue
            entry_tags = set(_normalize_tags(entry.get("tags") or []))
            if required_tags:
                if tag_mode == "any":
                    if not (required_tags & entry_tags):
                        continue
                elif not required_tags.issubset(entry_tags):
                    continue
            haystack = "\n".join([
                str(entry.get("id") or ""),
                str(entry.get("name") or ""),
                str(entry.get("title") or ""),
                str(entry.get("description") or ""),
                str(entry.get("lastPreview") or ""),
                str(entry.get("parentSessionId") or ""),
                *sorted(entry_tags),
            ]).lower()
            if any(term not in haystack for term in terms):
                continue
            out.append(entry)
        return sorted(out, key=lambda item: (-float(item.get("updatedAt") or 0), str(item.get("id") or "")))


# Command-oriented module-level wrappers. Each accepts ``root=`` so tests and
# embedding callers never touch the operator's real ~/.sophia state.
SessionOperations = SessionOps


def create_session(session: str, *, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).create(session, **kwargs).to_dict()


def new_session(session: str, *, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return create_session(session, root=root, **kwargs)


def rename_session(session: str, new_name: str, *, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).rename(session, new_name, **kwargs).to_dict()


def tag_session(session: str, tags: Iterable[str] | None = None, *, root: str | Path | None = None,
                **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).tag(session, tags, **kwargs).to_dict()


def archive_session(session: str, *, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).archive(session, **kwargs)


def export_session(session: str, destination: str | Path, *, root: str | Path | None = None,
                   **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).export(session, destination, **kwargs)


def reset_session(session: str, *, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).reset(session, **kwargs)


def checkpoint_session(session: str, *, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).checkpoint(session, **kwargs)


def rebuild_session_index(*, root: str | Path | None = None, **kwargs: Any) -> dict[str, Any]:
    return SessionOps(root).rebuild_index(**kwargs)


def search_sessions(index_or_entries: Mapping[str, Any] | Sequence[Mapping[str, Any]],
                    **kwargs: Any) -> list[dict[str, Any]]:
    return SessionOps.search(index_or_entries, **kwargs)


__all__ = [
    "LOCAL_ONLY_POLICY",
    "SESSION_ARCHIVE_SCHEMA",
    "SESSION_EXPORT_SCHEMA",
    "SESSION_INDEX_SCHEMA",
    "SESSION_METADATA_SCHEMA",
    "SessionOpResult",
    "SessionOperations",
    "SessionOps",
    "archive_session",
    "atomic_create_json",
    "atomic_create_text",
    "atomic_write_json",
    "atomic_write_text",
    "canonical_session_id",
    "checkpoint_session",
    "create_session",
    "export_session",
    "new_session",
    "rebuild_session_index",
    "rename_session",
    "reset_session",
    "safe_session_filename",
    "search_sessions",
    "session_storage_key",
    "tag_session",
]
