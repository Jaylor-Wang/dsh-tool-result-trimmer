import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { commandContext, commandTokens } from '../lib/reducers/command.js';
import { commandRecognitionSamples } from './fixtures/command-recognition.js';

const exec = (command, workdir) => ({ name: 'bash', arguments: { command, ...(workdir === undefined ? {} : { workdir }) } });
const success = { value: { kind: 'foreground', exitCode: 0 } };

describe('Literal command wrappers', () => {
  it('hits every replay sample with metrics enabled and preserves reducer opt-outs', async () => {
    const events = [];
    let handler;
    apply({ on(_event, fn) { handler = fn; } }, {
      spillover: { enabled: false }, metrics: { enabled: true, onEvent: event => events.push(event) }
    });
    for (const sample of commandRecognitionSamples) {
      const result = { ...success, content: [{ type: 'text', text: sample.text }] };
      await handler({ name: 'bash', arguments: sample.arguments }, result, async () => ({ kind: 'accept' }));
      assert.equal(events.at(-1).reducer, sample.reducer, `${sample.form}: ${sample.command}`);
      let disabled;
      apply({ on(_event, fn) { disabled = fn; } }, { semanticReducers: { [sample.reducer]: false }, spillover: { enabled: false } });
      const unchanged = await disabled({ name: 'bash', arguments: sample.arguments }, result, async () => ({ kind: 'accept' }));
      assert.equal(unchanged.content, undefined);
    }
    assert.equal(events.length, 20);
    assert.equal(events.filter(event => event.semanticReduced).length, 20);
  });

  it('resolves relative cd against the supplied POSIX or Windows workdir without process cwd', () => {
    assert.deepEqual(commandContext(exec('cd "packages/my app" && git status 2>&1', '/workspace/repo')), {
      tokens: ['git', 'status'], workdir: '/workspace/repo/packages/my app'
    });
    assert.equal(commandContext(exec('cd ../app && git status', 'E:\\repo\\packages')).workdir, 'E:\\repo\\app');
    assert.equal(commandContext(exec("cd 'E:\\repo with spaces' && git status", 'E:\\other')).workdir, 'E:\\repo with spaces');
    assert.equal(commandContext(exec('cd "E:\\repo with spaces" && git status', 'E:\\other')).workdir, 'E:\\repo with spaces');
    assert.equal(commandContext(exec('git status', '/workspace/repo')).workdir, '/workspace/repo');
    assert.equal(commandContext(exec('cd project && git status')).workdir, 'project');
    assert.equal(commandContext(exec('cd /absolute && git status')).workdir, '/absolute');
  });

  it('accepts literal cd, environment assignments and known exec wrappers', () => {
    for (const command of [
      'git status 2>&1', 'cd app && git status', 'cd --literal && git status',
      'cd "a && b" && git status 2>&1', "cd 'a b' && CI=1 git.exe status 2>&1",
      'cd app&&git status 2>&1', 'cd app && pnpm --filter web exec git status 2>&1'
    ]) {
      if (command.includes('--literal')) assert.equal(commandTokens(exec(command)), null);
      else assert.deepEqual(commandTokens(exec(command)), ['git', 'status'], command);
    }
  });

  it('rejects additional commands, expansions, redirects, quoted examples and ambiguous cd', () => {
    for (const command of [
      'git status && git log -1', 'cd app && git status && echo next', 'cd app; git status',
      'cd app || git status', 'cd a && cd b && git status', 'git status 2>&1 | tee log',
      'git status > output 2>&1', 'git status 2>&1; true', 'git status 2>&1 2>&1',
      'git status 12>&1', 'git status 2>&10', 'cd - && git status', 'cd && git status',
      'cd a b && git status', 'cd "$ROOT" && git status', 'cd $(pwd) && git status',
      'cd ~/repo && git status', 'cd app* && git status', 'cd a\\ b && git status',
      'echo "git status"', 'git "status 2>&1"', 'cd "unterminated && git status',
      'git status\necho next', 'git status 2>&1\n', 'cd app && git status # example'
    ]) assert.equal(commandTokens(exec(command, '/workspace')), null, command);
    assert.equal(commandTokens(exec('git status', {})), null);
  });

  it('protects failed execution and diagnostics after an accepted wrapper', async () => {
    for (const extra of [{ value: { kind: 'foreground', exitCode: 1 } }, { isError: true }]) {
      let handler;
      apply({ on(_event, fn) { handler = fn; } }, { spillover: { enabled: false } });
      const text = 'On branch main\nnothing to commit, working tree clean\n';
      const result = { ...extra, content: [{ type: 'text', text }] };
      const decision = await handler(exec('cd app && git status 2>&1', '/workspace'), result, async () => ({ kind: 'accept' }));
      assert.equal(decision.content, undefined);
    }
  });
});
