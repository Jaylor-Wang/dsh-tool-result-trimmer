import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { resolveToolOptions } from '../lib/tool-options.js';

const defaults = { stripAnsi: true, thresholdChars: 10000, headChars: 1500, tailChars: 5000 };
const text = 'H'.repeat(6000) + 'M'.repeat(8000) + 'T'.repeat(6000);

async function run(name, config = {}) {
  let handler;
  apply({ on(_event, fn) { handler = fn; } }, { spillover: { enabled: false }, ...config });
  const content = [{ type: 'text', text }];
  const decision = await handler({ name }, { content }, async () => ({ kind: 'accept' }));
  return decision.content ?? content;
}

describe('Tool-specific head and tail defaults', () => {
  it('keeps bash and unknown tools tail-heavy while web and MCP tools are head-heavy', async () => {
    for (const name of ['bash', 'custom', 'webhook', 'mcpish']) {
      const output = (await run(name))[0].text;
      assert.ok(output.startsWith('H'.repeat(1500) + '\n\n['), name);
      assert.ok(output.endsWith('\n\n' + 'T'.repeat(5000)), name);
    }
    for (const name of ['web', 'web_fetch', 'web-search', 'web.run', 'fetch', 'mcp__server__search', 'mcp.server.search']) {
      const output = (await run(name))[0].text;
      assert.ok(output.startsWith('H'.repeat(5000) + '\n\n['), name);
      assert.ok(output.endsWith('\n\n' + 'T'.repeat(1500)), name);
    }
  });

  it('preserves total global budget and gives explicit tool values priority including zero', () => {
    const global = { ...defaults, headChars: 200, tailChars: 800 };
    assert.deepEqual(resolveToolOptions('web', global), { ...global, headChars: 800, tailChars: 200 });
    assert.deepEqual(resolveToolOptions('web', global, { headChars: 0, tailChars: 900, stripAnsi: false }), {
      ...global, headChars: 0, tailChars: 900, stripAnsi: false
    });
    assert.deepEqual(resolveToolOptions('web', { ...global, headChars: 800, tailChars: 200 }), {
      ...global, headChars: 800, tailChars: 200
    });
  });

  it('honors partial overrides and permits handing a web or MCP tool to the host policy', async () => {
    const output = (await run('web_fetch', { overrides: { web_fetch: { headChars: 100 } } }))[0].text;
    assert.ok(output.startsWith('H'.repeat(100) + '\n\n['));
    assert.ok(output.endsWith('\n\n' + 'T'.repeat(1500)));
    for (const name of ['web_fetch', 'mcp__server__search']) {
      assert.equal((await run(name, { overrides: { [name]: { enabled: false } } }))[0].text, text);
    }
  });

  it('keeps read excluded and warns against the same effective budgets it uses', async () => {
    assert.equal((await run('read'))[0].text, text);
    const warnings = [];
    apply({ on() {}, logger: { warn(message) { warnings.push(message); } } }, {
      overrides: { web_fetch: { thresholdChars: 2000, headChars: 100 } }
    });
    assert.deepEqual(warnings, []);
  });
});
