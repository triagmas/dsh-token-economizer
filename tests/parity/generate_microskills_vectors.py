#!/usr/bin/env python3
"""Generate parity vectors for the micro-skills port.

The vectors are produced by the PINNED upstream implementation (microsoft/TokenEconomizer,
commit 7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0) checked out under `.upstream/TokenEconomizer`.
`tests/parity/microskills_parity.test.mjs` replays them against the TypeScript port; it skips
cleanly when the generated JSON is absent (upstream not vendored).

Usage:
    python3 tests/parity/generate_microskills_vectors.py

Exit status is non-zero if the pinned upstream cannot be imported, so CI notices a missing
checkout instead of silently writing an empty file.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPSTREAM = os.path.join(ROOT, ".upstream", "TokenEconomizer")
OUT = os.path.join(ROOT, "tests", "parity", "microskills_vectors.json")

if not os.path.isdir(os.path.join(UPSTREAM, "tokeneconomizer")):
    sys.stderr.write(
        "pinned upstream checkout missing: %s\n"
        "(parity vectors are derived from it; see tests/parity/README)\n" % UPSTREAM
    )
    raise SystemExit(2)

sys.path.insert(0, UPSTREAM)

from tokeneconomizer.microskills import distiller as D  # noqa: E402
from tokeneconomizer.microskills import envfacts as E  # noqa: E402
from tokeneconomizer.microskills import lifecycle as L  # noqa: E402
from tokeneconomizer.microskills import observe as O  # noqa: E402

OBS_FIELDS = (
    "call", "intent", "form", "head", "prefix", "segment", "hosts", "probe", "outcome",
    "labels", "label_err", "loaded", "tests_ran", "env", "not_found",
)


def obs_dict(o):
    out = {}
    for name in OBS_FIELDS:
        value = getattr(o, name)
        if isinstance(value, tuple):
            value = list(value)
        out[name] = value
    return out


def digest_dict(dg):
    out = dict(dg)
    out["obs"] = [obs_dict(o) for o in dg["obs"]]
    out["env"] = [dict(e) for e in dg["env"]]
    return out


def lifecycle_dict(life):
    return dict(life.to_dict())


def fact_dict(f):
    return {
        "id": f.id,
        "family": f.family,
        "high": bool(f.life.high),
        "drift": bool(f.life.drift),
        "params": f.params,
        "life": lifecycle_dict(f.life),
        "state": f.state,
        "claim": f.claim(),
    }


class Workspace:
    """A real directory the pinned upstream can walk (`repository_top` needs it on disk)."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="dsh-microskills-parity-")
        os.makedirs(os.path.join(self.dir, "src"), exist_ok=True)
        self.count = 0

    def transcript(self, calls):
        self.count += 1
        path = os.path.join(self.dir, "t%02d.jsonl" % self.count)
        lines = []
        with open(path, "w", encoding="utf-8") as fh:
            for i, call in enumerate(calls):
                tid = "t%d_%d" % (self.count, i)
                cwd = call.get("cwd", self.dir)
                args = call.get("args", {})
                lines.append(json.dumps({
                    "type": "assistant", "cwd": cwd,
                    "message": {"content": [{"type": "tool_use", "id": tid,
                                             "name": call["name"], "input": args}]},
                }))
                if "output" in call:
                    lines.append(json.dumps({
                        "type": "assistant", "cwd": cwd,
                        "message": {"content": [{"type": "tool_result", "tool_use_id": tid,
                                                 "content": call["output"],
                                                 "is_error": bool(call.get("is_error", False))}]},
                    }))
            fh.write("\n".join(lines) + "\n")
        return path


def call_list(calls):
    """The same calls in the JSON shape the TypeScript port consumes."""
    return [
        {
            "name": c["name"],
            "args": c.get("args", {}),
            "output": c.get("output", ""),
            "isError": bool(c.get("is_error", False)),
            "cwd": c.get("cwd", ""),
        }
        for c in calls
    ]


def task_calls(cwd, specs):
    return [dict(spec, cwd=cwd) for spec in specs]


