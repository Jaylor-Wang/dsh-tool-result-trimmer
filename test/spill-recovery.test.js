import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';
import { findRecoveryNotices } from '../lib/spill-recovery.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trimmer-recovery-'));
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-trimmer-recovery-'));
  fs.rmSync(root, { recursive: true, force: true });
});

const exec = {
  name: 'bash', callId: 'call-recovery',
  agent: { session: { header: { id: 'session-recovery' } } },
  arguments: { command: 'echo diagnostics' }
};
const ref = { locator: 'spill://session-recovery/result', bytes: 123, retrievalHint: 'Use the artifact reader with this locator.' };
const raw = '\x1b[31m中文😀 diagnostic\x1b[0m\r\n'.repeat(200);
const bashNotice = '[output truncated; full output: C:\\logs with spaces\\stdout.log]';
const officialNotice = '(Omitted 12345 bytes. Full formatted result stored at: spill://session-recovery/upstream. Use the artifact reader.)';

async function run(content, { context = {}, config = {}, execution = exec, downstream, result = {} } = {}) {
  let handler;
  const directory = path.join(root, `case-${fs.readdirSync(root).length}`);
  apply({ on(_event, listener) { handler = listener; }, ...context }, {
    thresholdChars: 500, headChars: 100, tailChars: 100,
    ...config,
    spillover: { directory, ...config.spillover }
  });
  const decision = await handler(execution, { content, ...result }, async () => downstream ?? { kind: 'accept' });
  return { decision, content: decision.content ?? content, directory };
}

function optionalPeer(t, specifier) {
  try { return createRequire(import.meta.url).resolve(specifier); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    t.skip(`Optional host peer ${specifier} is unavailable; set NODE_PATH to test the host installation`);
    return null;
  }
}

const blocks = text => [{ type: 'text', text }];
const project = content => content.filter(block => block.type === 'text').map(block => block.text).join('');

function backend() {
  const calls = [];
  const store = { async saveText(input) { calls.push(input); return ref; } };
  return { calls, store, context: { get(name) { assert.equal(name, 'spillStore'); return store; } } };
}

