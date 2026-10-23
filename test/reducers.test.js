import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceGit,
  reducePackageManager,
  reduceTestOutput,
  applySemanticReducers
} from '../lib/reducers/index.js';

describe('reduceGit', () => {
  it('should condense clean git status to a single line', () => {
    const raw = `On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean`;
    const res = reduceGit({ arguments: { command: 'git status' } }, raw);
    assert.equal(res, 'On branch main: working tree clean');
  });

  it('should strip repetitive guidance from dirty git status while preserving all file paths', () => {
    const raw = `On branch feature/auth
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   src/login.ts
	modified:   src/token.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	src/oauth.ts

no changes added to commit (use "git add" and/or "git commit -a")`;

    const res = reduceGit({ arguments: { command: 'git status' } }, raw);
    assert.ok(res.includes('On branch feature/auth'));
    assert.ok(res.includes('modified:   src/login.ts'));
    assert.ok(res.includes('modified:   src/token.ts'));
    assert.ok(res.includes('src/oauth.ts'));
    assert.ok(!res.includes('use "git add'));
    assert.ok(!res.includes('use "git restore'));
  });

  it('should strip index hash lines from git diff while preserving hunks', () => {
    const raw = `diff --git a/src/index.ts b/src/index.ts
index a1b2c3d..e4f5g6h 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -10,3 +10,4 @@
 const x = 1;
+const y = 2;
`;
    const res = reduceGit({ arguments: { command: 'git diff' } }, raw);
    assert.ok(res.includes('diff --git a/src/index.ts b/src/index.ts'));
    assert.ok(res.includes('+const y = 2;'));
    assert.ok(!res.includes('index a1b2c3d..e4f5g6h'));
  });

  it('should fail-open on non-hunk diffs like git diff --stat', () => {
    const raw = ` src/index.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)`;
    const res = reduceGit({ arguments: { command: 'git diff --stat' } }, raw);
    assert.equal(res, null);
  });

  it('should fail-open if command failed with error', () => {
    const raw = 'fatal: not a git repository';
    const res = reduceGit({ arguments: { command: 'git status' } }, raw, { isError: true });
    assert.equal(res, null);
  });
});

describe('reducePackageManager', () => {
  it('should strip progress bars, deprecation notices, and funding reminders from npm install', () => {
    const raw = [
      '[====================] 100%',
      'npm WARN deprecated inflight@1.0.6: This module is not supported.',
      'npm notice New major version of npm available! 10.8.2 -> 11.0.0',
      'npm notice Run `npm install -g npm` to update!',
      '',
      'added 23 packages, and audited 150 packages in 2s',
      '',
      '3 packages are looking for funding.',
      '  Run `npm fund` for details',
      '',
      'found 0 vulnerabilities'
    ].join('\n');

    const res = reducePackageManager({ arguments: { command: 'npm install' } }, raw);
    assert.ok(res.includes('added 23 packages, and audited 150 packages in 2s'));
    assert.ok(res.includes('found 0 vulnerabilities'));
    assert.ok(!res.includes('deprecated'));
    assert.ok(!res.includes('looking for funding'));
    assert.ok(!res.includes('npm notice'));
  });

  it('should fail-open on npm install error', () => {
    const raw = 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree';
    const res = reducePackageManager({ arguments: { command: 'npm install' } }, raw, { isError: true });
    assert.equal(res, null);
  });

  it('should fail-open on non-package-manager commands', () => {
    const raw = 'added 1 item';
    const res = reducePackageManager({ arguments: { command: 'echo added 1 item' } }, raw);
    assert.equal(res, null);
  });
});

describe('reduceTestOutput', () => {
  it('should collapse cleanly passing node --test runs into a 1-line summary', () => {
    const raw = `✔ test 1 (1.2ms)
✔ test 2 (3.4ms)
ℹ tests 25
ℹ suites 3
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1420.5`;

    const res = reduceTestOutput({ arguments: { command: 'node --test' } }, raw);
    assert.equal(res, '✓ All tests passed: 25 of 25 passed, 0 failed (~1.4s)');
  });

  it('should collapse cleanly passing vitest runs', () => {
    const raw = ` ✓ tests/auth.test.ts (2)
 ✓ tests/db.test.ts (3)

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  12:00:00
   Duration  450ms`;

    const res = reduceTestOutput({ arguments: { command: 'npm test -- vitest' } }, raw);
    assert.equal(res, '✓ All tests passed: 5 passed (450ms)');
  });

  it('should collapse cleanly passing pytest runs', () => {
    const raw = `tests/test_api.py ....
============================== 4 passed in 0.85s ==============================`;

    const res = reduceTestOutput({ arguments: { command: 'pytest' } }, raw);
    assert.equal(res, '✓ All tests passed: 4 passed in 0.85s');
  });

  it('should collapse cleanly passing cargo test runs', () => {
    const raw = `running 12 tests
test tests::test_add ... ok
test tests::test_sub ... ok

test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s`;

    const res = reduceTestOutput({ arguments: { command: 'cargo test' } }, raw);
    assert.equal(res, '✓ Cargo tests passed: 12 passed, 0 failed (0.08s)');
  });

  it('should strictly fail-open when tests fail', () => {
    const raw = `✖ test 1 (1.2ms)
  AssertionError [ERR_ASSERTION]: Expected true to be false
      at TestContext.<anonymous> (test/example.test.js:10:12)

ℹ tests 25
ℹ suites 3
ℹ pass 24
ℹ fail 1
ℹ duration_ms 1420.5`;

    const res = reduceTestOutput({ arguments: { command: 'node --test' } }, raw, { isError: true });
    assert.equal(res, null); // FAIL-OPEN: preserve all error stacks
  });
});

describe('applySemanticReducers pipeline', () => {
  it('should bypass semantic reducers when semanticReducers.enabled is false', () => {
    const raw = 'On branch main\nnothing to commit, working tree clean';
    const res = applySemanticReducers(
      { arguments: { command: 'git status' } },
      raw,
      undefined,
      { semanticReducers: { enabled: false } }
    );
    assert.equal(res.reduced, false);
    assert.equal(res.text, raw);
  });

  it('should bypass specific reducer when disabled in config', () => {
    const raw = 'On branch main\nnothing to commit, working tree clean';
    const res = applySemanticReducers(
      { arguments: { command: 'git status' } },
      raw,
      undefined,
      { semanticReducers: { git: false } }
    );
    assert.equal(res.reduced, false);
  });
});
