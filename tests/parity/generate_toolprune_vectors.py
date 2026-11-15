#!/usr/bin/env python3
"""Generate tool-pruning parity vectors from the PINNED upstream TokenEconomizer.

The TypeScript port's ``enoughEvidence`` must reproduce upstream
``tokeneconomizer/plugin/fold.py::enough_evidence``. This script imports the vendored
upstream package (commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0) and records what it
actually returns for a grid of session/prompt counts and evidence settings.

Usage:
    python3 tests/parity/generate_toolprune_vectors.py

Writes ``tests/parity/toolprune_vectors.json``; ``toolprune_parity.test.mjs`` compares the
TypeScript port against it. The JSON is committed, so the Node suite never needs Python;
only regenerating the vectors does.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / ".upstream" / "TokenEconomizer"
OUT = Path(__file__).resolve().parent / "toolprune_vectors.json"
PINNED_COMMIT = "7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0"

if not UPSTREAM.is_dir():
    raise SystemExit(f"upstream checkout missing: {UPSTREAM}")

sys.path.insert(0, str(UPSTREAM))

from tokeneconomizer.plugin.fold import enough_evidence  # noqa: E402

SETTINGS = (
    {"name": "defaults", "toolprune_min_sessions": 2, "toolprune_evidence": 10, "toolprune_sessions": 5},
    {"name": "immediate", "toolprune_min_sessions": 0, "toolprune_evidence": 0, "toolprune_sessions": 1},
    {"name": "one-session", "toolprune_min_sessions": 1, "toolprune_evidence": 1, "toolprune_sessions": 1},
    {"name": "wide", "toolprune_min_sessions": 5, "toolprune_evidence": 3, "toolprune_sessions": 10},
    {"name": "shortcut-only", "toolprune_min_sessions": 100, "toolprune_evidence": 100, "toolprune_sessions": 5},
)


def main() -> None:
    vectors = []
    for settings in SETTINGS:
        cfg = SimpleNamespace(**settings)
        for sessions in range(0, 13):
            for prompts in range(0, 17):
                vectors.append(
                    {
                        "id": f"{settings['name']}:s{sessions}:p{prompts}",
                        "sessions": sessions,
                        "prompts": prompts,
                        "settings": {
                            "toolpruneMinSessions": settings["toolprune_min_sessions"],
                            "toolpruneEvidence": settings["toolprune_evidence"],
                            "toolpruneSessions": settings["toolprune_sessions"],
                        },
                        "expected": bool(enough_evidence(sessions, prompts, cfg)),
                    }
                )
    payload = {
        "generatedBy": "tests/parity/generate_toolprune_vectors.py",
        "upstreamCommit": PINNED_COMMIT,
        "expectedCommit": PINNED_COMMIT,
        "source": "tokeneconomizer/plugin/fold.py::enough_evidence",
        "vectorCount": len(vectors),
        "vectors": vectors,
    }
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(vectors)} vectors)")


if __name__ == "__main__":
    main()
