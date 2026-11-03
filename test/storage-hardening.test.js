import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { repairSpilloverLock, writeSpillover } from '../lib/spillover.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-storage-hardening-'));
after(() => {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('dsh-storage-hardening-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const moduleUrl = new URL('../lib/spillover.js', import.meta.url).href;
const token = 'a'.repeat(32);
const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
assert.equal(dead.status, 0);
const deadPid = Number(dead.stdout);
assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
function fixture(name, metadata) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const lock = path.join(directory, '.dsh-trimmer.lock');
  if (metadata !== undefined) fs.writeFileSync(lock, metadata);
  return { directory, lock };
}
function child(script) {
  return spawnSync(process.execPath, ['--input-type=module'], { input: script, encoding: 'utf8' });
}
function crash(config, setup) {
  const result = child(`import fs from 'node:fs'; import { writeSpillover } from ${JSON.stringify(moduleUrl)}; ${setup}; writeSpillover('interrupted', ${JSON.stringify(config)});`);
  assert.equal(result.status, 23, result.stderr);
}
function observation() { return { cleanupDeleted: 0, spilloverReason: null }; }

describe('atomic lock publication and offline repair', () => {
  it('does not publish an empty lock when the writer exits before writing metadata', () => {
    const config = fixture('before-metadata');
    crash(config, 'fs.writeFileSync = () => process.exit(23)');
    assert.equal(fs.existsSync(config.lock), false);
    const snapshot = repairSpilloverLock(config.directory);
    assert.equal(snapshot.artifacts.length, 1);
    assert.equal(snapshot.artifacts[0].status, 'dead');
    assert.ok(writeSpillover('next writer', config));
  });

  it('does not publish a lock when the writer exits after metadata but before publication', () => {
    const config = fixture('before-publication');
    crash(config, 'fs.linkSync = () => process.exit(23)');
    assert.equal(fs.existsSync(config.lock), false);
    assert.ok(writeSpillover('next writer', config));
  });

  it('recovers a lock after publication even if its candidate name remains', () => {
    const config = fixture('after-publication');
    crash(config, 'const link = fs.linkSync; fs.linkSync = (...args) => { link(...args); process.exit(23); }');
    const owner = JSON.parse(fs.readFileSync(config.lock, 'utf8'));
    assert.ok(owner.pid > 0);
    assert.match(owner.token, /^[a-f0-9]{32}$/);
    assert.ok(writeSpillover('next writer', config));
    const inspection = repairSpilloverLock(config.directory);
    assert.equal(inspection.artifacts.length, 1);
    assert.equal(repairSpilloverLock(config.directory, { apply: true, writersStopped: true, fingerprint: inspection.fingerprint }).status, 'repaired');
  });

  it('diagnoses a crashed reaper and repairs its exact artifacts offline', () => {
    const config = fixture('crashed-reaper', JSON.stringify({ pid: deadPid, token }));
    crash(config, 'const link = fs.linkSync; fs.linkSync = (source, target) => { link(source, target); if (target.includes(".reap-")) process.exit(23); }');
    const state = observation();
    assert.equal(writeSpillover('blocked', config, undefined, state), null);
    assert.equal(state.spilloverReason, 'lock-recovery-blocked');
    const log = path.join(config.directory, 'unrelated.log');
    fs.writeFileSync(log, 'preserve');
    const inspection = repairSpilloverLock(config.directory);
    const result = repairSpilloverLock(config.directory, { apply: true, writersStopped: true, fingerprint: inspection.fingerprint });
    assert.equal(result.status, 'repaired');
    assert.equal(result.removed, 3);
    assert.equal(fs.readFileSync(log, 'utf8'), 'preserve');
    assert.ok(writeSpillover('recovered', config));
  });

  it('inspects invalid locks without changing them and requires both repair guards', () => {
    for (const [index, metadata] of ['', 'broken metadata'].entries()) {
      const config = fixture(`legacy-${index}`, metadata);
      const inspection = repairSpilloverLock(config.directory);
      assert.equal(inspection.status, 'inspected');
      assert.equal(inspection.artifacts[0].status, 'invalid');
      assert.equal(fs.readFileSync(config.lock, 'utf8'), metadata);
      assert.equal(repairSpilloverLock(config.directory, { apply: true, fingerprint: inspection.fingerprint }).reason, 'writers-not-stopped');
      assert.equal(repairSpilloverLock(config.directory, { apply: true, writersStopped: true }).reason, 'snapshot-changed');
      assert.equal(repairSpilloverLock(config.directory, { apply: true, writersStopped: true, fingerprint: inspection.fingerprint }).removed, 1);
    }
  });

  it('refuses live and unknown owners, changed snapshots and non-file artifacts', (t) => {
    const live = fixture('live', JSON.stringify({ pid: process.pid, token }));
    const inspection = repairSpilloverLock(live.directory);
    assert.equal(repairSpilloverLock(live.directory, { apply: true, writersStopped: true, fingerprint: inspection.fingerprint }).reason, 'owner-active-or-unknown');
    const changed = fixture('changed', '');
    const before = repairSpilloverLock(changed.directory);
    fs.writeFileSync(changed.lock, 'new generation');
    assert.equal(repairSpilloverLock(changed.directory, { apply: true, writersStopped: true, fingerprint: before.fingerprint }).reason, 'snapshot-changed');
    assert.equal(fs.readFileSync(changed.lock, 'utf8'), 'new generation');
    const nonFile = fixture('non-file');
    fs.mkdirSync(nonFile.lock);
    const snapshot = repairSpilloverLock(nonFile.directory);
    assert.equal(repairSpilloverLock(nonFile.directory, { apply: true, writersStopped: true, fingerprint: snapshot.fingerprint }).reason, 'owner-active-or-unknown');
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    const unknown = repairSpilloverLock(live.directory);
    assert.equal(repairSpilloverLock(live.directory, { apply: true, writersStopped: true, fingerprint: unknown.fingerprint }).reason, 'owner-active-or-unknown');
  });

  it('bounds offline inspection and preserves unrelated candidate-like filenames', (t) => {
    const config = fixture('inspect-limit', '');
    const unrelated = path.join(config.directory, '.dsh-trimmer.lock.candidate-unrelated');
    fs.writeFileSync(unrelated, 'preserve');
    const inspection = repairSpilloverLock(config.directory);
    assert.equal(inspection.artifacts.length, 1);
    const result = repairSpilloverLock(config.directory, { apply: true, writersStopped: true, fingerprint: inspection.fingerprint });
    assert.equal(result.removed, 1);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
    let reads = 0;
    t.mock.method(fs, 'opendirSync', () => ({ readSync() { reads++; return { name: 'unrelated' }; }, closeSync() {} }));
    assert.equal(repairSpilloverLock(config.directory).reason, 'scan-limit');
    assert.equal(reads, 4097);
  });

  it('reports partial offline repair accurately when deletion fails', (t) => {
    const config = fixture('repair-partial', '');
    const claim = `${config.lock}.reap-${token}`;
    fs.linkSync(config.lock, claim);
    const inspection = repairSpilloverLock(config.directory);
    const unlink = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', target => {
      if (target === claim) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return unlink(target);
    });
    const result = repairSpilloverLock(config.directory, { apply: true, writersStopped: true, fingerprint: inspection.fingerprint });
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'storage-io');
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(claim), true);
  });

  it('ships a CLI that inspects by default and repairs only with a matching fingerprint', () => {
    const config = fixture('cli directory with spaces', '');
    const script = fileURLToPath(new URL('../scripts/spill-lock.js', import.meta.url));
    const inspect = spawnSync(process.execPath, [script, '--directory', config.directory], { encoding: 'utf8' });
    assert.equal(inspect.status, 0, inspect.stderr);
    const snapshot = JSON.parse(inspect.stdout);
    assert.equal(fs.existsSync(config.lock), true);
    const refused = spawnSync(process.execPath, [script, '--directory', config.directory, '--apply'], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    const repaired = spawnSync(process.execPath, [script, '--directory', config.directory, '--apply', '--writers-stopped', '--fingerprint', snapshot.fingerprint], { encoding: 'utf8' });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(JSON.parse(repaired.stdout).removed, 1);
  });
});

