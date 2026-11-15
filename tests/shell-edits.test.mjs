/**
 * Shell-edit detection: edits made through Bash, which an edit-tool counter cannot see.
 *
 * Vectors are the upstream `tests/test_live_core.py` cases for
 * `tokeneconomizer/loopguard/shell_edits.py`, plus the turn-integration cases.
 *
 * Run after building the plugin:
 *   node --test tests/shell-edits.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as guard from '../lib/loopguard/index.js'

const VECTORS = [
  ["sed -i 's/a/b/' pkg/mod.py", ['mod.py']],
  ["cd /t && sed -i.bak -e 's/a/b/' -e 's/c/d/' x.py y.py && pytest -q", ['x.py', 'y.py']],
  ["sed -i '' 's/a/b/' x.py", ['x.py']],
  ["perl -pi -e 's/foo/bar/' src/a.rs", ['a.rs']],
  ["sed -i --expression='s/a/b/' pkg/mod.py", ['mod.py']],
  ['sed --in-place --expression=s/a/b/ a.py b.py', ['a.py', 'b.py']],
  ["sed -i -e's/a/b/' x.py", ['x.py']],
  ['sed -i --file=fix.sed x.py', ['x.py']],
  ["sed -ne 's/a/b/p' -i x.py", ['x.py']],
  ["perl -i -pe's/foo/bar/' src/a.rs", ['a.rs']],
  ["perl -i.orig -pe 's/foo/bar/' src/a.rs", ['a.rs']],
  ["perl -Mre=eval -i -pe 's/foo/bar/' src/a.rs", ['a.rs']],
  ["cat > repro.py <<'EOF'\nprint(1 > 0)\nEOF\npython repro.py", ['repro.py']],
  ["echo 'x' | tee -a setup.cfg", ['setup.cfg']],
  ["python - <<'E'\np='sympy/printing/str.py'; s=open(p).read()\nopen(p,'w').write(s)\nE", ['str.py']],
  ["python - <<'E'\nfor p in ['x/a.py', 'x/b.py']:\n    open(p, 'w').write('')\nE", ['a.py', 'b.py']],
  ["python - <<'E'\nfrom pathlib import Path\nPath('m/n.py').write_text('x')\nE", ['n.py']],
  ['git apply /tmp/fix.diff', ['(patch)']],
  [
    "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: pkg/__init__.py\n@@\n-    x\n+    y\n*** End Patch\nPATCH\npython3 -m unittest",
    ['__init__.py'],
  ],
  [
    "apply_patch <<'P'\n*** Begin Patch\n*** Add File: a/new.py\n+x\n*** Update File: b/old.py\n*** End Patch\nP",
    ['new.py', 'old.py'],
  ],
  ['git checkout -- a.py b/c.py', ['a.py', 'c.py']],
  ['git -C /w/repo apply /tmp/fix.diff', ['(patch)']],
  ['git -c core.autocrlf=false --no-pager apply fix.diff', ['(patch)']],
  ['git -C repo checkout HEAD -- pkg/mod.py', ['mod.py']],
  ['git --git-dir=.git --work-tree . restore pkg/mod.py', ['mod.py']],
  ['python -m pytest -q > /tmp/out.txt 2>&1; tail -5 /tmp/out.txt', []],
  ["grep -n 'x' a.py > hits.txt", []],
  ["grep -n '>' x.py", []],
  ["grep -nE 'a|b' x.py | head", []],
  ['python -c "print(1>2)"', []],
  ['git stash -q; python bin/test x; git stash pop -q', []],
  ["sed -n '1,20p' pkg/mod.py", []],
  ['git -C repo diff -- pkg/mod.py', []],
  ['git -C repo log -- pkg/mod.py', []],
  ["sed -i -E 's/x (<|<=|>|>=) y/z/' numbers.py expr.py", ['numbers.py', 'expr.py']],
  ["sed -i 's/a/b/' x.py 2>&1 | tail -2", ['x.py']],
  ['grep -q ok <<< "ok"\nsed -i \'s/a/b/\' pkg/mod.py', ['mod.py']],
  ["read -r v <<< done\ncat > fix.py <<'EOF'\nx = 1\nEOF", ['fix.py']],
]

for (const [cmd, want] of VECTORS) {
  test(`shell edit targets: ${cmd.split('\n')[0].slice(0, 60)}`, () => {
    assert.deepEqual(guard.shellEditTargets(cmd), want)
  })
}

test('git revert targets are the paths put back', () => {
  assert.deepEqual(guard.shellRevertTargets('git -C /w/repo checkout -- pkg/mod.py'), ['mod.py'])
  assert.deepEqual(guard.shellRevertTargets('git restore pkg/mod.py'), ['mod.py'])
})

test('a shell edit counts once in the turn state and the edit counter', () => {
  const g = new guard.TurnGuard({ turnKey: 't' })
  g.fold('bash', { command: "sed -i 's/a/b/' pkg/mod.py" }, '', 0)
  assert.equal(g.edits, 1)
  assert.equal(g.whole.editCounts.get('mod.py'), 1)
  assert.ok(g.whole.recent.at(-1).includes('[edits mod.py]'))
  assert.equal(g.whole.turns, 1, 'a shell edit is still one call')
})

test('a file put back that this turn never edited is not churn', () => {
  const g = new guard.TurnGuard({ turnKey: 't' })
  for (let i = 0; i < 4; i += 1) g.fold('bash', { command: 'git checkout -q -- apps/web/AGENTS.md' }, '', 0)
  assert.equal(g.whole.editChurn, 0)
  assert.equal(g.edits, 0)
  g.fold('edit', { file_path: '/r/apps/web/page.tsx' }, 'ok')
  g.fold('bash', { command: 'git restore apps/web/page.tsx' }, '', 0)
  assert.equal(g.whole.editCounts.get('page.tsx'), 2)
  assert.equal(g.edits, 2)
})

test('an edit before a verification in one shell command is verified by it', () => {
  const g = new guard.TurnGuard({ turnKey: 't' })
  g.fold('bash', { command: "sed -i 's/a/b/' x.py && pytest -q" }, '1 passed in 0.01s', 0)
  assert.equal(g.lastEdit, g.cumTurns - 1)
  assert.equal(g.lastVerify, g.cumTurns)
  assert.equal(g.resolvedProxy(), true)
})
