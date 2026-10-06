#!/usr/bin/env python3
"""Read the private playback journal and emit bounded, identifier-free aggregates.

Python 3.11 standard library only. This command never writes the input journal,
queries a database, changes playback, or claims an all-plays success rate.
"""
# ruff: noqa: RUF001 -- Operator-facing Russian prose intentionally uses Cyrillic.

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import sys
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeGuard

ISSUES = frozenset(
    {
        "player.unexpected_stop",
        "player.unexpected_pause",
        "player.rebuffer",
        "player.rebuffer_timeout",
        "player.playback_error",
    }
)
EVENTS = ISSUES | {
    "player.user_report",
    "player.rebuffer_recovered",
    "player.recovery_attempt",
    "player.recovery_ready",
    "player.recovery_resumed",
    "player.engine_pause",
    "player.track_end",
    "player.visibility_change",
}
# AudioEngineSourceType from the existing media metadata contract.
SOURCES = {"local", "peer", "tidal", "ytmusic", "audius", "vk", "yandex"}
PLATFORMS = {"android", "ios", "other"}
CATEGORIES = {
    "client_abort",
    "rate_limit",
    "timeout",
    "network",
    "unavailable",
    "provider_challenge",
    "unsupported_source",
    "unknown",
}
REPORT_REASONS = {"wrong_version", "no_sound", "interruption"}
OWNED_FILE = re.compile(r"incident-\d{13}-[a-f0-9]{16}\.jsonl\Z")
IDENTIFIER = re.compile(r"[a-zA-Z0-9_:-]{1,128}\Z")
MAX_LINE = 8192
MAX_BYTES = 64 * 1024 * 1024
MAX_RECORDS = 100_000
MAX_FILES = 64
MAX_ENTRIES = 4096
OUTCOMES = ("recovered", "failed", "unresolved")


def _number(value: Any) -> TypeGuard[int | float]:
    return (isinstance(value, int) and not isinstance(value, bool)) or (
        isinstance(value, float) and math.isfinite(value)
    )


def _identifier(value: Any) -> str | None:
    return value if isinstance(value, str) and IDENTIFIER.fullmatch(value) else None


def _label(value: Any, allowed: set[str]) -> str:
    return value if isinstance(value, str) and value in allowed else "unknown"


def _utc(milliseconds: float) -> str:
    return datetime.fromtimestamp(milliseconds / 1000, UTC).isoformat(timespec="seconds")


def _quality() -> dict[str, Any]:
    return {
        "files_read": 0,
        "bytes_read": 0,
        "rejected_records": 0,
        "read_errors": 0,
        "limits_reached": 0,
        "duplicate_records_removed": 0,
        "conflicting_event_ids": 0,
        "outside_window": 0,
    }


def _normalize(record: Any) -> dict[str, Any] | None:
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("event"), str)
        or record["event"] not in EVENTS
    ):
        return None
    timestamp = record.get("observedAtMs", record.get("receivedAtMs"))
    # Restrict to datetime's supported range; invalid observed times cannot silently
    # fall back to server delivery time and change outcome ordering.
    if not _number(timestamp) or not 0 <= timestamp < 253_402_300_799_000:
        return None
    fields = record.get("fields")
    if not isinstance(fields, dict):
        return None
    position = fields.get("currentTimeSec")
    if not _number(position) or not 0 <= position <= 86_400_000:
        position = None
    return {
        "event": record["event"],
        "time": timestamp,
        "owner": _identifier(record.get("userId")),
        "id": _identifier(record.get("eventId")),
        "run": _identifier(fields.get("playbackRunId")),
        "source": _label(fields.get("sourceType"), SOURCES),
        "platform": _label(fields.get("platform"), PLATFORMS),
        "category": _label(fields.get("errorCategory"), CATEGORIES),
        "reason": _label(fields.get("reason"), REPORT_REASONS),
        "position": position,
        "playing": fields.get("enginePlaying") is True,
        "fatal": fields.get("stage") in ("fatal", "fatal_after_recovery"),
    }


