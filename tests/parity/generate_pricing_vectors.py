#!/usr/bin/env python3
"""Generate pricing-parity vectors from the pinned upstream TokenEconomizer.

Portions derived from microsoft/TokenEconomizer (Apache-2.0), commit
7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0: the expected values are computed by the upstream
`tokeneconomizer/pricing.py` itself, not re-implemented here.

The plugin must price tokens exactly like `tokeneconomizer/pricing.py` for every model the
upstream table knows, including the 1-hour cache split and the Claude cache-hit overrides.
This script imports the pinned checkout, evaluates the upstream formulas, and writes
`pricing_vectors.json` next to this file. `pricing_parity.test.mjs` consumes it.

Usage:
    python3 tests/parity/generate_pricing_vectors.py

The upstream checkout is expected at `./.upstream/TokenEconomizer` (pinned commit
7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0). The script is stdlib-only and never mutates the
upstream tree.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = REPO_ROOT / ".upstream" / "TokenEconomizer"
EXPECTED_COMMIT = "7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0"
OUTPUT = Path(__file__).resolve().parent / "pricing_vectors.json"

if not (UPSTREAM / "tokeneconomizer" / "pricing.py").is_file():
    sys.exit(f"upstream checkout not found at {UPSTREAM}; nothing generated")

sys.path.insert(0, str(UPSTREAM))
from tokeneconomizer import pricing  # noqa: E402

# Extra ids that are NOT in MODEL_WEIGHTS but must resolve through the Claude curve, plus a
# router route (upstream strips the provider prefix).
EXTRA_MODELS = [
    "claude-opus-4.8",
    "claude-sonnet-5.5",
    "claude-fable-5-1",
    "openrouter/anthropic/claude-haiku-4.5",
]

BASE = {
    "input_tokens": 1200,
    "cache_read_input_tokens": 48000,
    "cache_creation_input_tokens": 3000,
    "output_tokens": 900,
}

USAGES = {
    "base": dict(BASE),
    "cache_1h_flat": dict(BASE, cache_creation_1h_input_tokens=1200),
    "cache_1h_nested": dict(BASE, cache_creation={"ephemeral_1h_input_tokens": 1200}),
    "cache_1h_clamped": dict(BASE, cache_creation_1h_input_tokens=999999),
    "zero": {
        "input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "output_tokens": 0,
    },
    "no_breakdown": {"tokens_total": 12345},
}

# `len(text) // 4` with a floor of 1, on CODE POINTS (Python str length).
APPROX_TEXTS = [
    "",
    "a",
    "abcd",
    "abcde",
    "a" * 8,
    "a" * 400,
    "日本語のテキストです",
    "😀😀😀😀😀",
    "mixed 日本語 😀 text",
]


def normalize_weights(weights: dict) -> dict:
    out = {
        "input": weights["input"],
        "cacheRead": weights["cache_read"],
        "cacheWrite": weights["cache_write"],
        "output": weights["output"],
    }
    if "cache_write_1h" in weights:
        out["cacheWrite1h"] = weights["cache_write_1h"]
    return out


def upstream_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"], text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def main() -> None:
    models = sorted(pricing.MODEL_WEIGHTS) + EXTRA_MODELS
    vectors = []
    for model in models:
        for usage_name, usage in USAGES.items():
            record = dict(usage, model=model)
            vectors.append(
                {
                    "id": f"{model}::{usage_name}",
                    "model": model,
                    "usage": usage,
                    "expected": {
                        "effectiveTokens": pricing.effective_tokens(record),
                        "hasBreakdown": pricing.has_breakdown(record),
                        "weights": normalize_weights(pricing.weights_for(record)),
                    },
                }
            )

    approx = [{"text": text, "expected": pricing.approx_tokens(text)} for text in APPROX_TEXTS]

    # Upstream hard-fails unknown models; this port reports them as unknown instead. Record
    # the deviation explicitly so the parity test can assert the intentional difference.
    unknown = {"model": "deepseek-v4.1-flash", "usage": dict(BASE)}
    upstream_raises = False
    try:
        pricing.effective_tokens(unknown)
    except ValueError:
        upstream_raises = True

    payload = {
        "generatedBy": "tests/parity/generate_pricing_vectors.py",
        "upstream": "microsoft/TokenEconomizer",
        "upstreamCommit": upstream_commit(),
        "expectedCommit": EXPECTED_COMMIT,
        "python": sys.version.split()[0],
        "vectorCount": len(vectors),
        "models": models,
        "vectors": vectors,
        "approxVectors": approx,
        "deviations": {
            "unknownModel": {
                "model": unknown["model"],
                "upstreamRaises": upstream_raises,
                "portEffectiveTokens": None,
            }
        },
    }
    OUTPUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT} ({len(vectors)} vectors, {len(approx)} approx, {len(models)} models)")


if __name__ == "__main__":
    main()
