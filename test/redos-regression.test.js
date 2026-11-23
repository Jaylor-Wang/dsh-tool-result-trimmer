import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { apply } from '../lib/index.js';
import { commandContext, commandTokens, isFilePath, isHeadFirstWebCommand } from '../lib/reducers/command.js';
import { applySemanticReducers, DEFAULT_REDUCERS, reduceGit, reducePackageManager, reduceTestOutput } from '../lib/reducers/index.js';
import { inspectRecoveryNotices } from '../lib/spill-recovery.js';

const BUDGET_MS = 100;

function assertLinear(label, fn) {
  const start = performance.now();
  const value = fn();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < BUDGET_MS, `${label} exceeded ${BUDGET_MS}ms budget (took ${elapsed.toFixed(2)}ms)`);
  return value;
}

describe('ReDoS and worst-case complexity regressions', () => {
  it('handles long cd paths with redirection, chains, or no && in linear time (Issue #1)', () => {
    const realRepro = 'cd ~/.dsh/plugin-src/dgh/packages/dgh-data/src/mailbox 2>/dev/null && sed -n "50,75p" tools.ts';
    assert.equal(assertLinear('real repro command', () => commandContext({ arguments: { command: realRepro } })), null);

    for (const len of [50, 200, 2000]) {
      const withRedirect = `cd x/${'a'.repeat(len)} 2>/dev/null && true`;
      assert.equal(assertLinear(`cd + redirect (${len})`, () => commandContext({ arguments: { command: withRedirect } })), null);

      const plainCd = `cd /${'a'.repeat(len)}`;
      const parsed = assertLinear(`plain cd (${len})`, () => commandContext({ arguments: { command: plainCd } }));
      assert.deepEqual(parsed?.tokens, ['cd', `/${'a'.repeat(len)}`]);

      const semiCd = `cd /${'a'.repeat(len)}; ls`;
      assert.equal(assertLinear(`cd + semicolon (${len})`, () => commandContext({ arguments: { command: semiCd } })), null);

      const unterminated = `cd "${'a'.repeat(len)} && git status`;
      assert.equal(assertLinear(`cd unterminated quote (${len})`, () => commandContext({ arguments: { command: unterminated } })), null);
    }

    // Reject oversized commands immediately without scanning
    const huge = `cd /${'a'.repeat(20000)} && git status`;
    assert.equal(assertLinear('oversized command', () => commandContext({ arguments: { command: huge } })), null);
  });

  it('handles escaped quotes inside double-quoted cd targets without mis-splitting', () => {
    const parsed = commandContext({ arguments: { command: 'cd "dir\\"&&part" && git status', workdir: '/repo' } });
    assert.deepEqual(parsed, { tokens: ['git', 'status'], workdir: '/repo/dir"&&part' });

    const trailingBackslash = commandContext({ arguments: { command: 'cd "E:\\\\repo\\\\" && git status', workdir: 'E:\\other' } });
    assert.deepEqual(trailingBackslash?.tokens, ['git', 'status']);
  });

  it('keeps isFilePath linear on huge path-free tokens while preserving path detection', () => {
    assert.equal(assertLinear('isFilePath 50KB token', () => isFilePath('a'.repeat(50000))), false);
    assert.equal(assertLinear('isFilePath 50KB dotted digits', () => isFilePath('1.'.repeat(25000))), false);

    for (const yes of ['/tmp/a.js', 'C:\\repo\\file.ts', '\\\\server\\share\\x', './src/a.js', '../a.js', 'src/index.ts', 'file.ts:42:3', 'foo="bar/baz"']) {
      assert.equal(isFilePath(yes), true, yes);
    }
    for (const no of ['10/20', '100%', 'v1.2.3', 'fetching packages...', '25% building', '.hidden']) {
      assert.equal(isFilePath(no), false, no);
    }
  });

  it('keeps git and package-manager reducers linear on whitespace-heavy and pip outputs', () => {
    const blankLines = `${' \n'.repeat(10000)}M file.txt\n`;
    assertLinear('reduceGit 10k blank lines', () =>
      reduceGit({ arguments: { command: 'git status' } }, blankLines, { exitCode: 0 })
    );

    const pipSpaces = `Downloading foo\n${' '.repeat(10000)}\n`;
    assertLinear('reducePackageManager pip spaces', () =>
      reducePackageManager({ arguments: { command: 'pip install foo' } }, pipSpaces, { exitCode: 0 })
    );

    const pipDigits = `Downloading foo\n [===] ${'1'.repeat(30000)}X\n`;
    assertLinear('reducePackageManager pip 30k digits', () =>
      reducePackageManager({ arguments: { command: 'pip install foo' } }, pipDigits, { exitCode: 0 })
    );

    // Path-free pip progress block still reduces cleanly
    const realPip = 'Downloading pkg\n   [==========] 100% 2.1 MB\nSuccessfully installed pkg\n';
    const pipReduced = reducePackageManager({ arguments: { command: 'pip install pkg' } }, realPip, { exitCode: 0 });
    assert.ok(pipReduced && !pipReduced.includes('[==========]') && pipReduced.includes('Successfully installed pkg'));
  });

  it('keeps test-runner regexes linear on repeated summaries, equals signs, and cancelled spaces', () => {
    const repeated = `${'ℹ tests 1\nℹ pass 1\n'.repeat(500)}done\n`;
    const res = assertLinear('reduceTestOutput 500 repeated pairs', () =>
      reduceTestOutput({ arguments: { command: 'node --test' } }, repeated, { exitCode: 0 })
    );
    assert.equal(res, null);

    const equalsBlob = `${'='.repeat(30000)}X`;
    assert.equal(
      assertLinear('pytestMatch 30k equals', () =>
        reduceTestOutput({ arguments: { command: 'pytest' } }, equalsBlob, { exitCode: 0 })
      ),
      null
    );

    const cancelledSpaces = `cancelled${' '.repeat(30000)}X`;
    assert.equal(
      assertLinear('hasFailureSignal 30k spaces', () =>
        reduceTestOutput({ arguments: { command: 'pytest' } }, cancelledSpaces, { exitCode: 0 })
      ),
      null
    );
  });

  it('keeps isHeadFirstWebCommand linear on space-heavy commands without trailing 2>&1', () => {
    const spaced = `echo ${' '.repeat(30000)}x`;
    assert.equal(
      assertLinear('isHeadFirstWebCommand 30k spaces', () =>
        isHeadFirstWebCommand({ name: 'bash', arguments: { command: spaced } })
      ),
      false
    );
    assert.equal(
      isHeadFirstWebCommand({ name: 'bash', arguments: { command: 'curl -s https://r.jina.ai/https://example.com 2>&1' } }),
      true
    );
  });

  it('trips a per-reducer circuit breaker on slow execution and fails open', async () => {
    let calls = 0;
    const warnings = [];
    const slowReducer = {
      name: 'slow-test-reducer',
      fn() {
        calls++;
        const end = performance.now() + 60;
        while (performance.now() < end) { /* simulate slow synchronous work */ }
        return 'reduced';
      }
    };
    DEFAULT_REDUCERS.push(slowReducer);
    try {
      let handler;
      apply(
        {
          on(_event, fn) { handler = fn; },
          logger: { warn(_fmt, payload) { warnings.push(payload); } }
        },
        { spillover: { enabled: false }, thresholdChars: 10000 }
      );
      const exec = { name: 'bash', arguments: { command: 'custom' } };
      const result = { content: [{ type: 'text', text: 'raw output' }] };
      const next = async () => ({ kind: 'accept' });

      // 1st slow call: fails open (keeps raw output) and logs reducer-slow
      const first = await handler(exec, result, next);
      assert.equal(first.content, undefined);
      assert.equal(calls, 1);
      assert.equal(warnings.at(-1)?.reason, 'reducer-slow');

      // 2nd slow call: fails open and opens the circuit for this reducer
      const second = await handler(exec, result, next);
      assert.equal(second.content, undefined);
      assert.equal(calls, 2);
      assert.equal(warnings.at(-1)?.reason, 'reducer-circuit-open');

      // 3rd call: circuit is open, reducer is skipped immediately without executing
      const third = await handler(exec, result, next);
      assert.equal(third.content, undefined);
      assert.equal(calls, 2);
    } finally {
      assert.equal(DEFAULT_REDUCERS.pop(), slowReducer);
    }
  });

  it('keeps inspectRecoveryNotices linear on pathological notice-like text without closing paren', () => {
    const pathological = `preview\n\n( Full formatted result stored at: ${'a. '.repeat(10000)}end`;
    const res = assertLinear('inspectRecoveryNotices 10k dot-space', () => inspectRecoveryNotices(pathological));
    assert.deepEqual(res, { notices: [], wholeResult: false });
  });

  it('skips semantic reducers in O(1) for unrelated commands and oversized blobs', () => {
    const outcome = assertLinear('unrelated command with long cd', () =>
      applySemanticReducers(
        { arguments: { command: 'cd ~/.dsh/plugin-src/dgh/packages/dgh-data/src/mailbox 2>/dev/null && sed -n "50,75p" tools.ts' } },
        'output line\n'.repeat(100),
        { exitCode: 0 }
      )
    );
    assert.equal(outcome.reduced, false);

    // Oversized >1MB output bypasses semantic reducers cleanly
    const huge = `On branch main\n${'x'.repeat(1024 * 1024 + 10)}`;
    const hugeOutcome = assertLinear('oversized >1MB text', () =>
      applySemanticReducers({ arguments: { command: 'git status' } }, huge, { exitCode: 0 })
    );
    assert.equal(hugeOutcome.reduced, false);
    assert.equal(commandTokens({ arguments: { command: 'sed -n "50,75p" tools.ts' } }), null);
  });
});
