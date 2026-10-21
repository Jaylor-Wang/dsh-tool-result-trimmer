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
});