describe('upstream spill recovery', () => {
  it('recognizes complete bash and official conventions, including notice-only output', () => {
    for (const notice of [bashNotice, officialNotice,
      '(More bytes were omitted. Omitted 2 images. Full formatted result stored at: /tmp/result.txt. Use read.)',
      '( Full formatted result stored at: /tmp/result.txt. Use read.)']) {
      assert.deepEqual(findRecoveryNotices(notice), [notice]);
      assert.deepEqual(findRecoveryNotices(`preview\n\n${notice}\r\n`), [notice]);
      assert.deepEqual(findRecoveryNotices(`preview\r\n\r\n${notice}\r\n`), [notice]);
    }
  });

  it('uses the installed official notice recognizer when available', async (t) => {
    const peer = optionalPeer(t, '@deepseek-ai/dsh-spill-policy/notice');
    if (!peer) return;
    const hook = registerHooks({ resolve(specifier, context, next) {
      return specifier === '@deepseek-ai/dsh-spill-policy/notice' ? { url: pathToFileURL(peer).href, shortCircuit: true } : next(specifier, context);
    } });
    try {
      const { formatSpillNotice, hasSpillNotice } = await import(pathToFileURL(peer).href);
      const { findRecoveryNotices: recognize } = await import('../lib/spill-recovery.js?official-notice-acceptance');
      for (const omitted of [{ kind: 'none' }, { kind: 'unknown' }, { kind: 'exact', count: 12345 }]) {
        for (const images of [0, 2]) {
          const notice = formatSpillNotice(omitted, ref, images);
          assert.equal(hasSpillNotice(notice), true);
          assert.deepEqual(recognize(`preview\n\n${notice}`), [notice]);
          assert.deepEqual(findRecoveryNotices(`preview\n\n${notice}`), [notice]);
        }
      }
    } finally { hook.deregister(); }
  });

  it('does not mistake documentation, malformed counts, or incomplete notices for recovery', () => {
    for (const text of [
      `Example: ${bashNotice}`, '[output truncated; full output: ]',
      'Full formatted result stored at: /tmp/x',
      '(Omitted 123 bytes. Full formatted result stored at: /tmp/x)',
      '(Omitted 9007199254740993 bytes. Full formatted result stored at: /tmp/x. Use read.)',
      `${officialNotice}\nmore output`, JSON.stringify({ data: officialNotice })
    ]) assert.deepEqual(findRecoveryNotices(text), [], text);
  });

  it('reuses upstream notices without either storage backend, even with no retained tail', async () => {
    for (const notice of [bashNotice, officialNotice]) {
      const host = backend();
      const events = [];
      const outcome = await run(blocks(`${raw}\n\n${notice}\n`), {
        context: host.context,
        config: { tailChars: 0, metrics: { enabled: true, onEvent: event => events.push(event) } }
      });
      assert.match(project(outcome.content), /tool output trimmed/);
      assert.ok(project(outcome.content).includes(notice));
      assert.doesNotMatch(project(outcome.content), /full output saved to/);
      assert.equal(host.calls.length, 0);
      assert.equal(fs.existsSync(outcome.directory), false);
      assert.equal(events[0].spillover, 'not-attempted');
      assert.equal(events[0].cleanup, 'not-attempted');
      assert.equal(events[0].outputChars, project(outcome.content).length);
    }
  });

  it('keeps both stdout and stderr paths, downstream content, and non-text blocks', async () => {
    const host = backend();
    const image = { type: 'image', data: 'unchanged' };
    const second = '[output truncated; full output: /tmp/stderr.log]';
    const content = [{ type: 'text', text: `${raw}\n${bashNotice}\n` }, image, { type: 'text', text: `${raw}\n${second}\n[exit code: 1]` }];
    const { content: output, directory } = await run(blocks('original result'), {
      context: host.context, config: { tailChars: 0 }, downstream: { kind: 'accept', content }
    });
    assert.ok(project(output).includes(bashNotice));
    assert.ok(project(output).includes(second));
    assert.ok(output.includes(image));
    assert.equal(host.calls.length, 0);
    assert.equal(fs.existsSync(directory), false);
  });

  it('recognizes notices split across adjacent text blocks', async () => {
    for (const notice of [bashNotice, officialNotice]) {
      const host = backend();
      const { content, directory } = await run([
        { type: 'text', text: `${raw}\n\n${notice.slice(0, 25)}` },
        { type: 'text', text: notice.slice(25) }
      ], { context: host.context, config: { tailChars: 0 } });
      assert.ok(project(content).includes(notice));
      assert.equal(host.calls.length, 0);
      assert.equal(fs.existsSync(directory), false);
    }
  });

  it('keeps existing recovery guidance when new spill writes are disabled', async () => {
    const { content, directory } = await run(blocks(`${raw}\n\n${officialNotice}`), {
      config: { tailChars: 0, spillover: { enabled: false } }
    });
    assert.ok(project(content).includes(officialNotice));
    assert.equal(fs.existsSync(directory), false);
  });

  it('does not treat notice-shaped JSON values as existing recovery metadata', async () => {
    const host = backend();
    const text = JSON.stringify(Array.from({ length: 100 }, () => officialNotice));
    const { content } = await run(blocks(text), {
      context: host.context, config: { thresholdChars: 1000, headChars: 300, tailChars: 300, structuredOutput: { mode: 'summary' } }
    });
    assert.equal(JSON.parse(content[0].text).spilloverPath, ref.locator);
    assert.equal(host.calls.length, 1);
  });

  it('leaves small notice-bearing results unchanged', async () => {
    const host = backend();
    const decision = { kind: 'accept' };
    const { decision: output } = await run(blocks(bashNotice), { context: host.context, downstream: decision });
    assert.equal(output, decision);
    assert.equal(host.calls.length, 0);
  });
});