def generate():
    ws = Workspace()
    vectors = {"meta": {
        "upstream": "microsoft/TokenEconomizer",
        "commit": "7042ea89dd5e5ecbc67ad865ad6e256e61be8bf0",
        "license": "Apache-2.0",
        "root": ws.dir,
    }}

    # ---- unwrap / segments -------------------------------------------------------------
    unwrap_inputs = [
        "pytest -q",
        '/bin/bash -lc "python -m pytest -q"',
        "/bin/bash -lc 'cd tests && python runtests.py'",
        'bash -lc "echo \\"hi\\""',
        "  cd /repo && make test  ",
        "sh -c 'npm run build'",
        "",
    ]
    vectors["unwrap"] = [{"in": text, "out": O.unwrap(text)} for text in unwrap_inputs]

    seg_inputs = [
        "cd /repo && python -m pytest -q tests | tail -5",
        "a && b || c; d | e",
        "echo 'a && b' && real",
        'python -c "print(1)" 2>&1 | tail',
        "cat <<'EOF'\nrm -rf /tmp/x\nEOF\nls",
        "FOO=1 BAR=2 make test",
        "",
    ]
    vectors["segments"] = [{"in": text, "out": list(O.segments(text))} for text in seg_inputs]

    # ---- scalar helpers ----------------------------------------------------------------
    outputs = [
        "bash: pytest: command not found",
        "python: can't open file 'x.py': [Errno 2] No such file or directory",
        "ModuleNotFoundError: No module named 'yaml'",
        "Command 'foo' not found, did you mean:",
        "Usage: django-admin [options]",
        "error: unrecognized arguments: -k foo",
        "Could not resolve host: example.test",
        "Connection refused",
        "All tests passed",
        "Exit code: 2",
        "",
    ]
    vectors["error_class"] = [{"in": text, "out": O.error_class(text)} for text in outputs]
    vectors["exit_hint"] = [{"in": text, "out": O._exit_code_hint(text)} for text in outputs]

    rules = [
        ("tests.app.Test.test_x", "tests/app/Test/test_x"),
        ("tests.app.Test.test_x", "tests/app.py::Test::test_x"),
        ("app.tests.test_x", "app.tests.test_x"),
        ("tests/test_x.py::test_y", "tests/test_x.py"),
        ("a.b", "a/b"),
        ("plain", "plain"),
        ("tests.app::Test::x", "tests.app.Test.x"),
    ]
    vectors["label_rule"] = [
        {"a": a, "b": b, "out": list(rule) if rule else None}
        for a, b in rules
        for rule in [O.label_rule(a, b)]
    ]

    # ---- classify ---------------------------------------------------------------------
    classify_cases = [
        ("pytest -q tests", "generic", 0, "", None, None),
        ("cd /repo && python -m pytest -q tests", "generic", 3, "", ws.dir, None),
        ("FOO=1 python3 bin/test.py", "python", 1, "", None, None),
        ("npm run lint", "generic", 0, "", None, None),
        ("pip install -e .", "generic", 0, "", None, None),
        ("rtk proxy python -m pytest", "generic", 0, "", None, None),
        ("conda activate env && python runtests.py", "python", 0, "", None, None),
        ("cd src && pytest -q", "generic", 2, "", ws.dir, ws.dir),
        ("curl -sSf https://example.test/api | head", "generic", 0, "", None, None),
        ("git ls-remote origin", "generic", 0, "", None, None),
        ("python -c \"print(1)\" 2>&1 | tail -5", "generic", 0, "", None, None),
        ("docker build -t app .", "generic", 0, "", None, None),
    ]
    vectors["classify"] = []
    for cmd, vocab_name, call_index, cwd, root, top in classify_cases:
        vocab = O.GENERIC if vocab_name == "generic" else O.PYTHON_GIT
        obs = O.classify_command(cmd, call_index, vocab, cwd=cwd or "", root=root, top=top)
        vectors["classify"].append({
            "cmd": cmd, "vocab": vocab_name, "call_index": call_index, "cwd": cwd or "",
            "root": root, "top": top, "obs": [obs_dict(o) for o in obs],
        })

    # ---- observe_task digests ---------------------------------------------------------
    generic_calls = task_calls(ws.dir, [
        {"name": "Bash", "args": {"command": "npm run lint"}, "output": "ok"},
        {"name": "Bash", "args": {"command": "cd src && npm test"},
         "output": "3 passing"},
        {"name": "Edit", "args": {"file_path": os.path.join(ws.dir, "src", "a.ts")}},
        {"name": "Bash", "args": {"command": "python3 -c 'import yaml'"},
         "output": "ModuleNotFoundError: No module named 'yaml'", "is_error": True},
        {"name": "Bash", "args": {"command": "git status --short"}, "output": ""},
    ])
    python_calls = task_calls(ws.dir, [
        {"name": "Bash", "args": {"command": "python runtests.py"},
         "output": "Traceback (most recent call last):\nModuleNotFoundError: No module named 'app'",
         "is_error": True},
        {"name": "Bash", "args": {"command": "cd src && python runtests.py"},
         "output": "Ran 3 tests in 0.01s\nOK"},
        {"name": "Edit", "args": {"file_path": os.path.join(ws.dir, "app.py")}},
        {"name": "Bash", "args": {"command": "pytest tests/app.py::Test::test_x"},
         "output": "ERROR: not found: tests/app.py::Test::test_x", "is_error": True},
        {"name": "Bash", "args": {"command": "pytest tests/app.py -q"},
         "output": "3 passed"},
    ])
    env_value_calls = task_calls(ws.dir, [
        {"name": "Bash", "args": {"command": "python -c 'import app'"},
         "output": "RuntimeError: environment variable 'APP_MODE' is not set",
         "is_error": True},
        {"name": "Bash", "args": {"command": "export APP_MODE=prod && python -c 'import app'"},
         "output": "app imported"},
        {"name": "Bash", "args": {"command": "export APP_MODE=dev && python -c 'import app'"},
         "output": "RuntimeError: environment variable 'APP_MODE' is not set",
         "is_error": True},
    ])
    boundary_calls = task_calls(ws.dir, [
        {"name": "Bash", "args": {"command": "curl -sSf https://example.test/api"},
         "output": "curl: (6) Could not resolve host: example.test", "is_error": True},
        {"name": "Bash", "args": {"command": "curl -sSf https://elsewhere.test/api"},
         "output": '{"ok": true}'},
    ])
    probe_calls = task_calls(ws.dir, [
        {"name": "Bash", "args": {"command": "git ls-remote origin"}, "output": ""},
        {"name": "Bash", "args": {"command": "git for-each-ref --format='%(refname)'"},
         "output": ""},
    ])

    tasks = {
        "generic": generic_calls,
        "python": python_calls,
        "env_value": env_value_calls,
        "boundary": boundary_calls,
        "probe": probe_calls,
    }
    vectors["observe"] = []
    for name, calls in tasks.items():
        vocab = O.GENERIC if name in ("generic", "env_value", "boundary", "probe") else O.PYTHON_GIT
        path = ws.transcript(calls)
        dg = O.observe_task(path, vocab)
        vectors["observe"].append({
            "name": name,
            "calls": call_list(calls),
            "vocab": "generic" if vocab is O.GENERIC else "python",
            "root": ws.dir,
            "top": O.repository_top(ws.dir),
            "digest": digest_dict(dg),
        })

    # ---- lifecycle --------------------------------------------------------------------
    scenarios = [
        ("promote", False, True, [
            (0, "confirm", False, True, ["a.py"]),
            (1, "confirm", False, True, ["a.py"]),
            (2, "confirm", False, True, ["a.py"]),
        ], 5),
        ("drift", False, True, [
            (0, "confirm", False, True, ["a.py"]),
            (1, "confirm", False, True, ["a.py"]),
            (2, "confirm", False, True, ["b.py"]),
        ], 5),
        ("hard-kill", True, True, [
            (0, "confirm", False, True, ["a.py"]),
            (1, "confirm", False, True, ["a.py"]),
            (2, "confirm", False, True, ["a.py"]),
            (3, "contradict", False, True, ["a.py"]),
        ], 5),
        ("soft-retire", False, True, [
            (0, "confirm", True, True, ["a.py"]),
            (1, "confirm", True, True, ["a.py"]),
            (2, "confirm", True, True, ["a.py"]),
            (3, "contradict", False, True, ["a.py"]),
            (4, "contradict", False, True, ["a.py"]),
        ], 6),
        ("fire-gate", False, False, [
            (0, "confirm", False, True, ["a.py"]),
            (1, "confirm", True, True, []),
            (2, "confirm", True, True, []),
            (3, "confirm", True, True, []),
        ], 5),
        ("candidate-kill", True, False, [
            (0, "contradict", False, True, []),
        ], 2),
    ]
    vectors["lifecycle"] = []
    for name, high, drift, steps, now in scenarios:
        life = L.Lifecycle(name, high, drift)
        applied = []
        for (step_now, verdict, fired, exercised, files) in steps:
            life.update(step_now, verdict, fired, exercised, files)
            applied.append(verdict)
        vectors["lifecycle"].append({
            "name": name, "high": high, "drift": drift,
            "steps": [
                {"now": s[0], "verdict": s[1], "fired": s[2], "exercised": s[3], "files": s[4]}
                for s in steps
            ],
            "now": now,
            "final": lifecycle_dict(life),
            "injectable": life.injectable(),
            "score": round(life.score(now), 12),
            "applied": applied,
        })

    # Two confirmations from the same finished session. Upstream has no session id and
    # counts both; the plugin's ADAPTER layer, not this lifecycle, suppresses the repeat.
    life = L.Lifecycle("same-session-two-confirms", False, False)
    same_session_steps = [
        (0, "confirm", False, True, []),
        (0, "confirm", False, True, []),
    ]
    for (step_now, verdict, fired, exercised, files) in same_session_steps:
        life.update(step_now, verdict, fired, exercised, files)
    vectors["lifecycle"].append({
        "name": "same-session-two-confirms",
        "high": False,
        "drift": False,
        "sessionId": "shared-session",
        "steps": [
            {"now": s[0], "verdict": s[1], "fired": s[2], "exercised": s[3],
             "files": s[4], "sessionId": "shared-session"}
            for s in same_session_steps
        ],
        "now": 0,
        "final": lifecycle_dict(life),
        "injectable": life.injectable(),
        "score": round(life.score(0), 12),
        "applied": [s[1] for s in same_session_steps],
    })

    # ---- env facts: direct claim/render ------------------------------------------------
    claim_specs = [
        {
            "id": "form_repair:run_tests:python runtests.py",
            "family": "form_repair",
            "high": False,
            "params": {"intent": "run_tests", "a": "python runtests.py",
                       "b_counts": {"cd tests && python runtests.py": 3},
                       "error_counts": {"module_missing": 2}},
            "steps": [
                {"now": 0, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 1, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 2, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 3, "verdict": "confirm", "fired": True, "exercised": True},
            ],
        },
        {
            "id": "absent_tool:docker",
            "family": "absent_tool",
            "high": True,
            "params": {"tool": "docker", "intent": "run_build"},
            "steps": [
                {"now": 0, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 1, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 2, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 3, "verdict": "confirm", "fired": True, "exercised": True},
            ],
        },
        {
            "id": "arg_repair:pytest:sep:::",
            "family": "arg_repair",
            "high": False,
            "params": {"form": "pytest", "kind": "sep", "param": "::",
                       "examples": {"tests/app.py::Test::test_x tests/app.py::Test.test_x": 2}},
            "steps": [
                {"now": 0, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 1, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 2, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 3, "verdict": "confirm", "fired": True, "exercised": True},
            ],
        },
        {
            "id": "env_value:APP_MODE",
            "family": "env_value",
            "high": False,
            "params": {"var": "APP_MODE", "good": {"prod": 2}, "bad": {"dev": 1}},
            "steps": [
                {"now": 0, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 1, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 2, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 3, "verdict": "confirm", "fired": True, "exercised": True},
            ],
        },
        {
            "id": "boundary:fetch_remote",
            "family": "boundary",
            "high": True,
            "params": {"hosts": {"example.test": 3, "other.test": 1}},
            "steps": [
                {"now": 0, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 1, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 2, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 3, "verdict": "confirm", "fired": True, "exercised": True},
            ],
        },
        {
            "id": "empty_probe:vcs_refs",
            "family": "empty_probe",
            "high": True,
            "params": {"kinds": {"ls_remote": 4}},
            "steps": [
                {"now": 0, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 1, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 2, "verdict": "confirm", "fired": True, "exercised": True},
                {"now": 3, "verdict": "confirm", "fired": True, "exercised": True},
            ],
        },
    ]
    vectors["env_claims"] = []
    for spec in claim_specs:
        fact = E.EnvFact(spec["id"], spec["family"], spec["high"], json.loads(json.dumps(spec["params"])))
        for step in spec["steps"]:
            E.fold(fact, step["now"], step["verdict"], step["fired"],
                   step["exercised"], step.get("files") or [])
        d = E.EnvFactsDistiller("repo", vocab=O.GENERIC)
        d.facts[fact.id] = fact
        render = d.render()
        vectors["env_claims"].append({
            "spec": spec,
            "params": fact.params,
            "claim": fact.claim(),
            "state": fact.state,
            "injectable": fact.injectable(),
            "life": lifecycle_dict(fact.life),
            "render": render,
            "injected": sorted(d.last_injected),
        })

    # ---- env facts: update sequences --------------------------------------------------
    env_tasks = [
        ("python", python_calls),
        ("generic", generic_calls),
        ("env_value", env_value_calls),
        ("boundary", boundary_calls),
        ("probe", probe_calls),
    ]
    vectors["env_update"] = []
    for name, calls in env_tasks:
        vocab = O.GENERIC if name != "python" else O.PYTHON_GIT
        path = ws.transcript(calls)
        d = E.EnvFactsDistiller("repo", vocab=vocab)
        digest = O.observe_task(path, vocab)
        snapshots = []
        # A three-task sequence re-uses the same evidence, with injected ids turning on after
        # the first fold: that exercises both discovery and the "prevented the waste" branch.
        injected_sets = [[], sorted(d.facts), []]
        for task_index in range(3):
            d.last_injected = set(injected_sets[task_index] if task_index == 1 else [])
            d.update(path, iid="t%d" % task_index)
            # Deep-copied: the facts' counters keep mutating across tasks, and the vector
            # must record each snapshot as it stood at that point.
            facts = [json.loads(json.dumps(fact_dict(f))) for f in d.facts.values()]
            snapshots.append({
                "facts": facts,
                "render": d.render(),
                "last_digest": {
                    "verdicts": {fid: list(v) for fid, v in d.last_digest["verdicts"].items()}
                    if d.last_digest else {},
                },
            })
        vectors["env_update"].append({
            "name": name,
            "calls": call_list(calls),
            "vocab": "generic" if vocab is O.GENERIC else "python",
            "root": ws.dir,
            "top": O.repository_top(ws.dir),
            "digest": digest_dict(digest),
            "injected": injected_sets,
            "snapshots": snapshots,
        })

    # ---- distiller: digest, signatures, prompts --------------------------------------
    vectors["templates"] = [
        {"in": cmds, "out": D._templates(cmds)}
        for cmds in (
            ["pytest -q tests", "pytest   -q tests", "  ", "npm run build -- --silent"],
            ["python /testbed/setup.py build_ext --inplace"],
            [],
        )
    ]

    sig_outputs = [
        "Traceback (most recent call last):\n  File \"/repo/app.py\", line 3\nValueError: bad",
        "bash: line 1: pytest: command not found",
        "ModuleNotFoundError: No module named 'yaml' at 0x7ffd",
        "error: opening /repo/src/x.ts: permission denied",
        "all good",
    ]
    vectors["error_signature"] = [
        {"out": text, "roots": ["/repo", "/repo/src"], "sig": D.error_signature(text, ["/repo", "/repo/src"])}
        for text in sig_outputs
    ]
    vectors["relative"] = [
        {"text": text, "roots": ["/repo"], "out": D._relative(text, ["/repo"])}
        for text in (
            "cd /repo && pytest -q",
            "cd /repo/src && npm test",
            "python /repo/tools/x.py --flag",
            "pytest -q",
        )
    ]

    digest_vectors = []
    for name, calls, generic in (
        ("generic", generic_calls, True),
        ("python", python_calls, False),
    ):
        path = ws.transcript(calls)
        dg = D.build_digest(ws.dir, path, "t-0", True, generic=generic)
        digest_vectors.append({
            "name": name, "calls": call_list(calls), "generic": generic,
            "start": ws.dir, "top": O.repository_top(ws.dir),
            "digest": dict(dg),
        })
    vectors["digests"] = digest_vectors

    prompt_vectors = []
    for name, calls, generic, existing in (
        ("generic", generic_calls, True,
         {"npm-test": "Run `npm test`; it is the canonical suite.",
          "lint": "Lint is `npm run lint`."}),
        ("python", python_calls, False, ["pytest-canonical", "repro-redundant"]),
    ):
        path = ws.transcript(calls)
        dg = D.build_digest(ws.dir, path, "t-0", True, generic=generic)
        window = [dg]
        feats = ["edited_at_least_two", "ran_checks"]
        excerpts = ["docker build -t app ."] if generic else ["python -m coverage run -m pytest"]
        external = ["Python is run as `python3` here."] if generic else []
        prompt = D.build_proposer_prompt(
            "example/repo", window, existing, set(feats),
            raw_excerpts=excerpts, external=external, generic=generic,
        )
        prompt_vectors.append({
            "name": name, "calls": call_list(calls), "generic": generic,
            "start": ws.dir, "top": O.repository_top(ws.dir),
            "existing": existing, "features": feats,
            "excerpts": excerpts, "external": external, "prompt": prompt,
        })
    vectors["proposer_prompts"] = prompt_vectors
    vectors["proposer_system"] = {
        "default": D.PROPOSER_SYSTEM,
        "generic": D.PROPOSER_SYSTEM_GENERIC,
        "generic_predicates": list(D.GENERIC_PREDICATES),
    }

    payloads = [
        '{"extractors": [{"name": "ran_docker", "kind": "cmd_regex", "pattern": "docker "}],'
        ' "facts": [{"id": "x", "detector": {"scope": "ran_docker"}}]}',
        'prose before {"facts": [{"id": "a", "detector": {}}], "extractors": [{"name": "n"}]} after',
        'not json at all',
        '{"facts": []}',
        '{"extractors": [{"pattern": "x"}], "facts": [{"id": "a", "detector": {}}, {"noid": 1}]}',
    ]
    vectors["parse_payload"] = [
        {"raw": raw, "extractors": D.parse_payload(raw)[0], "facts": D.parse_payload(raw)[1]}
        for raw in payloads
    ]

    # ---- detector verdicts ------------------------------------------------------------
    det_digest = D.build_digest(ws.dir, ws.transcript(generic_calls), "t-0", True, generic=True)
    specs = [
        {"scope": "ran_checks", "confirm": "npm test", "fired": "ran_checks"},
        {"scope": "cmd_regex", "confirm": "npm run lint"},
        {"scope": "missing_dependency", "confirm": "No module named 'yaml'"},
        {"scope": "ran_checks", "confirm": "make test", "contradict": "npm test"},
        {"scope": "ran_tests", "fired": "missing_command"},
    ]
    vectors["detectors"] = []
    for spec in specs:
        det = D.DetectorV3Scope(spec, {"edited_at_least_two": True})
        verdict, fired, exercised = det.verdict(det_digest)
        vectors["detectors"].append({
            "spec": spec, "features": {"edited_at_least_two": True},
            "digest": dict(det_digest),
            "verdict": verdict, "fired": fired, "exercised": exercised,
        })

    # ---- constants that must not drift -----------------------------------------------
    vectors["constants"] = {
        "lifecycle": {
            "K_PROMOTE": L.K_PROMOTE, "GAMMA": L.GAMMA, "LAMBDA": L.LAMBDA,
            "SCORE_FLOOR": L.SCORE_FLOOR, "HARD_KILL": L.HARD_KILL,
            "FIRE_GATE": L.FIRE_GATE, "FIRE_MIN_N": L.FIRE_MIN_N,
        },
        "envfacts": {
            "STATE_SUBDIR": E.STATE_SUBDIR, "MAX_FACTS": E.MAX_FACTS,
            "MAX_TOKENS": E.MAX_TOKENS, "HEADER": E.HEADER,
            "GENERIC_HEADER": E.GENERIC_HEADER,
            "CONTRADICT_STREAK": E.CONTRADICT_STREAK,
        },
        "distiller": {
            "PROPOSE_EVERY": D.PROPOSE_EVERY, "WINDOW": D.WINDOW,
            "MAX_CANDS": D.MAX_CANDS, "MIN_CITE": D.MIN_CITE,
            "MAX_EXTRACTORS": D.MAX_EXTRACTORS, "RAW_SAMPLE": D.RAW_SAMPLE,
            "ABSTAIN_GATE": D.ABSTAIN_GATE, "STATE_SUBDIR": D.STATE_SUBDIR,
            "BLOB_CAP": D.BLOB_CAP,
        },
    }

    leftovers = [n for n in (ws.dir,) if os.path.isdir(n)]
    data = json.dumps(vectors, indent=1, ensure_ascii=True, sort_keys=False)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(data + "\n")
    for path in leftovers:
        shutil.rmtree(path, ignore_errors=True)
    return vectors


def main():
    vectors = generate()

    def count(section):
        value = vectors.get(section)
        return len(value) if isinstance(value, list) else 1

    print("wrote %s" % OUT)
    for section in ("unwrap", "segments", "error_class", "label_rule", "classify", "observe",
                    "lifecycle", "env_claims", "env_update", "digests", "proposer_prompts",
                    "parse_payload", "detectors", "templates", "error_signature"):
        print("  %-18s %d" % (section, count(section)))


if __name__ == "__main__":
    main()
