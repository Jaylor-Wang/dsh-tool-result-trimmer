import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

describe('tool-result-trimmer plugin', () => {
  function createMockCtx() {
    const listeners = [];
    return {
      listeners,
      on(event, handler, options) {
        listeners.push({ event, handler, options });
      }
    };
  }

  it('should register tools/post-execute listener with prepend: true when enabled', () => {
    const ctx = createMockCtx();
    apply(ctx, { enabled: true });
    assert.equal(ctx.listeners.length, 1);
    assert.equal(ctx.listeners[0].event, 'tools/post-execute');
    assert.equal(ctx.listeners[0].options?.prepend, true);
  });

  it('should not register listener when enabled: false', () => {
    const ctx = createMockCtx();
    apply(ctx, { enabled: false });
    assert.equal(ctx.listeners.length, 0);
  });

  it('should trim oversized bash output on accept decision', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1000,
      headChars: 200,
      tailChars: 300,
      excludeTools: ['read']
    });

    const handler = ctx.listeners[0].handler;

    const exec = { name: 'bash', callId: 'call-1' };
    const longText = 'Line of build output error message...\n'.repeat(100); // ~3700 chars
    const result = {
      content: [{ type: 'text', text: longText }],
      isError: true
    };
    const next = async () => ({ kind: 'accept' });

    const decision = await handler(exec, result, next);

    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content[0].text.includes('[... tool output trimmed:'));
    assert.ok(decision.content[0].text.length < longText.length);
  });

  it('should bypass excluded tools like read even if output is huge', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1000,
      headChars: 200,
      tailChars: 300,
      excludeTools: ['read']
    });

    const handler = ctx.listeners[0].handler;

    const exec = { name: 'read', callId: 'call-2' };
    const longText = 'File content line...\n'.repeat(100);
    const result = {
      content: [{ type: 'text', text: longText }],
      isError: false
    };
    const next = async () => ({ kind: 'accept' });

    const decision = await handler(exec, result, next);

    assert.equal(decision.kind, 'accept');
    // Content is untouched
    assert.equal(decision.content, undefined); // decision didn't override content
  });

  it('should pass through blocked decisions without touching content', async () => {
    const ctx = createMockCtx();
    apply(ctx, { thresholdChars: 1000 });

    const handler = ctx.listeners[0].handler;

    const exec = { name: 'bash', callId: 'call-3' };
    const result = { content: [{ type: 'text', text: 'x'.repeat(5000) }] };
    const next = async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Blocked by policy' }] });

    const decision = await handler(exec, result, next);

    assert.equal(decision.kind, 'block');
    assert.equal(decision.feedback[0].text, 'Blocked by policy');
  });

  it('should strip ANSI escape sequences from accepted bash results', async () => {
    const ctx = createMockCtx();
    apply(ctx, { stripAnsi: true });

    const handler = ctx.listeners[0].handler;

    const exec = { name: 'bash', callId: 'call-4' };
    const result = {
      content: [{ type: 'text', text: '\x1b[1;31mFAIL\x1b[0m test/suite.js' }],
      isError: true
    };
    const next = async () => ({ kind: 'accept' });

    const decision = await handler(exec, result, next);

    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content[0].text, 'FAIL test/suite.js');
  });

  it('should trim multi-block tool output when aggregate text exceeds threshold', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1500,
      headChars: 300,
      tailChars: 300
    });

    const handler = ctx.listeners[0].handler;

    const exec = { name: 'custom_tool', callId: 'call-5' };
    const result = {
      content: [
        { type: 'text', text: 'Step 1 stdout:\n' + 'Log line info...\n'.repeat(25) }, // ~400 chars
        { type: 'text', text: 'Step 2 stderr:\n' + 'Error line info...\n'.repeat(100) } // ~1800 chars
      ],
      isError: true
    };
    const next = async () => ({ kind: 'accept' });

    const decision = await handler(exec, result, next);

    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content);
    const totalChars = decision.content.reduce((sum, b) => sum + (b.text?.length ?? 0), 0);
    assert.ok(totalChars < 1200);
    assert.ok(decision.content[0].text.startsWith('Step 1 stdout:\n'));
  });

  it('should emit a warning when thresholdChars is less than headChars + tailChars', () => {
    const warnings = [];
    const ctx = {
      ...createMockCtx(),
      logger: {
        warn(msg) {
          warnings.push(msg);
        }
      }
    };
    apply(ctx, {
      thresholdChars: 3000,
      headChars: 2000,
      tailChars: 2000
    });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('thresholdChars (3000) is less than headChars + tailChars (4000)'));
  });

  it('should bypass trimming when command includes DSH_TRIM_BYPASS=1', async () => {
    const ctx = createMockCtx();
    apply(ctx, { thresholdChars: 1000, headChars: 200, tailChars: 300 });

    const handler = ctx.listeners[0].handler;
    const exec = {
      name: 'bash',
      callId: 'call-bypass-1',
      arguments: { command: 'DSH_TRIM_BYPASS=1 npm test' }
    };
    const longText = 'Error line...\n'.repeat(100); // ~1400 chars
    const result = { content: [{ type: 'text', text: longText }] };
    const next = async () => ({ kind: 'accept' });

    const decision = await handler(exec, result, next);
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content, undefined); // untouched
  });

  it('should bypass trimming when command includes # no-trim directive', async () => {
    const ctx = createMockCtx();
    apply(ctx, { thresholdChars: 1000, headChars: 200, tailChars: 300 });

    const handler = ctx.listeners[0].handler;
    const exec = {
      name: 'bash',
      callId: 'call-bypass-2',
      arguments: { command: 'git diff # no-trim' }
    };
    const longText = 'Diff line...\n'.repeat(100);
    const result = { content: [{ type: 'text', text: longText }] };
    const next = async () => ({ kind: 'accept' });

    const decision = await handler(exec, result, next);
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content, undefined); // untouched
  });

  it('should apply per-tool overrides for custom threshold and budgets', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1000,
      headChars: 200,
      tailChars: 300,
      overrides: {
        bash: {
          thresholdChars: 5000, // higher threshold for bash
          headChars: 500,
          tailChars: 1500
        }
      }
    });

    const handler = ctx.listeners[0].handler;

    // 1. Bash execution with 2500 chars (exceeds global 1000, but under bash override 5000)
    const bashExec = { name: 'bash', callId: 'call-b1', arguments: { command: 'cargo check' } };
    const bashText = 'Cargo build output line...\n'.repeat(90); // ~2400 chars
    const bashResult = { content: [{ type: 'text', text: bashText }] };
    const bashDecision = await handler(bashExec, bashResult, async () => ({ kind: 'accept' }));
    assert.equal(bashDecision.content, undefined); // NOT trimmed because < 5000

    // 2. Custom tool with 2500 chars (uses global threshold 1000 -> trimmed)
    const otherExec = { name: 'fetch', callId: 'call-f1' };
    const otherResult = { content: [{ type: 'text', text: bashText }] };
    const otherDecision = await handler(otherExec, otherResult, async () => ({ kind: 'accept' }));
    assert.ok(otherDecision.content);
    assert.ok(otherDecision.content[0].text.includes('[... tool output trimmed:'));
  });

  it('should completely skip trimming when tool override sets enabled: false', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1000,
      overrides: {
        diagnostics: {
          enabled: false
        }
      }
    });

    const handler = ctx.listeners[0].handler;
    const exec = { name: 'diagnostics', callId: 'call-d1' };
    const longText = 'Diagnostic text...\n'.repeat(100);
    const result = { content: [{ type: 'text', text: longText }] };
    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.content, undefined); // Untouched
  });

  it('should emit a warning when a per-tool override has thresholdChars less than budget sum', () => {
    const warnings = [];
    const ctx = {
      ...createMockCtx(),
      logger: {
        warn(msg) {
          warnings.push(msg);
        }
      }
    };
    apply(ctx, {
      thresholdChars: 10000,
      overrides: {
        bash: {
          thresholdChars: 4000,
          headChars: 2500,
          tailChars: 2500
        }
      }
    });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('Tool override for "bash" has thresholdChars (4000) less than headChars + tailChars (5000)'));
  });

  it('should reduce clean git status output via semantic reducer', async () => {
    const ctx = createMockCtx();
    apply(ctx);

    const handler = ctx.listeners[0].handler;
    const exec = { name: 'bash', callId: 'call-git-1', arguments: { command: 'git status' } };
    const rawStatus = 'On branch main\nYour branch is up to date with \'origin/main\'.\n\nnothing to commit, working tree clean';
    const result = { content: [{ type: 'text', text: rawStatus }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content);
    assert.equal(decision.content[0].text, 'On branch main: working tree clean');
  });

  it('should reduce cleanly passing test output via semantic reducer', async () => {
    const ctx = createMockCtx();
    apply(ctx);

    const handler = ctx.listeners[0].handler;
    const exec = { name: 'bash', callId: 'call-test-1', arguments: { command: 'node --test' } };
    const rawTests = '✔ test 1 (1ms)\n✔ test 2 (2ms)\nℹ tests 2\nℹ suites 1\nℹ pass 2\nℹ fail 0\nℹ duration_ms 50';
    const result = { content: [{ type: 'text', text: rawTests }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content);
    assert.equal(decision.content[0].text, '✓ All tests passed: 2 of 2 passed, 0 failed (~0.1s)');
  });

  it('should fail-open and preserve full error stack when test run fails', async () => {
    const ctx = createMockCtx();
    apply(ctx, { thresholdChars: 10000 }); // High threshold, output should stay untouched

    const handler = ctx.listeners[0].handler;
    const exec = { name: 'bash', callId: 'call-test-2', arguments: { command: 'npm test' } };
    const rawFail = '✖ test 1\nAssertionError [ERR_ASSERTION]: expected 1 to equal 2\n    at test.js:5:10\nℹ tests 1\nℹ fail 1';
    const result = { content: [{ type: 'text', text: rawFail }], isError: true };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    // Semantic reducer yields (fail-open); under threshold so content is not modified
    assert.equal(decision.content, undefined);
  });
});
