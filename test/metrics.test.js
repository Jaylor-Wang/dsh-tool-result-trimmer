import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { DEFAULT_REDUCERS } from '../lib/reducers/index.js';
import { generateSpilloverFilename } from '../lib/spillover.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trimmer-metrics-'));
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-trimmer-metrics-'));
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(text, config = {}, command = 'echo secret-command', extra = {}) {
  let handler;
  const logs = [];
  apply({ on(_event, fn) { handler = fn; }, logger: { info(...values) { logs.push(values); } } }, {
    thresholdChars: 200, headChars: 40, tailChars: 40, ...config
  });
  const result = { content: [{ type: 'text', text }], ...extra };
  const decision = await handler({ name: 'bash', callId: 'sensitive-id', arguments: { command } }, result, async () => ({ kind: 'accept' }));
  return { output: decision.content ?? result.content, logs };
}

describe('P4 opt-in metrics', () => {
  it('does not log or invoke callbacks when disabled', async () => {
    let calls = 0;
    const { logs } = await run('hello', { metrics: { enabled: false, onEvent() { calls++; } } });
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  });

  it('reports safe counts and actual mechanical omissions without content', async () => {
    const events = [];
    const text = 'secret-output\n'.repeat(100);
    const base = await run(text);
    const observed = await run(text, { metrics: { enabled: true, onEvent: event => events.push(event) } });
    assert.deepEqual(observed.output, base.output);
    assert.deepEqual(observed.logs, []);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.originalChars, text.length);
    assert.equal(event.outputChars, observed.output[0].text.length);
    assert.equal(event.mechanicalTrimmed, true);
    assert.ok(event.omittedChars > 0);
    assert.ok(event.omittedLines > 0);
    assert.equal(event.reducer, null);
    assert.equal(event.spillover, 'not-attempted');
    const payload = JSON.stringify(event);
    for (const secret of ['secret-output', 'secret-command', 'sensitive-id', root]) assert.equal(payload.includes(secret), false);
  });

  it('reports semantic reducer and structured summary without mislabeling them mechanical', async () => {
    const events = [];
    const metrics = { enabled: true, onEvent: value => events.push(value) };
    await run('On branch main\nnothing to commit, working tree clean', { metrics }, 'git status');
    assert.equal(events[0].reducer, 'git');
    assert.equal(events[0].semanticReduced, true);
    assert.equal(events[0].mechanicalTrimmed, false);
    const json = JSON.stringify(Array.from({ length: 100 }, (_, i) => `item-${i}`));
    await run(json, { metrics, structuredOutput: { mode: 'summary' } });
    assert.equal(events[1].structuredSummary, true);
    assert.equal(events[1].mechanicalTrimmed, false);
    assert.equal(events[1].outputChars < events[1].originalChars, true);
  });

  it('reports storage success, refusal, and bounded cleanup without exposing paths', async () => {
    const events = [];
    const old = path.join(root, generateSpilloverFilename('old', 'old'));
    fs.writeFileSync(old, 'old');
    fs.utimesSync(old, new Date(0), new Date(0));
    const metrics = { enabled: true, onEvent: e => events.push(e) };
    await run('text\n'.repeat(300), { metrics, spillover: { enabled: true, directory: root, ttlMs: 1000 } });
    assert.equal(events[0].spillover, 'success');
    assert.equal(events[0].cleanup, 'complete');
    assert.equal(events[0].cleanupDeleted, 1);
    assert.equal(JSON.stringify(events[0]).includes(root), false);
    const file = path.join(root, 'not-directory');
    fs.writeFileSync(file, 'block');
    await run('text\n'.repeat(300), { metrics, spillover: { enabled: true, directory: file } });
    assert.equal(events[1].spillover, 'failed');
    assert.equal(events[1].cleanup, 'not-attempted');
  });

  it('distinguishes lock contention from cleanup failure', async (t) => {
    const events = [];
    const metrics = { enabled: true, onEvent: event => events.push(event) };
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, '.dsh-trimmer.lock'), 'lock');
    await run('text\n'.repeat(300), { metrics, spillover: { enabled: true, directory: locked } });
    assert.equal(events[0].spillover, 'failed');
    assert.equal(events[0].cleanup, 'not-attempted');
    const dir = path.join(root, 'cleanup-failed');
    fs.mkdirSync(dir);
    const old = path.join(dir, generateSpilloverFilename('old', 'old'));
    fs.writeFileSync(old, 'old');
    fs.utimesSync(old, new Date(0), new Date(0));
    const unlink = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', file => {
      if (file === old) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return unlink(file);
    });
    await run('text\n'.repeat(300), { metrics, spillover: { enabled: true, directory: dir, ttlMs: 1000, maxFiles: 1 } });
    assert.equal(events[1].spillover, 'failed');
    assert.equal(events[1].cleanup, 'failed');
    assert.equal(events[1].cleanupDeleted, 0);
  });

  it('reports preserved JSON and ignores excluded or blocked decisions', async () => {
    const events = [];
    const config = { metrics: { enabled: true, onEvent: event => events.push(event) } };
    const raw = JSON.stringify({ data: 'x'.repeat(1000) });
    await run(raw, config);
    assert.equal(events[0].originalChars, raw.length);
    assert.equal(events[0].outputChars, raw.length);
    assert.equal(events[0].structuredSummary, false);
    let handler;
    apply({ on(_event, fn) { handler = fn; } }, config);
    const result = { content: [{ type: 'text', text: raw }] };
    await handler({ name: 'read' }, result, async () => ({ kind: 'accept' }));
    await handler({ name: 'bash' }, result, async () => ({ kind: 'block' }));
    assert.equal(events.length, 1);
  });

  it('counts multi-block projections and semantic-only spillover notices', async () => {
    const events = [];
    const metrics = { enabled: true, onEvent: event => events.push(event) };
    let handler;
    apply({ on(_event, fn) { handler = fn; } }, { metrics, thresholdChars: 10000 });
    const image = { type: 'image', data: 'secret-image' };
    const content = [{ type: 'text', text: 'abc\r\n' }, image, { type: 'text', text: '😀' }];
    const decision = await handler({ name: 'bash' }, { content }, async () => ({ kind: 'accept' }));
    assert.equal(decision.content, undefined);
    assert.equal(events[0].originalChars, 7);
    assert.equal(events[0].outputChars, 7);
    assert.equal(JSON.stringify(events[0]).includes('secret-image'), false);
    const text = 'On branch main\nnothing to commit, working tree clean';
    const result = await run(text, { metrics, thresholdChars: 10000, spillover: { enabled: true, directory: root, onSemanticReduction: true } }, 'git status');
    assert.equal(events[1].reducer, 'git');
    assert.equal(events[1].spillover, 'success');
    assert.equal(events[1].mechanicalTrimmed, false);
    assert.equal(events[1].outputChars, result.output.reduce((n, block) => n + block.text.length, 0));
  });

  it('keeps output unchanged when a callback throws or rejects', async () => {
    const text = 'x'.repeat(1000);
    const base = await run(text);
    for (const onEvent of [() => { throw new Error('failure'); }, async () => { throw new Error('failure'); }]) {
      const result = await run(text, { metrics: { enabled: true, onEvent } });
      assert.deepEqual(result.output, base.output);
    }
  });

  it('does not expose unrecognized reducer names in metrics', async () => {
    const events = [];
    const custom = { name: 'secret-reducer-name', fn: () => 'shortened' };
    DEFAULT_REDUCERS.push(custom);
    try {
      await run('original output', { metrics: { enabled: true, onEvent: event => events.push(event) } }, 'custom');
      assert.equal(events[0].semanticReduced, true);
      assert.equal(events[0].reducer, null);
      assert.equal(JSON.stringify(events).includes(custom.name), false);
    } finally {
      assert.equal(DEFAULT_REDUCERS.pop(), custom);
    }
  });

  it('ignores errors while reading metrics configuration', async () => {
    const metrics = { get enabled() { throw new Error('inaccessible'); } };
    const text = 'x'.repeat(1000);
    assert.deepEqual((await run(text, { metrics })).output, (await run(text)).output);
  });

  it('logs only safe fields when enabled without a callback', async () => {
    const { logs } = await run('secret-output', { metrics: { enabled: true } });
    assert.equal(logs.length, 1);
    const text = JSON.stringify(logs);
    assert.equal(text.includes('secret-output'), false);
    assert.equal(text.includes('secret-command'), false);
    assert.equal(text.includes('sensitive-id'), false);
    assert.equal(logs[0][1].originalChars, 'secret-output'.length);
  });
});
