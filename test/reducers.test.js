import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExecutionFailure,
  reduceGit,
  reducePackageManager,
  reduceTestOutput,
  applySemanticReducers
} from '../lib/reducers/index.js';

describe('isExecutionFailure', () => {
  it('should return false for successful or empty result', () => {
    assert.equal(isExecutionFailure(undefined), false);
    assert.equal(isExecutionFailure(null), false);
    assert.equal(isExecutionFailure({}), false);
    assert.equal(isExecutionFailure({ isError: false }), false);
    assert.equal(isExecutionFailure({ exitCode: 0 }), false);
    assert.equal(isExecutionFailure({ status: 0 }), false);
    assert.equal(isExecutionFailure({ code: 0 }), false);
    assert.equal(isExecutionFailure({ status: 'ok' }), false);
    assert.equal(isExecutionFailure({ status: 'success' }), false);
  });

  it('should detect explicit isError: true', () => {
    assert.equal(isExecutionFailure({ isError: true }), true);
  });

  it('should detect non-zero exitCode, status, or code', () => {
    assert.equal(isExecutionFailure({ exitCode: 1 }), true);
    assert.equal(isExecutionFailure({ exitCode: 127 }), true);
    assert.equal(isExecutionFailure({ status: 2 }), true);
    assert.equal(isExecutionFailure({ code: -1 }), true);
  });

  it('should detect failure string status', () => {
    assert.equal(isExecutionFailure({ status: 'error' }), true);
    assert.equal(isExecutionFailure({ status: 'FAILED' }), true);
    assert.equal(isExecutionFailure({ status: 'failure' }), true);
  });

  it('should inspect canonical DSH foreground outcomes and termination', () => {
    const foreground = { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false };
    assert.equal(isExecutionFailure({ isError: false, value: foreground }), false);
    for (const extra of [{ exitCode: 2 }, { exitCode: null }, { signal: 'SIGTERM' }, { timedOut: true }, { aborted: true }, { stopped: 'cancelled' }, { sandbox: { denied: true } }, { sandbox: { runnerFailed: true } }]) {
      assert.equal(isExecutionFailure({ isError: false, value: { ...foreground, ...extra } }), true);
    }
    assert.equal(isExecutionFailure({ timedOut: true }), true);
    assert.equal(isExecutionFailure({ signal: 'SIGKILL' }), true);
    assert.equal(isExecutionFailure({ failed: true }), true);
    assert.equal(isExecutionFailure({ sandbox: { runnerFailed: true } }), true);
    assert.equal(isExecutionFailure({ value: { kind: 'promoted', output: 'partial' } }), true);
    assert.equal(isExecutionFailure({ status: 'cancelled' }), true);
    assert.equal(isExecutionFailure({ status: 'unknown' }), true);
    assert.equal(isExecutionFailure({ value: { example: 'application data' } }), false);
  });

  it('should protect explicit DSH text status markers without broad keyword matching', () => {
    for (const marker of [
      '[exit code: 2]',
      '[exit code: -1]',
      '[exit code: null]',
      '[killed by signal: SIGTERM]',
      '[timed out after 1000ms]',
      '[stopped: user]',
      '[still running after 1000ms; moved to background job bash-1]',
      '[sandbox: the sandbox runner itself failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure]'
    ]) {
      assert.equal(isExecutionFailure({ isError: false }, `successful-looking output\n${marker}`), true);
    }
    assert.equal(isExecutionFailure(undefined, 'ok\n[exit code: 1]'), true);
    assert.equal(isExecutionFailure({}, 'ok\n[exit code: 0]'), false);
    assert.equal(isExecutionFailure({}, 'Example: [exit code: 1] is a failure marker'), false);
    assert.equal(isExecutionFailure({}, 'Tests check error handling and failed requests'), false);
  });

  it('should preserve diagnostics when a failed command contains success-looking output', () => {
    const exec = { arguments: { command: 'git status; exit 2' } };
    const raw = 'On branch main\nnothing to commit, working tree clean\n[stderr]\nvalidation failed\n[exit code: 2]';
    const outcome = applySemanticReducers(exec, raw, { isError: false, value: { kind: 'foreground', exitCode: 2 } });
    assert.equal(outcome.reduced, false);
    assert.equal(outcome.text, raw);
  });

  it('should fail-open if inspecting result throws', () => {
    const dangerousResult = {};
    Object.defineProperty(dangerousResult, 'isError', {
      get() { throw new Error('getter error'); }
    });
    assert.equal(isExecutionFailure(dangerousResult), true);
  });
});

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

  it('should fail-open if command returned non-zero exit code or status', () => {
    const raw = 'fatal: not a git repository';
    assert.equal(reduceGit({ arguments: { command: 'git status' } }, raw, { exitCode: 128 }), null);
    assert.equal(reduceGit({ arguments: { command: 'git status' } }, raw, { status: 1 }), null);
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

  it('should fail-open on non-zero exit code for package manager', () => {
    const raw = 'npm notice something\nadded 1 package';
    assert.equal(reducePackageManager({ arguments: { command: 'npm install' } }, raw, { exitCode: 1 }), null);
  });

  it('should fail-open on non-package-manager commands', () => {
    const raw = 'added 1 item';
    const res = reducePackageManager({ arguments: { command: 'echo added 1 item' } }, raw);
    assert.equal(res, null);
  });

  it('should preserve diagnostic and path-like lines even if prefixed with Braille spinner', () => {
    const rawWithWarning = '⠋ warning: src/file.ts:42:3 diagnostic found\nadded 1 package\n';
    // When no other noise exists, reduction safely yields null (fail-open)
    assert.equal(reducePackageManager({ arguments: { command: 'npm install' } }, rawWithWarning), null);

    const rawWithNoiseAndWarning = '[====================] 100%\n⠋ fetching packages...\n⠋ warning: src/file.ts:42:3 diagnostic found\nadded 1 package\n';
    const res = reducePackageManager({ arguments: { command: 'npm install' } }, rawWithNoiseAndWarning);
    assert.ok(res);
    assert.ok(res.includes('warning: src/file.ts:42:3 diagnostic found'));
    assert.ok(!res.includes('fetching packages'));
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

  it('should fail-open when test runner exits with non-zero exit code', () => {
    const raw = 'ℹ tests 2\nℹ pass 2\nℹ fail 0';
    assert.equal(reduceTestOutput({ arguments: { command: 'node --test' } }, raw, { exitCode: 1 }), null);
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

  it('should be idempotent when running reducers on already-reduced output', () => {
    const raw = 'On branch main\nYour branch is up to date with origin/main.\n\nnothing to commit, working tree clean';
    const first = applySemanticReducers({ arguments: { command: 'git status' } }, raw);
    assert.equal(first.reduced, true);
    assert.equal(first.text, 'On branch main: working tree clean');

    // Running second time on the already reduced text
    const second = applySemanticReducers({ arguments: { command: 'git status' } }, first.text);
    // Already clean, doesn't match raw multiline pattern, safely yields/returns unchanged
    assert.equal(second.reduced, false);
    assert.equal(second.text, first.text);
  });

  it('should handle CRLF and unicode content gracefully in reducers', () => {
    const rawCrlf = 'On branch main\r\nYour branch is up to date with origin/main.\r\n\r\nnothing to commit, working tree clean\r\n';
    const res = reduceGit({ arguments: { command: 'git status' } }, rawCrlf);
    assert.equal(res, 'On branch main: working tree clean');
  });
});
