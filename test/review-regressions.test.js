import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { applySemanticReducers, reduceBuild, reduceGit, reducePackageManager, reduceTestOutput } from '../lib/reducers/index.js';
import { commandTokens } from '../lib/reducers/command.js';

const exec = command => ({ name: 'bash', arguments: { command } });
const success = { value: { kind: 'foreground', exitCode: 0 } };
const cleanGit = 'On branch main\nnothing to commit, working tree clean\n';
const vite = 'transforming...\n⠋ KEEP_CHILD_LOG\n✓ built in 1s\n';

async function run(command, text, config = {}) {
  let handler;
  apply({ on(_event, fn) { handler = fn; } }, config);
  const content = [{ type: 'text', text }];
  const decision = await handler(exec(command), { ...success, content }, async () => ({ kind: 'accept' }));
  return decision.content ?? content;
}

describe('Final independent review regressions', () => {
  it('preserves all output from shell chains and quoted command examples', async () => {
    for (const command of ['git status && git log -1', 'git status; node missing.js; true', 'echo "git status"']) {
      const text = `${cleanGit}commit abc123\nError: KEEP_DIAGNOSTIC\n[exit code: 0]\n`;
      assert.equal(reduceGit(exec(command), text, success), null, command);
      assert.equal((await run(command, text))[0].text, text, command);
    }
  });

  it('preserves unknown clean-status lines and stderr while retaining exact status markers', async () => {
    for (const extra of ['KEEP_UNKNOWN_OUTPUT\n', '[stderr]\nError: KEEP_DIAGNOSTIC\n']) {
      const text = cleanGit + extra;
      assert.equal((await run('git status', text))[0].text, text);
    }
    const text = cleanGit.replace(/\n/g, '\r\n') + '[exit code: 0]\r\n';
    const output = (await run('git.exe status', text))[0].text;
    assert.ok(output.includes('working tree clean'));
    assert.ok(output.endsWith('[exit code: 0]\r\n'));
  });

  it('does not summarize cancellations, cross markers, or inconsistent test counters', async () => {
    const summary = 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n';
    for (const text of [
      summary.replace('pass 2', 'pass 1').replace('cancelled 0', 'cancelled 1') + 'KEEP_CANCELLATION_REASON\n',
      '✖ cancelled test\nKEEP_CANCELLATION_REASON\n' + summary,
      summary.replace('pass 2', 'pass 1'),
      summary.replace('fail 0', 'fail 01'),
      summary + 'Error: KEEP_DIAGNOSTIC\n',
      'Tests 1 passed (2)\n'
    ]) {
      assert.equal(reduceTestOutput(exec('node --test'), text, success), null, text);
      assert.equal((await run('node --test; true', text))[0].text, text);
    }
  });

  it('does not summarize mixed test commands after a successful first run', async () => {
    const text = 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nKEEP_NEXT_COMMAND_OUTPUT\n';
    assert.equal((await run('node --test && echo next', text))[0].text, text);
  });

  it('preserves diagnostic progress bars in default plugin results', async () => {
    for (const diagnostic of [
      '[======] warning: src/file.ts:42:3 KEEP_DIAGNOSTIC',
      '[======] error: KEEP_DIAGNOSTIC',
      '[======] /tmp/config.json',
      '[======] KEEP_UNKNOWN_OUTPUT',
      'npm notice warning: KEEP_DIAGNOSTIC'
    ]) {
      const text = `[====================] 100%\r\n${diagnostic}\r\nadded 2 packages\r\n`;
      const output = (await run('npm install', text))[0].text;
      assert.ok(output.includes(diagnostic), diagnostic);
      assert.ok(!output.includes('[====================] 100%'));
    }
  });

  it('preserves paths and unknown spinner lines while deleting recognized progress', () => {
    for (const detail of ['/tmp/config.json', '/home/user/src/index.js', String.raw`C:\repo\src\index.js`, String.raw`\\server\share\file.js`, './src/file.js', 'src/file.js', 'KEEP_UNKNOWN_OUTPUT']) {
      const line = `⠋ ${detail}\r\n`;
      const text = `⠋ fetching packages...\r\n${line}added 2 packages\r\n`;
      const output = reducePackageManager(exec('npm install'), text, success);
      assert.ok(output?.includes(line), detail);
      assert.ok(!output.includes('fetching packages'));
    }
  });

  it('preserves POSIX, Windows and relative paths in webpack progress', () => {
    for (const detail of ['/home/user/src/index.js', '/tmp/config.json', '/tmp/中文.js', String.raw`C:\repo\src\index.js`, String.raw`\\server\share\file.js`, './src/index.js', 'src/index.js']) {
      const line = `<s> [webpack.Progress] 10% building ${detail}\r\n`;
      const text = `10% building\r\n${line}webpack 5.112.2 compiled successfully in 100 ms\r\n`;
      const output = reduceBuild(exec('webpack --progress'), text, success);
      assert.equal(output, text.replace('10% building\r\n', ''), detail);
    }
  });

  it('routes wrappers with option values without bypassing build opt-out', async () => {
    for (const command of [
      'pnpm --filter web exec vite build',
      'pnpm --filter=web exec vite build',
      'npm --prefix packages/app exec vite build',
      'npm exec --package vite vite build',
      'npm --package vite exec -- vite build',
      'npx -p vite vite build',
      'npx --package=vite vite build'
    ]) {
      assert.deepEqual(commandTokens(exec(command)), ['vite', 'build'], command);
      const enabled = applySemanticReducers(exec(command), vite, success);
      assert.equal(enabled.reducerName, 'build', command);
      assert.ok(enabled.text.includes('KEEP_CHILD_LOG'), command);
      const config = { semanticReducers: { build: false } };
      assert.deepEqual(applySemanticReducers(exec(command), vite, success, config), { reduced: false, text: vite }, command);
      assert.equal((await run(command, vite, config))[0].text, vite, command);
    }
  });

  it('preserves unknown wrapper options, scripts and ambiguous call modes', async () => {
    for (const command of [
      'pnpm --mystery web exec vite build',
      'npx --mystery vite build',
      'npm exec --package',
      'npx --package',
      'npm exec --call vite build',
      'npm --prefix packages/app run build',
      'yarn vite build',
      'npm install && echo done'
    ]) {
      assert.equal((await run(command, vite))[0].text, vite, command);
    }
  });
});
