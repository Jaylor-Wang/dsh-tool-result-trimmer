import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trimmer-structured-'));
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-trimmer-structured-'));
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(content, config = {}, exec = { name: 'bash' }, result = {}) {
  let handler;
  apply({ on(_event, fn) { handler = fn; } }, {
    thresholdChars: 500, headChars: 100, tailChars: 100, ...config
  });
  const res = { content, ...result };
  const decision = await handler(exec, res, async () => ({ kind: 'accept' }));
  return decision.content ?? content;
}

const array = Array.from({ length: 80 }, (_, i) => ({ i, value: `中文😀-${i}-` + 'x'.repeat(30) }));
const raw = ` \r\n${JSON.stringify(array)}\n`;

describe('P2 structured output', () => {
  it('preserves complete oversized JSON exactly before semantic reducers', async () => {
    const text = JSON.stringify({ log: 'On branch main\nnothing to commit, working tree clean', data: 'x'.repeat(2000) });
    const input = [{ type: 'text', text }];
    const output = await run(input, {}, { name: 'bash', arguments: { command: 'git status' } });
    assert.equal(output, input);
    assert.deepEqual(JSON.parse(output[0].text), JSON.parse(text));
    assert.equal((await run([{ type: 'text', text: raw }]))[0].text, raw);
  });

  it('summarizes a large top-level array as explicitly marked valid JSON', async () => {
    const output = await run([{ type: 'text', text: raw }], { structuredOutput: { mode: 'summary' } });
    const summary = JSON.parse(output[0].text);
    assert.equal(summary._dshToolResultTrimmer, 'array-summary');
    assert.equal(summary.totalItems, array.length);
    assert.deepEqual(summary.head[0], array[0]);
    assert.deepEqual(summary.tail.at(-1), array.at(-1));
    assert.ok(output[0].text.length < raw.length);
    assert.equal(summary.spilloverPath, null);
  });

  it('preserves objects, empty arrays, small arrays and nested Unicode values', async () => {
    for (const text of [JSON.stringify({ data: array }), '[]', JSON.stringify([[['中文😀']]]), JSON.stringify(['x'.repeat(2000)])]) {
      const output = await run([{ type: 'text', text }], { structuredOutput: { mode: 'summary' } });
      assert.equal(output[0].text, text);
    }
  });

  it('preserves large JSON strings and respects raw ANSI detection', async () => {
    const text = JSON.stringify('x'.repeat(2000));
    assert.equal((await run([{ type: 'text', text }]))[0].text, text);
    const colored = `\x1b[32m${raw}\x1b[0m`;
    assert.match((await run([{ type: 'text', text: colored }]))[0].text, /tool output trimmed/);
  });

  it('does not treat malformed, prefixed, suffixed or concatenated documents as JSON', async () => {
    for (const text of [`[${'x'.repeat(2000)}`, `log\n${raw}`, `${raw}\nlog`, `${raw}\n[]`]) {
      const output = await run([{ type: 'text', text }], { structuredOutput: { mode: 'summary' } });
      assert.match(output[0].text, /tool output trimmed/);
    }
  });

  it('allows the legacy mechanical behavior in off mode', async () => {
    const output = await run([{ type: 'text', text: raw }], { structuredOutput: { mode: 'off' } });
    assert.match(output[0].text, /tool output trimmed/);
    assert.throws(() => JSON.parse(output[0].text));
  });

  it('preserves JSON across multiple text blocks and intervening non-text blocks', async () => {
    const image = { type: 'image', data: 'image' };
    const blocks = [{ type: 'text', text: raw.slice(0, 100) }, image, { type: 'text', text: raw.slice(100) }];
    for (const mode of ['preserve', 'summary']) {
      const output = await run(blocks, { structuredOutput: { mode } });
      assert.equal(output, blocks);
      assert.equal(output[1], image);
    }
  });

  it('records only the spillover path as metadata and saves the exact raw text', async () => {
    const command = 'secret-command-do-not-copy';
    const output = await run([{ type: 'text', text: raw }], {
      structuredOutput: { mode: 'summary' }, spillover: { enabled: true, directory: root }
    }, { name: 'bash', callId: 'structured', arguments: { command } });
    const summary = JSON.parse(output[0].text);
    assert.ok(summary.spilloverPath);
    assert.equal(fs.readFileSync(summary.spilloverPath, 'utf8'), raw);
    assert.equal(summary.spilloverPath.includes(command), false);
    assert.equal(output[0].text.includes(command), false);
    assert.equal(output[0].text.includes(array[40].value), false);
  });

  it('returns the original JSON when summary serialization fails', async (t) => {
    t.mock.method(JSON, 'stringify', () => { throw new Error('serialization failed'); });
    const blocks = [{ type: 'text', text: raw }];
    assert.equal(await run(blocks, { structuredOutput: { mode: 'summary' } }), blocks);
  });

  it('keeps a valid summary when spillover is unavailable', async () => {
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'block');
    const output = await run([{ type: 'text', text: raw }], {
      structuredOutput: { mode: 'summary' }, spillover: { enabled: true, directory: file }
    });
    assert.equal(JSON.parse(output[0].text).spilloverPath, null);
  });

  it('does not corrupt unsafe numeric values in samples', async () => {
    for (const number of ['9007199254740993', '1e400', '0.1234567890123456789', '-0']) {
      const text = `[${number},${Array.from({ length: 80 }, (_, i) => i).join(',')},${number}]`;
      const output = await run([{ type: 'text', text }], {
        thresholdChars: 100, structuredOutput: { mode: 'summary' }
      });
      assert.equal(output[0].text, text);
    }
  });

  it('retains original output if a summary cannot provide savings', async () => {
    const text = JSON.stringify(['x'.repeat(2000)]);
    const output = await run([{ type: 'text', text }], { structuredOutput: { mode: 'summary' } });
    assert.equal(output[0].text, text);
  });

  it('strictly protects failure and uncertain JSON arrays from summary reduction', async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({
      filePath: `/path/to/file_${i}.js`,
      messages: i === 15 ? [{ ruleId: 'no-undef', line: 42, column: 3, message: 'CRITICAL_DIAGNOSTIC' }] : []
    }));
    const rawJson = JSON.stringify(records);
    assert.ok(rawJson.length > 500);

    const failureVariants = [
      { name: 'isError: true', result: { isError: true } },
      { name: 'legacy exitCode: 1', result: { exitCode: 1 } },
      { name: 'legacy status: 2', result: { status: 2 } },
      { name: 'foreground exitCode: 1', result: { value: { kind: 'foreground', exitCode: 1 } } },
      { name: 'foreground timedOut: true', result: { value: { kind: 'foreground', exitCode: 0, timedOut: true } } },
      { name: 'foreground signal: SIGTERM', result: { value: { kind: 'foreground', exitCode: 0, signal: 'SIGTERM' } } },
      { name: 'foreground aborted: true', result: { value: { kind: 'foreground', exitCode: 0, aborted: true } } },
      { name: 'foreground stopped: cancelled', result: { value: { kind: 'foreground', exitCode: 0, stopped: 'cancelled' } } },
      { name: 'foreground sandbox denied', result: { value: { kind: 'foreground', exitCode: 0, sandbox: { denied: true } } } },
      { name: 'foreground sandbox runnerFailed', result: { value: { kind: 'foreground', exitCode: 0, sandbox: { runnerFailed: true } } } },
      { name: 'adapter sandbox runnerFailed', result: { sandbox: { runnerFailed: true } } },
      { name: 'top-level timedOut: true', result: { timedOut: true } },
      { name: 'top-level signal: SIGTERM', result: { signal: 'SIGTERM' } },
      { name: 'top-level failed: true', result: { failed: true } },
      { name: 'status: cancelled', result: { status: 'cancelled' } },
      { name: 'status: unknown', result: { status: 'unknown' } },
      { name: 'promoted background job', result: { value: { kind: 'promoted', output: 'partial' } } }
    ];

    for (const { name: caseName, result } of failureVariants) {
      let emitted = null;
      const output = await run(
        [{ type: 'text', text: rawJson }],
        {
          structuredOutput: { mode: 'summary' },
          metrics: { enabled: true, onEvent: e => { emitted = e; } }
        },
        { name: 'bash', arguments: { command: 'eslint -f json .' } },
        result
      );

      // JSON must remain completely untouched; middle diagnostic must not be lost
      assert.equal(output[0].text, rawJson, `Case failed: ${caseName}`);
      assert.ok(output[0].text.includes('CRITICAL_DIAGNOSTIC'), `Diagnostic lost in ${caseName}`);
      assert.ok(output[0].text.includes('no-undef'), `Rule ID lost in ${caseName}`);

      if (emitted) {
        assert.equal(emitted.structuredSummary, false, `structuredSummary should be false in ${caseName}`);
        assert.equal(emitted.originalChars, emitted.outputChars, `Length mismatch in ${caseName}`);
      }
    }
  });
});
