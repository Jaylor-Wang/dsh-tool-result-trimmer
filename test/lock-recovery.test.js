import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { generateSpilloverFilename, pruneSpilloverDirectory, writeSpillover } from '../lib/spillover.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trimmer-lock-recovery-'));
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dsh-trimmer-lock-recovery-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
assert.equal(exited.status, 0);
const deadPid = Number(exited.stdout);
assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
const token = 'a'.repeat(32);
const owner = pid => JSON.stringify({ pid, token });
function fixture(name, content) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const lock = path.join(dir, '.dsh-trimmer.lock');
  if (content !== undefined) fs.writeFileSync(lock, content);
  return { dir, lock, config: { enabled: true, directory: dir } };
}

describe('Abandoned spill lock recovery', () => {
  it('writes the PID and unique ownership token while holding the lock', (t) => {
    const { dir, lock, config } = fixture('metadata');
    const opendir = fs.opendirSync;
    let observed;
    t.mock.method(fs, 'opendirSync', target => {
      observed = JSON.parse(fs.readFileSync(lock, 'utf8'));
      return opendir(target);
    });
    assert.ok(writeSpillover('output', config));
    assert.equal(observed.pid, process.pid);
    assert.match(observed.token, /^[a-f0-9]{32}$/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.readdirSync(dir).length, 1);
  });

  it('reclaims a dead owner on the next write and on explicit cleanup', () => {
    const { dir, lock, config } = fixture('dead', owner(deadPid));
    assert.ok(writeSpillover('complete output', config));
    assert.equal(fs.existsSync(lock), false);
    fs.writeFileSync(lock, owner(deadPid));
    const expired = path.join(dir, generateSpilloverFilename('expired', 'old'));
    fs.writeFileSync(expired, 'old');
    fs.utimesSync(expired, new Date(0), new Date(0));
    pruneSpilloverDirectory(dir, { ttlMs: 1000 });
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(lock), false);
    assert.ok(fs.readdirSync(dir).every(name => name.endsWith('.log')));
  });

  it('recovers metadata left by an actual writer process exiting inside the critical section', () => {
    const { lock, config } = fixture('crashed-writer');
    const moduleUrl = new URL('../lib/spillover.js', import.meta.url).href;
    const script = `import fs from 'node:fs'; import { writeSpillover } from ${JSON.stringify(moduleUrl)}; fs.opendirSync = () => process.exit(23); writeSpillover('interrupted', ${JSON.stringify(config)});`;
    const child = spawnSync(process.execPath, ['--input-type=module'], { input: script, encoding: 'utf8' });
    assert.equal(child.status, 23, child.stderr);
    const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.ok(previous.pid > 0 && previous.pid !== process.pid);
    assert.match(previous.token, /^[a-f0-9]{32}$/);
    assert.ok(writeSpillover('recovered', config));
    assert.equal(fs.existsSync(lock), false);
  });

  it('preserves old live locks and malformed or incomplete metadata', () => {
    const values = [owner(process.pid), '', 'legacy lock', '{}', 'null',
      JSON.stringify({ pid: 0, token }), JSON.stringify({ pid: -1, token }),
      JSON.stringify({ pid: 2147483648, token }), JSON.stringify({ pid: String(deadPid), token }),
      JSON.stringify({ pid: deadPid, token: '../unexpected' }), 'x'.repeat(257)];
    for (const [index, value] of values.entries()) {
      const { lock, config } = fixture(`preserve-${index}`, value);
      fs.utimesSync(lock, new Date(0), new Date(0));
      assert.equal(writeSpillover('output', config), null);
      assert.equal(fs.readFileSync(lock, 'utf8'), value);
    }
  });

  it('preserves an owner whose existence cannot be checked', (t) => {
    const { lock, config } = fixture('unknown', owner(deadPid));
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    assert.equal(writeSpillover('output', config), null);
    assert.equal(fs.readFileSync(lock, 'utf8'), owner(deadPid));
  });

  it('never removes a replacement lock when another contender has already recovered it', (t) => {
    const { lock, config } = fixture('replacement', owner(deadPid));
    const link = fs.linkSync;
    const replacement = JSON.stringify({ pid: process.pid, token: 'b'.repeat(32) });
    t.mock.method(fs, 'linkSync', (source, target) => {
      if (source !== lock) return link(source, target);
      assert.equal(source, lock);
      assert.equal(target, `${lock}.reap-${token}`);
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, replacement);
      return link(source, target);
    });
    assert.equal(writeSpillover('output', config), null);
    assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
    assert.equal(fs.existsSync(`${lock}.reap-${token}`), false);
  });

  it('degrades safely if the filesystem cannot coordinate recovery', (t) => {
    const { lock, config } = fixture('link-failed', owner(deadPid));
    t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
    assert.equal(writeSpillover('output', config), null);
    assert.equal(fs.readFileSync(lock, 'utf8'), owner(deadPid));
  });

  it('recovers an abandoned lock under concurrent writers without exceeding quotas', async () => {
    const { dir, config } = fixture('concurrent', owner(deadPid));
    const limits = { ...config, maxFiles: 2, maxTotalBytes: 2048 };
    const moduleUrl = new URL('../lib/spillover.js', import.meta.url).href;
    const script = `import { writeSpillover } from ${JSON.stringify(moduleUrl)}; const config = ${JSON.stringify(limits)}; for (let i = 0; i < 20; i++) writeSpillover('x'.repeat(1024), config);`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Child exited ${code}: ${stderr}`)));
      child.stdin.end(script);
    })));
    const files = fs.readdirSync(dir);
    assert.ok(files.length > 0 && files.length <= 2);
    assert.ok(files.every(name => name.startsWith('trimmed-')));
    assert.ok(files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0) <= 2048);
  });
});
