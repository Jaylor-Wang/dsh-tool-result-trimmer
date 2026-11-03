import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { failStorage } from './storage-observation.js';

const LOCK_NAME = '.dsh-trimmer.lock';
const ARTIFACT_NAME = /^\.dsh-trimmer\.lock(?:\.reap-[a-f0-9]{32}|\.candidate-[1-9][0-9]{0,9}-[a-f0-9]{32})?$/;
const MAX_INSPECT_ENTRIES = 4096;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameSnapshot(left, right) {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readLock(lockPath) {
  const before = fs.lstatSync(lockPath);
  if (!before.isFile() || before.size < 1 || before.size > 256) return null;
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const after = fs.lstatSync(lockPath);
  if (!sameSnapshot(before, after)) return null;
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || owner.pid > 2147483647 || !/^[a-f0-9]{32}$/.test(owner.token)) return null;
  return { ...owner, stat: after };
}

// PID reuse and permission errors deliberately count as a live/unknown owner.
function ownerStatus(pid) {
  try { process.kill(pid, 0); return 'live'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

function linkFailure(error) {
  return ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(error.code) ? 'lock-unsupported' : 'storage-io';
}

function recoverLock(lockPath, state) {
  let claimPath;
  let claimed = false;
  try {
    const owner = readLock(lockPath);
    if (!owner) return failStorage(state, 'lock-invalid');
    const status = ownerStatus(owner.pid);
    if (status !== 'dead') return failStorage(state, status === 'live' ? 'lock-busy' : 'lock-owner-unknown');
    // The deterministic hard link serializes reapers of this generation. A
    // crashed reaper is handled only by the explicit offline recovery command.
    claimPath = `${lockPath}.reap-${owner.token}`;
    try { fs.linkSync(lockPath, claimPath); }
    catch (error) { return failStorage(state, error.code === 'EEXIST' ? 'lock-recovery-blocked' : linkFailure(error)); }
    claimed = true;
    if (!sameFile(owner.stat, fs.lstatSync(claimPath))) return failStorage(state, 'lock-changed');
    const current = readLock(lockPath);
    if (!current || current.token !== owner.token || !sameFile(owner.stat, current.stat)) return failStorage(state, 'lock-changed');
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return failStorage(state, error.code === 'ENOENT' ? 'lock-changed' : 'storage-io');
  } finally {
    if (claimed) {
      try { fs.unlinkSync(claimPath); } catch { /* Preserve a failed claim conservatively. */ }
    }
  }
}

/** Publish complete metadata without replacing an existing lock or waiting. */
export function withDirectoryLock(dir, callback, state = null) {
  const lockPath = path.join(dir, LOCK_NAME);
  const owner = { pid: process.pid, token: crypto.randomBytes(16).toString('hex') };
  const candidatePath = `${lockPath}.candidate-${owner.pid}-${owner.token}`;
  let fd;
  let stat;
  let created = false;
  let published = false;
  try {
    fd = fs.openSync(candidatePath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(owner), 'utf8');
    stat = fs.fstatSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(candidatePath, lockPath); }
    catch (error) {
      if (error.code !== 'EEXIST') return failStorage(state, linkFailure(error));
      if (!recoverLock(lockPath, state)) return null;
      try { fs.linkSync(candidatePath, lockPath); }
      catch (retryError) { return failStorage(state, retryError.code === 'EEXIST' ? 'lock-busy' : linkFailure(retryError)); }
    }
    published = true;
    fs.unlinkSync(candidatePath);
    created = false;
    return callback();
  } catch {
    return failStorage(state, 'storage-io');
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Best effort. */ }
    }
    if (published) {
      try {
        if (stat && sameFile(stat, fs.lstatSync(lockPath))) fs.unlinkSync(lockPath);
      } catch { /* Never release a replacement lock. */ }
    }
    if (created) {
      try { fs.unlinkSync(candidatePath); } catch { /* Offline inspection reports abandoned candidates. */ }
    }
  }
}

function inspectArtifacts(dir) {
  const artifacts = [];
  const handle = fs.opendirSync(dir);
  try {
    for (let count = 0; count <= MAX_INSPECT_ENTRIES; count++) {
      const entry = handle.readSync();
      if (!entry) return artifacts;
      if (count === MAX_INSPECT_ENTRIES) throw Object.assign(new Error('Inspection limit'), { code: 'SCAN_LIMIT' });
      if (!ARTIFACT_NAME.test(entry.name)) continue;
      const target = path.join(dir, entry.name);
      const stat = fs.lstatSync(target);
      let status = 'invalid';
      if (stat.isFile()) {
        const owner = readLock(target);
        if (owner) status = ownerStatus(owner.pid);
        else {
          // Candidate names retain their creator PID even when metadata is partial.
          const candidate = /\.candidate-([1-9][0-9]{0,9})-/.exec(entry.name);
          if (candidate) status = ownerStatus(Number(candidate[1]));
        }
      }
      artifacts.push({ name: entry.name, stat, status });
    }
    return artifacts;
  } finally { handle.closeSync(); }
}

/** Inspect by default; offline repair requires a matching fingerprint and stopped writers. */
export function repairSpilloverLock(dir, options = {}) {
  let removed = 0;
  try {
    const target = path.resolve(dir);
    const artifacts = inspectArtifacts(target).sort((a, b) => a.name.localeCompare(b.name));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(artifacts.map(({ name, stat, status }) => ({
      name, status, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode
    })))).digest('hex');
    const result = { status: 'inspected', fingerprint, artifacts: artifacts.map(({ name, status }) => ({ name, status })), removed: 0 };
    if (options.apply !== true) return result;
    if (options.writersStopped !== true) return { ...result, status: 'refused', reason: 'writers-not-stopped' };
    if (options.fingerprint !== fingerprint) return { ...result, status: 'refused', reason: 'snapshot-changed' };
    if (artifacts.some(item => !item.stat.isFile() || item.status === 'live' || item.status === 'unknown')) {
      return { ...result, status: 'refused', reason: 'owner-active-or-unknown' };
    }
    // Check every identity before deleting anything. The caller must keep all
    // writers/reapers stopped: portable filesystems have no conditional unlink.
    if (artifacts.some(item => !sameSnapshot(item.stat, fs.lstatSync(path.join(target, item.name))))) {
      return { ...result, status: 'refused', reason: 'snapshot-changed' };
    }
    for (const item of artifacts) {
      const current = fs.lstatSync(path.join(target, item.name));
      // Removing an earlier hard link changes ctime on its remaining siblings.
      if (!sameFile(item.stat, current) || item.stat.size !== current.size || item.stat.mtimeMs !== current.mtimeMs) {
        return { ...result, status: 'refused', reason: 'snapshot-changed' };
      }
      fs.unlinkSync(path.join(target, item.name));
      result.removed = ++removed;
    }
    return { ...result, status: 'repaired' };
  } catch (error) {
    return { status: 'refused', reason: error.code === 'SCAN_LIMIT' ? 'scan-limit' : 'storage-io', removed };
  }
}
