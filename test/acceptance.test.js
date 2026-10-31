import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';
import { generateSpilloverFilename, pruneSpilloverDirectory, writeSpillover } from '../lib/spillover.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trimmer-acceptance-'));
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-trimmer-acceptance-'));
  fs.rmSync(root, { recursive: true, force: true });
});

function directory(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return dir;
}

function ownedFile(dir, text, ageMs = 0) {
  const file = path.join(dir, generateSpilloverFilename('fixture', text));
  fs.writeFileSync(file, text);
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(file, time, time);
  return file;
}

function handlerFor(config) {
  let handler;
  apply({ on(_event, fn) { handler = fn; } }, config);
  return handler;
}

function recoveryPath(content) {
  const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/full output saved to (.+) \.\.\.\]/);
  assert.ok(match, 'Expected an accessible recovery path');
  return match[1];
}

describe('P0/P1 acceptance regressions', () => {
  it('enforces both quotas on every write and always returns an existing newest file', () => {
    const dir = directory('burst');
    const config = { enabled: true, directory: dir, maxFiles: 2, maxTotalBytes: 2048 };
    for (let i = 0; i < 8; i++) {
      const saved = writeSpillover('x'.repeat(1024), config);
      assert.ok(saved);
      assert.ok(fs.existsSync(saved));
      const files = fs.readdirSync(dir);
      assert.ok(files.length <= 2);
      assert.ok(files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0) <= 2048);
    }
  });

  it('rejects a file above total capacity before any filesystem access', () => {
    const dir = path.join(root, 'too-large');
    assert.equal(writeSpillover('x'.repeat(2048), { enabled: true, directory: dir, maxTotalBytes: 1024 }), null);
    assert.equal(fs.existsSync(dir), false);
  });

  it('cleans directories independently and preserves unrelated files', () => {
    for (const name of ['first', 'second']) {
      const dir = directory(name);
      const expired = ownedFile(dir, 'old', 10000);
      const unrelated = path.join(dir, '.other-tool.tmp-backup');
      const similarLog = path.join(dir, 'trimmed-unrelated.log');
      fs.writeFileSync(unrelated, 'keep');
      fs.writeFileSync(similarLog, 'keep');
      fs.utimesSync(unrelated, new Date(0), new Date(0));
      const saved = writeSpillover('new', { enabled: true, directory: dir, ttlMs: 1000 });
      assert.ok(saved);
      assert.equal(fs.existsSync(expired), false);
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
      assert.equal(fs.readFileSync(similarLog, 'utf8'), 'keep');
    }
  });

  it('only removes stale temporary files with an exact plugin filename', () => {
    const dir = directory('temps');
    const filename = generateSpilloverFilename('old', 'output');
    const tmp = path.join(dir, `.${filename}.tmp-1234abcd`);
    fs.writeFileSync(tmp, 'stale');
    fs.utimesSync(tmp, new Date(0), new Date(0));
    pruneSpilloverDirectory(dir, {}, true);
    assert.equal(fs.existsSync(tmp), false);
  });

  it('bounds directory reads and refuses writes when the scan cannot finish', (t) => {
    const dir = directory('large');
    let reads = 0;
    let closes = 0;
    t.mock.method(fs, 'opendirSync', () => ({
      readSync() {
        reads++;
        return { name: 'unrelated', isFile: () => true };
      },
      closeSync() { closes++; }
    }));
    assert.equal(writeSpillover('output', { enabled: true, directory: dir }), null);
    assert.ok(reads <= 4097, `Read ${reads} directory entries`);
    assert.equal(closes, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('does not write when a required cleanup deletion fails', (t) => {
    const dir = directory('delete-failed');
    const existing = ownedFile(dir, 'old', 10000);
    const unlink = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', function (file) {
      if (file === existing) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return unlink(file);
    });
    assert.equal(writeSpillover('new', { enabled: true, directory: dir, maxFiles: 1 }), null);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), [path.basename(existing)]);
  });

  it('bounds deletions and refuses to add files when cleanup needs more work', (t) => {
    const dir = directory('delete-budget');
    for (let i = 0; i < 140; i++) ownedFile(dir, `old-${i}`, 10000);
    const unlink = fs.unlinkSync;
    let deletions = 0;
    t.mock.method(fs, 'unlinkSync', function (file) {
      if (path.basename(file).startsWith('trimmed-')) deletions++;
      return unlink(file);
    });
    assert.equal(writeSpillover('new', { enabled: true, directory: dir, maxFiles: 1 }), null);
    assert.ok(deletions <= 128);
    assert.ok(fs.readdirSync(dir).length > 1);
  });

  it('retains exact bytes under an independent total-byte eviction limit', () => {
    const dir = directory('byte-budget');
    const config = { enabled: true, directory: dir, maxFiles: 100, maxTotalBytes: 1024 };
    for (let i = 0; i < 5; i++) {
      const raw = '中'.repeat(200);
      const saved = writeSpillover(raw, config);
      assert.equal(fs.readFileSync(saved, 'utf8'), raw);
      assert.equal(fs.readdirSync(dir).length, 1);
    }
  });

  it('returns null on lock contention without removing another writer lock', () => {
    const dir = directory('locked');
    const lock = path.join(dir, '.dsh-trimmer.lock');
    fs.writeFileSync(lock, 'other writer');
    assert.equal(writeSpillover('output', { enabled: true, directory: dir }), null);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'other writer');
  });

  it('removes partial temporary files and releases the lock after write or rename failures', (t) => {
    const dir = directory('atomic-failures');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', function (fd) {
      write(fd, 'partial');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    assert.equal(writeSpillover('complete', { enabled: true, directory: dir }), null);
    assert.deepEqual(fs.readdirSync(dir), []);
    t.mock.restoreAll();
    t.mock.method(fs, 'renameSync', () => { throw new Error('rename denied'); });
    assert.equal(writeSpillover('complete', { enabled: true, directory: dir }), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('does not follow symbolic links when pruning', (t) => {
    const dir = directory('symlinks');
    const outside = path.join(root, 'outside-target');
    fs.writeFileSync(outside, 'preserve');
    const link = path.join(dir, generateSpilloverFilename('link', 'preserve'));
    try { fs.symlinkSync(outside, link, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Creating symlinks requires Windows privileges');
        return;
      }
      throw error;
    }
    pruneSpilloverDirectory(dir, { ttlMs: 1 }, true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  it('coordinates capacity admission across concurrent Node processes', async () => {
    const dir = directory('concurrent');
    const moduleUrl = new URL('../lib/spillover.js', import.meta.url).href;
    const config = { enabled: true, directory: dir, maxFiles: 2, maxTotalBytes: 2048 };
    const script = `import { writeSpillover } from ${JSON.stringify(moduleUrl)}; const config = ${JSON.stringify(config)}; for (let i = 0; i < 12; i++) writeSpillover('x'.repeat(1024), config);`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let errorText = '';
      child.stderr.setEncoding('utf8').on('data', text => { errorText += text; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Child exited ${code}: ${errorText}`)));
      child.stdin.end(script);
    })));
    const files = fs.readdirSync(dir);
    assert.ok(files.length > 0 && files.length <= 2);
    assert.ok(files.every(name => name.startsWith('trimmed-')));
    assert.ok(files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0) <= 2048);
  });

  it('preserves exact multi-block raw text including CRLF, ANSI and Unicode', async () => {
    const dir = directory('path with spaces');
    const text1 = '\x1b[32m' + '中文😀'.repeat(100) + '\x1b[0m\r\n';
    const text2 = '尾部😀'.repeat(100);
    const image = { type: 'image', data: 'sample' };
    const blocks = [{ type: 'text', text: text1 }, image, { type: 'text', text: text2 }];
    const handler = handlerFor({ thresholdChars: 100, headChars: 20, tailChars: 20, spillover: { enabled: true, directory: dir } });
    const decision = await handler({ name: 'custom' }, { content: blocks }, async () => ({ kind: 'accept' }));
    assert.equal(fs.readFileSync(recoveryPath(decision.content), 'utf8'), text1 + text2);
    assert.ok(decision.content.includes(image));
  });

  it('advertises semantic-only recovery only when explicitly enabled', async () => {
    const raw = 'On branch main\nnothing to commit, working tree clean';
    for (const enabled of [false, true]) {
      const dir = directory(`semantic-${enabled}`);
      const handler = handlerFor({ spillover: { enabled: true, directory: dir, onSemanticReduction: enabled } });
      const decision = await handler({ name: 'bash', arguments: { command: 'git status' } }, { content: [{ type: 'text', text: raw }] }, async () => ({ kind: 'accept' }));
      if (enabled) assert.equal(fs.readFileSync(recoveryPath(decision.content), 'utf8'), raw);
      else {
        assert.equal(decision.content[0].text, 'On branch main: working tree clean');
        assert.deepEqual(fs.readdirSync(dir), []);
      }
    }
  });

  it('does no disk I/O for disabled spillover, short outputs or excluded decisions', async (t) => {
    const dir = directory('no-io');
    const handler = handlerFor({ thresholdChars: 100, headChars: 10, tailChars: 10, spillover: { enabled: true, directory: dir } });
    let filesystemCalls = 0;
    const rejectIO = () => { filesystemCalls++; throw new Error('Unexpected filesystem access'); };
    for (const name of ['mkdirSync', 'openSync', 'opendirSync', 'writeFileSync', 'renameSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'unlinkSync']) t.mock.method(fs, name, rejectIO);
    assert.equal(writeSpillover('output', { enabled: false }), null);
    for (const [exec, text, decision] of [
      [{ name: 'bash' }, 'short', { kind: 'accept' }],
      [{ name: 'bash' }, '\x1b[32mshort\x1b[0m', { kind: 'accept' }],
      [{ name: 'read' }, 'x'.repeat(1000), { kind: 'accept' }],
      [{ name: 'bash', arguments: { command: 'echo x # no-trim' } }, 'x'.repeat(1000), { kind: 'accept' }],
      [{ name: 'bash' }, 'x'.repeat(1000), { kind: 'block' }],
      [{ name: 'bash' }, 'x'.repeat(1000), { kind: 'accept', value: {} }]
    ]) await handler(exec, { content: [{ type: 'text', text }] }, async () => decision);
    assert.equal(filesystemCalls, 0);
  });

  it('constructs and validates Config with the installed real Schemastery peer', async (t) => {
    const require = createRequire(import.meta.url);
    let peer;
    try { peer = require.resolve('@deepseek-ai/schemastery'); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      t.skip('Optional Schemastery peer is unavailable; use NODE_PATH to test the host installation');
      return;
    }
    const hook = registerHooks({ resolve(specifier, context, next) {
      return specifier === '@deepseek-ai/schemastery' ? { url: pathToFileURL(peer).href, shortCircuit: true } : next(specifier, context);
    } });
    try {
      const { Config } = await import('../lib/index.js?schema-acceptance');
      assert.equal(typeof Config, 'function');
      assert.equal(Config.type, 'object');
      assert.equal(Config({ spillover: { directory: null } }).spillover.directory ?? null, null);
      assert.equal(Config({ spillover: { directory: 'custom' } }).spillover.directory, 'custom');
      assert.equal(Config({ spillover: { enabled: true } }).spillover.maxFiles, 1000);
      assert.equal(Config({}).metrics.enabled, false);
      assert.equal(Config({ metrics: { enabled: true } }).metrics.enabled, true);
      assert.equal(typeof Config({ metrics: { enabled: true, onEvent() {} } }).metrics.onEvent, 'function');
      assert.throws(() => Config({ metrics: { enabled: 'yes' } }));
      assert.throws(() => Config({ metrics: { onEvent: 'invalid' } }));
      assert.equal(Config({}).semanticReducers.build, true);
      assert.equal(Config({}).semanticReducers.lint, true);
      assert.equal(Config({ semanticReducers: { build: false, lint: false } }).semanticReducers.build, false);
      assert.equal(Config({ semanticReducers: { build: false, lint: false } }).semanticReducers.lint, false);
      assert.throws(() => Config({ semanticReducers: { build: 'invalid' } }));
      assert.throws(() => Config({ semanticReducers: { lint: 'invalid' } }));
      assert.equal(Config({}).structuredOutput.mode, 'preserve');
      assert.equal(Config({ structuredOutput: { mode: 'summary' } }).structuredOutput.mode, 'summary');
      assert.equal(Config({ structuredOutput: { mode: 'off' } }).structuredOutput.mode, 'off');
      assert.throws(() => Config({ structuredOutput: { mode: 'invalid' } }));
      assert.throws(() => Config({ spillover: { directory: 123 } }));
      assert.throws(() => Config({ spillover: { maxTotalBytes: '200000000# comment' } }));
    } finally { hook.deregister(); }
  });
});
