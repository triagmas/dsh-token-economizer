#!/usr/bin/env python3
"""Generate loop-guard parity vectors from the PINNED upstream TokenEconomizer.

The TypeScript port in ``src/loopguard`` must reproduce the upstream decisions, thresholds,
regex verdicts and serialized state. Rather than hand-writing expectations, this script imports
the pinned upstream package (``.upstream/TokenEconomizer``, commit
7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0) and dumps what it actually does.

Usage:
    python3 tests/parity/generate_loopguard_vectors.py

Writes ``tests/parity/loopguard_vectors.json``; ``loopguard_parity.test.mjs`` compares the
TypeScript port against it. The file is generated output: do not edit it by hand.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / ".upstream" / "TokenEconomizer"
OUT = Path(__file__).resolve().parent / "loopguard_vectors.json"
PINNED_COMMIT = "7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0"

if not UPSTREAM.is_dir():
    raise SystemExit(f"upstream checkout missing: {UPSTREAM}")

sys.path.insert(0, str(UPSTREAM))

from tokeneconomizer.loopguard import rules, state, turn  # noqa: E402

FAIL = (
    "FAILED tests/test_app.py::test_add - AssertionError: 1 != 2\n"
    "1 failed in 0.05s"
)
PASS = "2 passed in 0.03s"


class FakeState:
    """The attribute surface rules.py reads, without a real trajectory."""

    def __init__(
        self,
        turns=0,
        edit_churn=0,
        distinct_edit_files=0,
        error_outputs=0,
        test_runs=0,
        repeated_fail_sigs=0,
        stagnation=0.0,
        edit_counts=None,
    ):
        self.turns = turns
        self.edit_churn = edit_churn
        self.distinct_edit_files = distinct_edit_files
        self.error_outputs = error_outputs
        self.test_runs = test_runs
        self.repeated_fail_sigs = repeated_fail_sigs
        self.stagnation = stagnation
        self.edit_counts = edit_counts or {}

    def recent_digest(self, n=24, envelope=None):
        return "DIGEST"


def state_vector(**kwargs):
    return kwargs


def judge_high(_digest):
    return {"stuck": True, "confidence": 0.72, "reason": "same failure repeating"}


def judge_low(_digest):
    return {"stuck": True, "confidence": 0.69, "reason": "maybe"}


def judge_productive(_digest):
    return {"stuck": False, "confidence": 0.9, "reason": "narrowing the failure"}


def judge_raises(_digest):
    raise RuntimeError("runner down")


JUDGES = {
    "high": judge_high,
    "low": judge_low,
    "productive": judge_productive,
    "raises": judge_raises,
}


def build_thresholds():
    levels = {name: dict(vals) for name, vals in rules.SPIRAL_LEVELS.items()}
    scaled = {
        name: rules.scaled_thresholds(name)
        for name in ("conservative", "default", "aggressive", "unknown-level")
    }
    return {
        "default": dict(rules.DEFAULT_THRESHOLDS),
        "levels": levels,
        "scaled": scaled,
    }


def build_gate():
    cases = []
    for turns, repeated, errors in (
        (5, 3, 20),
        (17, 3, 20),
        (18, 0, 7),
        (18, 0, 8),
        (18, 1, 0),
        (30, 0, 0),
    ):
        st = FakeState(turns=turns, repeated_fail_sigs=repeated, error_outputs=errors)
        cases.append(
            {
                "state": state_vector(
                    turns=turns, repeated_fail_sigs=repeated, error_outputs=errors
                ),
                "expected": bool(rules.gate_for_judge(st)),
            }
        )
    return cases


def build_is_stuck():
    definitions = [
        # Productive but hard: lots of errors, but the failures keep changing.
        dict(turns=25, edit_churn=3, distinct_edit_files=2, error_outputs=12,
             repeated_fail_sigs=0, stagnation=0.0),
        # The canonical spiral: churn + noise + repetition.
        dict(turns=25, edit_churn=4, distinct_edit_files=3, error_outputs=10,
             repeated_fail_sigs=9, stagnation=0.9),
        # Too short.
        dict(turns=19, edit_churn=9, distinct_edit_files=9, error_outputs=9,
             repeated_fail_sigs=9, stagnation=1.0),
        # Scattered edits count as churn, but no repetition.
        dict(turns=30, edit_churn=1, distinct_edit_files=5, error_outputs=10,
             repeated_fail_sigs=0, stagnation=0.0),
        # Repetition without noise.
        dict(turns=30, edit_churn=5, distinct_edit_files=1, error_outputs=5,
             repeated_fail_sigs=5, stagnation=1.0),
    ]
    return [
        {"state": state_vector(**d), "expected": bool(rules.is_stuck(FakeState(**d)))}
        for d in definitions
    ]


def build_assess_abort():
    cases = []

    stuck = dict(turns=40, edit_churn=10, distinct_edit_files=4, error_outputs=12,
                 repeated_fail_sigs=10, stagnation=0.9)
    productive = dict(turns=40, edit_churn=6, distinct_edit_files=4, error_outputs=12,
                      repeated_fail_sigs=0, stagnation=0.0)
    short = dict(turns=5, edit_churn=1, distinct_edit_files=1, error_outputs=2,
                 repeated_fail_sigs=0, stagnation=0.0)

    def add(label, st_kwargs, envelope, judge_name=None, thr=None):
        st = FakeState(**st_kwargs)
        judge = JUDGES[judge_name] if judge_name else None
        abort, reason = rules.assess_abort(
            st, envelope=envelope, judge=judge, thr=thr
        )
        cases.append(
            {
                "label": label,
                "state": state_vector(**st_kwargs),
                "envelope": envelope,
                "judge": judge_name,
                "thresholds": "default" if thr is None else thr,
                "expected": {"abort": bool(abort), "reason": reason},
            }
        )

    # Hard backstop, before the judge (envelope 5 -> 12.5 turns).
    add("backstop", stuck, 5)
    # Judge cascade.
    add("judge-stuck", productive, 20, "high")
    add("judge-below-confidence", productive, 20, "low")
    add("judge-productive", productive, 20, "productive")
    add("judge-error", productive, 20, "raises")
    # Gate closed with a wired judge.
    add("gate-closed", short, 20, "high")
    # No judge: strict heuristic fallback.
    add("fallback-envelope", stuck, 3)
    add("fallback-within-envelope", stuck, 100)
    add("fallback-not-stuck", productive, 3)
    return cases


def build_nudge():
    st = FakeState(
        turns=30,
        edit_churn=7,
        distinct_edit_files=3,
        error_outputs=8,
        test_runs=6,
        repeated_fail_sigs=5,
        stagnation=0.8,
        edit_counts={"app/core.py": 7, "app/util.py": 2, "tests/test_app.py": 1},
    )
    return {
        "state": state_vector(
            turns=30,
            edit_churn=7,
            distinct_edit_files=3,
            error_outputs=8,
            test_runs=6,
            repeated_fail_sigs=5,
            stagnation=0.8,
            edit_counts=st.edit_counts,
        ),
        "expected": rules.nudge_text(st),
    }


def build_regex_vectors():
    commands = [
        "pytest -q",
        "python -m pytest tests -q",
        "npx vitest run",
        "npm test",
        "npm run test",
        "go test ./...",
        "cargo test",
        "cargo nextest run",
        "./gradlew test",
        "make check",
        "ctest --output-on-failure",
        "rspec spec/models/user_spec.rb",
        "ruby -Itest test/models/user_test.rb",
        "ruby -e 'puts 1'",
        "Ruby -Itest test/models/user_test.rb",
        "deno test --allow-read",
        "node --test tests/",
        "cd web; npx vitest run",
        "pytest -q; git diff",
        "pytest -q && echo ok",
        "pytest -q || true",
        "npm test 2>&1 | tail -n 8",
        "pytest -q | tail -5",
        "grep -rn Error src | head",
        "echo hi | grep hi",
        "cd web",
        "./node_modules/.bin/jest",
        "python repro.py 2>&1 | tail -20",
        "set -o pipefail; pytest -q | tail -5",
        "timeout 120 uv run pytest -x",
        "npx jest --co",
        "bash -lc 'pytest -q'",
        "bash -lc 'python - <<PY\nprint(1)\nPY\nnpm test'",
        "python - <<'PY'\nprint(1)\nPY\nnpm test",
    ]
    return {
        "status_of_tests": [
            {"cmd": cmd, "expected": turn.status_of_tests(cmd)} for cmd in commands
        ],
        "exit_status_covers": [
            {"cmd": cmd, "expected": bool(turn.exit_status_covers(cmd))} for cmd in commands
        ],
    }


def build_runner_verdict():
    texts = [
        FAIL,
        PASS,
        "1 failed, 2 passed in 0.12s",
        "3 passed in 0.10s",
        "# fail 2",
        "# fail 0",
        "Tests: 5 passed, 5 total",
        "2 passing (20ms)",
        "ok  github.com/x/y  0.02s",
        "test result: FAILED. 1 passed; 2 failed",
        "test result: ok. 3 passed; 0 failed",
        "2 examples, 1 failure",
        "2 examples, 0 failures",
        "Tests run: 3, Failures: 1",
        "Tests run: 3, Failures: 0, Errors: 0",
        "BUILD FAILURE",
        "BUILD SUCCESS",
        "FAIL\tgithub.com/x/y\t0.02s",
        "--- FAIL: TestAdd (0.00s)",
        "Failures: 1",
        "no summary here",
    ]
    return [{"text": t, "expected": turn.runner_verdict(t)} for t in texts]


def build_state():
    updates = [
        ("edit", {"path": "app/core.py"}, "", False),
        ("bash", {"command": "pytest -q"}, FAIL, True),
        ("edit", {"path": "app/core.py"}, "", False),
        ("bash", {"command": "npx vitest run"}, FAIL, True),
        ("view", {"path": "app/core.py"}, "AssertionError in file body", False),
        ("view", {"path": "app/core.py"}, "AssertionError in file body", True),
        ("bash", {"command": "pytest -q"}, PASS, False),
        ("grep", {"pattern": "def add"}, "app/core.py:1", False),
        ("bash", {"command": "pytest -q"}, FAIL, True),
        ("edit", {"path": "tests/test_app.py"}, "", False),
    ]
    st = state.SpiralState()
    for name, args, result, failed in updates:
        st.update(name, args, result, failed)
    return {
        "updates": [
            {"name": n, "args": a, "result": r, "failed": f}
            for n, a, r, f in updates
        ],
        "snapshot": st.snapshot(),
        "dict": turn.state_to_dict(st),
        "digest_envelope_12": st.recent_digest(n=24, envelope=12.0),
        "digest_no_envelope": st.recent_digest(n=24),
        "failure_signatures": [
            {"text": FAIL, "expected": state._failure_sig(FAIL)},
            {
                "text": "FAILED tests/other.py::test_x - AssertionError: 0x9f != 3",
                "expected": state._failure_sig(
                    "FAILED tests/other.py::test_x - AssertionError: 0x9f != 3"
                ),
            },
            {"text": PASS, "expected": state._failure_sig(PASS)},
            {"text": "", "expected": state._failure_sig("")},
        ],
        "canon": [
            {"name": n, "expected": state.canon_tool(n)}
            for n in ("bash", "shell", "Read", "view", "apply_patch", "write", "multiedit", "x")
        ],
        "basename": {
            "C:\\repo\\pkg\\mod.py": state.basename("C:\\repo\\pkg\\mod.py"),
            "pkg/mod.py": state.basename("pkg/mod.py"),
            "trailing/": state.basename("trailing/"),
            "": state.basename(""),
        },
    }


def build_transitions():
    calls = []
    for _ in range(24):
        calls.append(("edit", {"path": "app/core.py"}, "", 0))
        calls.append(("bash", {"command": "pytest -q"}, FAIL, 1))
    # A green run must not stop the ongoing spiral: the turn is already stuck.
    calls.append(("edit", {"path": "app/core.py"}, "", 0))
    calls.append(("bash", {"command": "pytest -q"}, PASS, 0))
    for _ in range(10):
        calls.append(("edit", {"path": "app/core.py"}, "", 0))
        calls.append(("bash", {"command": "pytest -q"}, FAIL, 1))

    guard = turn.TurnGuard(turn_key="parity:1")
    thr = rules.scaled_thresholds("default")
    steps = []
    for name, args, result, code in calls:
        decision = guard.fold(
            name,
            args,
            result,
            code,
            envelope=5,
            thr=thr,
            judge=None,
            nudge_budget=1,
        )
        nudge = None
        if decision is not None and decision[0] == "nudge":
            nudge = guard.nudge_body(envelope=5)
            guard.after_nudge()
        steps.append(
            {
                "decision": list(decision) if decision is not None else None,
                "nudge": nudge,
                # to_dict() returns references into live guard state; snapshot it.
                "dict": copy.deepcopy(guard.to_dict()),
            }
        )
    return {
        "turn_key": "parity:1",
        "envelope": 5,
        "thresholds": "default",
        "calls": [
            {"name": n, "args": a, "result": r, "exit_code": c}
            for n, a, r, c in calls
        ],
        "steps": steps,
        "summary": guard.summary(),
    }


def main():
    vectors = {
        "upstream_commit": PINNED_COMMIT,
        "thresholds": build_thresholds(),
        "gate_for_judge": build_gate(),
        "is_stuck": build_is_stuck(),
        "assess_abort": build_assess_abort(),
        "nudge_text": build_nudge(),
        "runner_verdict": build_runner_verdict(),
        "status_of_tests": build_regex_vectors()["status_of_tests"],
        "exit_status_covers": build_regex_vectors()["exit_status_covers"],
        "state": build_state(),
        "transitions": build_transitions(),
    }
    OUT.write_text(json.dumps(vectors, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    print(
        "vectors:"
        f" thresholds={len(vectors['thresholds']['scaled'])}"
        f" gate={len(vectors['gate_for_judge'])}"
        f" stuck={len(vectors['is_stuck'])}"
        f" abort={len(vectors['assess_abort'])}"
        f" transitions={len(vectors['transitions']['calls'])}"
        f" runner={len(vectors['runner_verdict'])}"
        f" status={len(vectors['status_of_tests'])}"
    )


if __name__ == "__main__":
    main()