def summarize_records(
    records: Any,
    *,
    until_ms: int,
    hours: float = 24,
    input_quality: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Deduplicate trusted journal envelopes and classify explicit owner/run pairs.

    Conflicting copies of an event ID are quarantined rather than selected by
    delivery order. Legacy envelopes without event IDs only deduplicate exact
    records. Outcomes concern fault-bearing runs in the selected window alone.
    """
    if not _number(hours) or not 1 <= hours <= 168:
        raise ValueError("Window must be between 1 and 168 hours")
    if not _number(until_ms) or not 0 <= until_ms < 253_402_300_799_000:
        raise ValueError("Invalid window end")
    quality = _quality()
    if input_quality:
        for quality_key in quality:
            quality[quality_key] = input_quality.get(quality_key, 0)
    seen: dict[Any, tuple[str, dict[str, Any]]] = {}
    conflicts: set[Any] = set()
    for record in records:
        normalized = _normalize(record)
        if normalized is None:
            quality["rejected_records"] += 1
            continue
        # Receipt time changes on redelivery after a backend restart; the observed
        # event remains identical. Without an observed timestamp it is semantic.
        fingerprint = {
            key: value
            for key, value in record.items()
            if key != "receivedAtMs"
            or not (normalized["owner"] and normalized["id"] and "observedAtMs" in record)
        }
        digest = hashlib.sha256(
            json.dumps(fingerprint, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        identity = (
            (normalized["owner"], normalized["id"])
            if normalized["owner"] and normalized["id"]
            else ("exact", digest)
        )
        if identity in seen:
            if digest == seen[identity][0]:
                quality["duplicate_records_removed"] += 1
            else:
                conflicts.add(identity)
        else:
            seen[identity] = (digest, normalized)
    quality["conflicting_event_ids"] = len(conflicts)
    available = [value[1] for key, value in seen.items() if key not in conflicts]
    available.sort(key=lambda item: (item["time"], item["event"]))
    begin_ms = until_ms - hours * 3_600_000
    selected = [item for item in available if begin_ms <= item["time"] <= until_ms]
    quality["outside_window"] = len(available) - len(selected)
    quality["status"] = (
        "partial"
        if any(
            quality[key]
            for key in (
                "rejected_records",
                "read_errors",
                "limits_reached",
                "conflicting_event_ids",
            )
        )
        else "ok"
    )
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    events: Counter[str] = Counter()
    manual: Counter[str] = Counter()
    unlinked = 0
    for item in selected:
        events[item["event"]] += 1
        if item["event"] == "player.user_report":
            manual[item["reason"]] += 1
        if item["owner"] and item["run"]:
            grouped[(item["owner"], item["run"])].append(item)
        elif item["event"] in ISSUES:
            unlinked += 1
    outcomes = dict.fromkeys(OUTCOMES, 0)
    breakdown: dict[tuple[str, str, str, str], dict[str, int]] = {}
    hourly: Counter[str] = Counter()
    for items in grouped.values():
        faults = [item for item in items if item["event"] in ISSUES]
        if not faults:
            continue
        outcome = "unresolved"
        latest_fault = None
        for item in items:
            if item["event"] in ISSUES:
                latest_fault = item
                # A later nonterminal signal does not undo an explicit failure.
                if item["event"] == "player.playback_error" and item["fatal"]:
                    outcome = "failed"
                elif outcome != "failed":
                    outcome = "unresolved"
            elif latest_fault and item["time"] > latest_fault["time"] and item["playing"]:
                position = item["position"]
                baseline = latest_fault["position"]
                resumed = (
                    item["event"] == "player.recovery_resumed"
                    and position is not None
                    and position > 0
                )
                heartbeat = (
                    item["event"] == "player.rebuffer_recovered"
                    and position is not None
                    and baseline is not None
                    and position > baseline + 0.05
                )
                if resumed or heartbeat:
                    outcome = "recovered"
        first = faults[0]
        phase = (
            "unknown"
            if first["position"] is None
            else ("startup" if first["position"] == 0 else "continuation")
        )
        categories = [item["category"] for item in faults if item["category"] != "unknown"]
        key = (
            first["source"],
            first["platform"],
            phase,
            categories[-1] if categories else "unknown",
        )
        bucket = breakdown.setdefault(key, dict.fromkeys(OUTCOMES, 0))
        bucket[outcome] += 1
        outcomes[outcome] += 1
        hourly[_utc(first["time"] - first["time"] % 3_600_000)] += 1
    return {
        "schema_version": 1,
        "window": {"from_utc": _utc(max(begin_ms, 0)), "until_utc": _utc(until_ms), "hours": hours},
        "coverage": {
            "kind": "diagnostic_events_only",
            "earliest_available_event_utc": _utc(available[0]["time"]) if available else None,
            "latest_available_event_utc": _utc(available[-1]["time"]) if available else None,
        },
        "quality": quality,
        "unique_events_in_window": len(selected),
        "issue_events": sum(events[name] for name in ISSUES),
        "affected_runs": sum(outcomes.values()),
        "outcomes": outcomes,
        "unlinked_issue_events": unlinked,
        "manual_reports": dict(sorted(manual.items())),
        "event_counts": dict(sorted(events.items())),
        "breakdown": [
            {
                "source": key[0],
                "platform": key[1],
                "phase": key[2],
                "error_category": key[3],
                **value,
            }
            for key, value in sorted(breakdown.items())
        ],
        "hourly_affected_runs": [
            {"hour_utc": hour, "runs": count} for hour, count in sorted(hourly.items())
        ],
    }


def _read_journal(
    directory: Path, max_bytes: int, max_records: int
) -> tuple[list[Any], dict[str, Any]]:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Diagnostic journal unavailable")
    quality = _quality()
    records: list[Any] = []
    paths = []
    with os.scandir(directory) as entries:
        for count, entry in enumerate(entries):
            if count >= MAX_ENTRIES:
                quality["limits_reached"] += 1
                break
            if OWNED_FILE.fullmatch(entry.name):
                paths.append(Path(entry.path))
    if len(paths) > MAX_FILES:
        quality["limits_reached"] += 1
    attempts = 0
    for path in sorted(paths, reverse=True)[:MAX_FILES]:
        try:
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode):
                quality["read_errors"] += 1
                continue
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            descriptor = os.open(path, flags)
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or (metadata.st_dev, metadata.st_ino) != (
                    opened.st_dev,
                    opened.st_ino,
                ):
                    quality["read_errors"] += 1
                    continue
                quality["files_read"] += 1
                oversized = False
                while True:
                    remaining = max_bytes - quality["bytes_read"]
                    chunk = stream.readline(min(MAX_LINE + 1, remaining + 1))
                    if not chunk:
                        if oversized:
                            quality["rejected_records"] += 1
                        break
                    quality["bytes_read"] += len(chunk)
                    if len(chunk) > remaining or attempts >= max_records:
                        quality["limits_reached"] += 1
                        return records, quality
                    if oversized or len(chunk) > MAX_LINE:
                        oversized = not chunk.endswith(b"\n")
                        if not oversized:
                            quality["rejected_records"] += 1
                            attempts += 1
                        continue
                    attempts += 1
                    try:
                        records.append(json.loads(chunk))
                    except (ValueError, UnicodeError, RecursionError):
                        quality["rejected_records"] += 1
        except OSError:
            quality["read_errors"] += 1
    return records, quality


def generate_report(
    directory: Path,
    *,
    until_ms: int,
    hours: float = 24,
    max_bytes: int = MAX_BYTES,
    max_records: int = MAX_RECORDS,
) -> dict[str, Any]:
    """Read only bounded owned journal files; return aggregates and quality counters."""
    if max_bytes <= 0 or max_records <= 0:
        raise ValueError("Read limits must be positive")
    records, quality = _read_journal(Path(directory), max_bytes, max_records)
    return summarize_records(records, until_ms=until_ms, hours=hours, input_quality=quality)


def render_markdown(report: dict[str, Any]) -> str:
    """Render aggregate-only operator Markdown; do not accept raw journal records."""
    quality, outcomes, window = report["quality"], report["outcomes"], report["window"]
    rows = [
        "# Сводка диагностики воспроизведения",
        "",
        f"Период UTC: {window['from_utc']} — {window['until_utc']} ({window['hours']:g} ч).",
        "",
        f"Проблемных загрузок: **{report['affected_runs']}**. Восстановлены: **{outcomes['recovered']}**; "
        f"явный отказ: **{outcomes['failed']}**; итог неизвестен: **{outcomes['unresolved']}**.",
        "",
        f"Сигналов проблемы: {report['issue_events']}. Уникальных событий: {report['unique_events_in_window']}. "
        f"Сигналов без связи с загрузкой: {report['unlinked_issue_events']}.",
        "",
        "| Источник | Платформа | Фаза | Категория | Восстановлены | Отказ | Неизвестно |",
        "|---|---|---|---|---:|---:|---:|",
    ]
    rows.extend(
        f"| {item['source']} | {item['platform']} | {item['phase']} | {item['error_category']} | "
        f"{item['recovered']} | {item['failed']} | {item['unresolved']} |"
        for item in report["breakdown"]
    )
    rows.extend(["", "| Час UTC первой проблемы загрузки | Загрузок |", "|---|---:|"])
    rows.extend(
        f"| {item['hour_utc']} | {item['runs']} |" for item in report["hourly_affected_runs"]
    )
    rows.extend(
        [
            "",
            f"Качество обработки: **{quality['status']}**. Файлов: {quality['files_read']}; "
            f"удалено дубликатов: {quality['duplicate_records_removed']}; конфликтов ID: {quality['conflicting_event_ids']}; "
            f"отброшено записей: {quality['rejected_records']}; ошибок чтения: {quality['read_errors']}; "
            f"достигнуто ограничений: {quality['limits_reached']}.",
            "",
            "Жалобы: "
            + (
                ", ".join(f"{key}: {value}" for key, value in report["manual_reports"].items())
                or "0"
            )
            + ".",
            "",
            "Доступные наблюдения UTC: "
            f"{report['coverage']['earliest_available_event_utc'] or 'нет'} — "
            f"{report['coverage']['latest_available_event_utc'] or 'нет'}.",
            "",
            "Журнал содержит диагностические события, а не все прослушивания. Его отсутствие не доказывает "
            "исправность; доля успешных воспроизведений не рассчитывается. Итог определяется внутри периода, "
            "подготовка восстановления не считается звуком. API радио и физические телефоны здесь не проверяются.",
            "",
        ]
    )
    return "\n".join(rows)


def main(argv: list[str] | None = None) -> int:
    """Emit JSON/Markdown to stdout; exit 1 for partial data, 2 for unusable input."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journal-dir", type=Path, required=True)
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--until-ms", type=int, default=int(time.time() * 1000))
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    args = parser.parse_args(argv)
    try:
        report = generate_report(args.journal_dir, until_ms=args.until_ms, hours=args.hours)
    except (OSError, ValueError):
        sys.stderr.write("Diagnostic journal or window unavailable; no report produced.\n")
        return 2
    sys.stdout.write(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.format == "json"
        else render_markdown(report)
    )
    return 1 if report["quality"]["status"] == "partial" else 0


if __name__ == "__main__":
    raise SystemExit(main())