async function pipeline(config = {}, context = {}, execution = {}) {
  let handler;
  const events = [];
  apply({ on(_event, fn) { handler = fn; }, ...context }, {
    thresholdChars: 200, headChars: 40, tailChars: 40,
    metrics: { enabled: true, onEvent: event => events.push(event) }, ...config
  });
  const invoke = () => handler({ name: 'bash', callId: 'secret-id', arguments: { command: 'secret-command' }, ...execution },
    { content: [{ type: 'text', text: 'secret-output\n'.repeat(100) }] }, async () => ({ kind: 'accept' }));
  return { invoke, events };
}

describe('storage failure diagnostics and backend measurements', () => {
  it('distinguishes invalid locks, busy locks, scan limits, quota and disk failures', (t) => {
    const invalid = fixture('reason-invalid', '');
    const busy = fixture('reason-busy', JSON.stringify({ pid: process.pid, token }));
    for (const [config, reason] of [[invalid, 'lock-invalid'], [busy, 'lock-busy'], [{ ...invalid, maxFiles: 0 }, 'invalid-config'], [{ ...invalid, maxFileBytes: 1 }, 'file-too-large'], [{ ...invalid, maxTotalBytes: 1 }, 'capacity']]) {
      const state = observation();
      assert.equal(writeSpillover('output', config, undefined, state), null);
      assert.equal(state.spilloverReason, reason);
    }
    const disk = fixture('reason-disk');
    const blocked = path.join(disk.directory, 'file');
    fs.writeFileSync(blocked, 'x');
    const state = observation();
    assert.equal(writeSpillover('output', { directory: blocked }, undefined, state), null);
    assert.equal(state.spilloverReason, 'storage-io');
    const scan = fixture('reason-scan');
    t.mock.method(fs, 'opendirSync', () => ({ readSync: () => ({ name: 'unrelated', isFile: () => true }), closeSync() {} }));
    const overflow = observation();
    assert.equal(writeSpillover('output', scan, undefined, overflow), null);
    assert.equal(overflow.spilloverReason, 'scan-limit');
  });

  it('reports unsupported publication without leaving a partial lock', (t) => {
    const config = fixture('unsupported-publication');
    t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
    const state = observation();
    assert.equal(writeSpillover('output', config, undefined, state), null);
    assert.equal(state.spilloverReason, 'lock-unsupported');
    assert.deepEqual(fs.readdirSync(config.directory), []);
  });

  it('reports cleanup limits and fresh temporary-file capacity separately', () => {
    const config = fixture('cleanup-limit');
    // Use genuine saved names, then age the files so the bounded sweep is exercised.
    for (let i = 0; i < 130; i++) {
      const saved = writeSpillover(`old-${i}`, config);
      assert.ok(saved);
    }
    for (const name of fs.readdirSync(config.directory)) fs.utimesSync(path.join(config.directory, name), new Date(0), new Date(0));
    const state = observation();
    assert.equal(writeSpillover('output', { ...config, maxFiles: 1 }, undefined, state), null);
    assert.equal(state.spilloverReason, 'cleanup-limit');
    const fresh = fixture('fresh-temp-capacity');
    const saved = writeSpillover('old', fresh);
    const temporary = path.join(fresh.directory, `.${path.basename(saved)}.tmp-1234abcd`);
    fs.renameSync(saved, temporary);
    const capacity = observation();
    assert.equal(writeSpillover('output', { ...fresh, maxFiles: 1 }, undefined, capacity), null);
    assert.equal(capacity.spilloverReason, 'capacity');
    assert.equal(fs.existsSync(temporary), true);
  });

  it('rate limits each reason even with metrics disabled and logs no sensitive values', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const config = fixture('rate-limit', '');
    const warnings = [];
    const { invoke, events } = await pipeline({ spillover: config, metrics: { enabled: false } }, { logger: { warn: (...args) => warnings.push(args) } });
    await invoke();
    await invoke();
    t.mock.timers.tick(120000);
    await invoke();
    assert.equal(warnings.length, 1, 'Wall clock jumps must not reset monotonic rate limits');
    assert.deepEqual(warnings[0][1], { reason: 'lock-invalid', backend: 'local' });
    assert.equal(events.length, 0);
    const text = JSON.stringify(warnings);
    for (const secret of ['secret-output', 'secret-command', 'secret-id', config.directory]) assert.equal(text.includes(secret), false);
    const disabled = await pipeline({ spillover: config, diagnostics: { enabled: false } }, { logger: { warn() { throw new Error('must not log'); } } });
    await disabled.invoke();
    assert.equal(disabled.events[0].spilloverReason, 'lock-invalid');
  });

  it('resumes diagnostics after the configured monotonic interval and isolates logger failures', async () => {
    const config = fixture('short-interval', '');
    let calls = 0;
    const { invoke } = await pipeline({ spillover: config, diagnostics: { intervalMs: 1 } }, { logger: { warn() { calls++; return Promise.reject(new Error('secret failure')); } } });
    await invoke();
    await new Promise(resolve => setTimeout(resolve, 5));
    await invoke();
    assert.equal(calls, 2);
    const throwing = await pipeline({ spillover: config }, { logger: { warn() { throw new Error('failure'); } } });
    assert.equal((await throwing.invoke()).kind, 'accept');
  });

  it('ignores inaccessible diagnostic configuration without changing tool results', async () => {
    const config = fixture('diagnostics-config', '');
    const diagnostics = { get enabled() { throw new Error('inaccessible'); } };
    const { invoke, events } = await pipeline({ spillover: config, diagnostics }, { logger: { warn() { throw new Error('must not log'); } } });
    assert.equal((await invoke()).kind, 'accept');
    assert.equal(events[0].spilloverReason, 'lock-invalid');
  });

  it('measures local fallback choice and session success or failure without a second write', async () => {
    const local = fixture('local-metrics');
    const noStore = await pipeline({ spillover: local });
    await noStore.invoke();
    assert.equal(noStore.events[0].spilloverBackend, 'local');
    assert.equal(noStore.events[0].spilloverFallbackReason, 'missing-store');
    assert.equal(noStore.events[0].spilloverReason, null);
    assert.ok(noStore.events[0].spilloverDurationMs > 0);
    const source = fixture('source-metrics');
    const noSource = await pipeline({ spillover: source }, { spillStore: { saveText() { throw new Error('must not use'); } } });
    await noSource.invoke();
    assert.equal(noSource.events[0].spilloverFallbackReason, 'missing-source');
    for (const [index, saveText, reason] of [
      [0, async () => ({ locator: 'spill://hidden', retrievalHint: 'read hidden' }), null],
      [1, async () => { throw new Error('secret backend error'); }, 'backend-error'],
      [2, async () => ({}), 'backend-response']
    ]) {
      const directory = path.join(root, `session-${index}`);
      const { invoke, events } = await pipeline({ spillover: { directory } }, { spillStore: { saveText } }, { agent: { session: { header: { id: 'secret-session' } } } });
      await invoke();
      assert.equal(events[0].spilloverBackend, 'session');
      assert.equal(events[0].spilloverFallbackReason, null);
      assert.equal(events[0].spilloverReason, reason);
      assert.ok(events[0].spilloverDurationMs >= 0);
      assert.equal(fs.existsSync(directory), false);
      for (const secret of ['hidden', 'secret-session', 'secret backend error']) assert.equal(JSON.stringify(events).includes(secret), false);
    }
  });
});