describe('session-owned spill storage', () => {
  it('awaits saveText with exact original text and session ownership, without a local copy', async () => {
    const host = backend();
    const events = [];
    const image = { type: 'image', data: 'unchanged' };
    const input = [{ type: 'text', text: raw }, image, { type: 'text', text: 'stderr\r\n' }];
    const { content, directory } = await run(input, {
      context: host.context, config: { metrics: { enabled: true, onEvent: event => events.push(event) } }
    });
    assert.deepEqual(host.calls, [{
      owner: { sessionId: 'session-recovery' },
      source: { kind: 'tool', toolName: 'bash', callId: 'call-recovery', label: 'result' },
      suggestedName: 'bash.txt', content: `${raw}stderr\r\n`
    }]);
    assert.ok(project(content).includes(ref.locator));
    assert.ok(project(content).includes(ref.retrievalHint));
    assert.ok(content.includes(image));
    assert.equal(fs.existsSync(directory), false);
    assert.equal(events[0].spillover, 'success');
    assert.equal(events[0].cleanup, 'not-attempted');
  });

  it('uses a directly exposed spillStore capability and saves semantic-only raw text', async () => {
    const host = backend();
    const text = 'On branch main\nnothing to commit, working tree clean';
    const { content, directory } = await run(blocks(text), {
      context: { spillStore: host.store }, execution: { ...exec, arguments: { command: 'git status' } },
      config: { spillover: { onSemanticReduction: true } }
    });
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].content, text);
    assert.equal(content[0].text, 'On branch main: working tree clean');
    assert.ok(content[1].text.includes(ref.locator));
    assert.ok(content[1].text.includes(ref.retrievalHint));
    assert.equal(fs.existsSync(directory), false);
  });

  it('saves raw text before semantic and mechanical reduction with dispatch metadata', async () => {
    const host = backend();
    const dirtyFiles = Array.from({ length: 150 }, (_, i) => `\tmodified:   src/file_${i}.ts\n`).join('');
    const text = `On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n${dirtyFiles}\nno changes added to commit (use "git add" and/or "git commit -a")`;
    const { content } = await run(blocks(text), {
      context: host.context, execution: { ...exec, parent: 'parent-call', arguments: { command: 'git status' } }
    });
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].content, text);
    assert.equal(host.calls[0].source.label, 'dispatch');
    assert.match(project(content), /tool output trimmed/);
    assert.ok(project(content).includes(ref.retrievalHint));
  });

  it('keeps opaque locator and retrieval guidance inside valid structured summary JSON', async () => {
    const host = backend();
    const text = ` \r\n${JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ i, value: '中文😀' })))}\r\n`;
    const { content, directory } = await run(blocks(text), {
      context: host.context, config: { structuredOutput: { mode: 'summary' } }
    });
    const summary = JSON.parse(content[0].text);
    assert.equal(summary.spilloverPath, ref.locator);
    assert.equal(summary.spilloverRetrievalHint, ref.retrievalHint);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].content, text);
    assert.equal(fs.existsSync(directory), false);
  });

  it('retains JSON verbatim if recovery guidance would make its summary larger', async () => {
    const calls = [];
    const text = JSON.stringify(Array.from({ length: 100 }, (_, i) => `item-${i}`));
    const { content } = await run(blocks(text), {
      context: { spillStore: { async saveText(input) { calls.push(input); return { ...ref, retrievalHint: 'x'.repeat(text.length * 2) }; } } },
      config: { structuredOutput: { mode: 'summary' } }
    });
    assert.equal(calls.length, 1);
    assert.equal(content[0].text, text);
  });

  it('falls back to the local writer when the capability or owner is unavailable', async () => {
    for (const options of [
      { context: { get() { return undefined; } } },
      { context: { spillStore: backend().store }, execution: { name: 'bash', callId: 'no-owner' } }
    ]) {
      const { content, directory } = await run(blocks(raw), options);
      const files = fs.readdirSync(directory);
      assert.equal(files.length, 1);
      const saved = path.join(directory, files[0]);
      assert.equal(fs.readFileSync(saved, 'utf8'), raw);
      assert.ok(project(content).includes(saved));
    }
  });

  it('fails open on rejected, throwing, or malformed backend responses without a duplicate write', async () => {
    for (const saveText of [
      async () => { throw new Error('backend unavailable'); },
      () => { throw new Error('backend unavailable'); },
      async () => null,
      async () => ({ locator: 'unusable-without-guidance' })
    ]) {
      const events = [];
      const { content, directory } = await run(blocks(raw), {
        context: { spillStore: { saveText } }, config: { metrics: { enabled: true, onEvent: event => events.push(event) } }
      });
      assert.match(project(content), /tool output trimmed/);
      assert.doesNotMatch(project(content), /full output saved to|\[object Object\]|\[object Promise\]/);
      assert.equal(fs.existsSync(directory), false);
      assert.equal(events[0].spillover, 'failed');
    }
  });

  it('integrates with the installed Cordis context and official local spill backend', async (t) => {
    const cordisPeer = optionalPeer(t, '@deepseek-ai/cordis');
    const storePeer = optionalPeer(t, '@deepseek-ai/dsh-spill-local');
    if (!cordisPeer || !storePeer) return;
    const { Context } = await import(pathToFileURL(cordisPeer).href);
    const { LocalSpillStore } = await import(pathToFileURL(storePeer).href);
    const ctx = new Context();
    const storeRoot = path.join(root, 'official-store');
    try {
      await ctx.plugin(LocalSpillStore, { root: storeRoot, cleanupPeriodDays: 0 });
      const store = ctx.get('spillStore');
      assert.equal(typeof store?.saveText, 'function');
      const { content, directory } = await run(blocks(raw), { context: { get: name => ctx.get(name) } });
      const sessions = fs.readdirSync(storeRoot);
      assert.equal(sessions.length, 1);
      assert.ok(sessions[0].startsWith('session-'));
      const sessionDirectory = path.join(storeRoot, sessions[0]);
      const files = fs.readdirSync(sessionDirectory);
      assert.equal(files.length, 1);
      const saved = path.join(sessionDirectory, files[0]);
      assert.equal(fs.readFileSync(saved, 'utf8'), raw);
      assert.ok(project(content).includes(saved));
      assert.match(project(content), /Use read with offset\/limit/);
      assert.equal(fs.existsSync(directory), false);
    } finally { await ctx.fiber.dispose(); }
  });

  it('performs no storage I/O for disabled spillover, small results, preserved JSON, or over-limit text', async () => {
    for (const [text, config] of [
      [raw, { spillover: { enabled: false } }], ['hello', {}],
      ['\x1b[32mhello\x1b[0m', {}], [JSON.stringify({ log: raw }), {}],
      [raw, { spillover: { maxFileBytes: 500 } }]
    ]) {
      const host = backend();
      const { directory } = await run(blocks(text), { context: host.context, config });
      assert.equal(host.calls.length, 0);
      assert.equal(fs.existsSync(directory), false);
    }
  });
});
