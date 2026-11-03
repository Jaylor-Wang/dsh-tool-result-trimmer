import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDirectoryLock } from './directory-lock.js';
import { failStorage, startStorage, finishStorage } from './storage-observation.js';

export { repairSpilloverLock } from './directory-lock.js';

export const DEFAULT_SPILLOVER_CONFIG = {
  enabled: true,
  directory: null,
  maxFileBytes: 20000000,
  maxTotalBytes: 200000000,
  maxFiles: 1000,
  ttlMs: 604800000,
  onSemanticReduction: false
};

const LOG_NAME = /^trimmed-[a-zA-Z0-9_-]{1,16}-[a-f0-9]{12}-[a-z0-9]+-[a-f0-9]{8}\.log$/;
const TEMP_NAME = /^\.(trimmed-[a-zA-Z0-9_-]{1,16}-[a-f0-9]{12}-[a-z0-9]+-[a-f0-9]{8}\.log)\.tmp-[a-f0-9]{8}$/;
const MAX_SCAN_ENTRIES = 4096;
const MAX_DELETIONS = 128;
const TEMP_TTL_MS = 300000;

/** Resolve the optional storage directory without using command text. */
export function getSpilloverDirectory(config) {
  if (typeof config?.directory === 'string' && config.directory.trim()) {
    return path.resolve(config.directory);
  }
  return path.join(os.tmpdir(), 'dsh-trimmed');
}

export function sanitizeCallId(callId) {
  if (typeof callId === 'string' && callId.length > 0) {
    const sanitized = callId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
    if (sanitized) return sanitized;
  }
  return 'exec';
}

export function generateSpilloverFilename(callId, rawText) {
  const hash = crypto.createHash('sha256').update(rawText).digest('hex').slice(0, 12);
  return `trimmed-${sanitizeCallId(callId)}-${hash}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.log`;
}

function limitsFor(config) {
  const limits = {};
  for (const field of ['maxFileBytes', 'maxTotalBytes', 'maxFiles', 'ttlMs']) {
    const value = config[field] ?? DEFAULT_SPILLOVER_CONFIG[field];
    if (!Number.isSafeInteger(value) || value < 1) return null;
    limits[field] = value;
  }
  return limits;
}

/**
 * Read at most MAX_SCAN_ENTRIES plus one sentinel entry. Incomplete scans never
 * authorize new writes. Only regular files with our exact names are managed.
 */
function scanDirectory(dir) {
  const files = [];
  const handle = fs.opendirSync(dir);
  try {
    for (let count = 0; count <= MAX_SCAN_ENTRIES; count++) {
      const entry = handle.readSync();
      if (!entry) return files;
      if (count === MAX_SCAN_ENTRIES) return null;
      if (!entry.isFile() || (!LOG_NAME.test(entry.name) && !TEMP_NAME.test(entry.name))) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isFile()) files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, temporary: TEMP_NAME.test(entry.name) });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  } finally {
    handle.closeSync();
  }
}

/** Prune before writing, reserving room for the proposed new file. */
function makeRoom(dir, limits, reservedBytes = 0, reservedFiles = 0, metrics = null) {
  if (metrics) metrics.cleanup = 'failed';
  const files = scanDirectory(dir);
  if (!files) return failStorage(metrics, 'scan-limit');
  const now = Date.now();
  let deletions = 0;
  let cleanupFailed = false;
  let cleanupReason = null;
  const remove = (file) => {
    if (deletions >= MAX_DELETIONS) { cleanupFailed = true; cleanupReason ??= 'cleanup-limit'; return false; }
    deletions++;
    try {
      fs.unlinkSync(file.path);
      if (metrics) metrics.cleanupDeleted++;
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      cleanupFailed = true;
      cleanupReason ??= 'cleanup-io';
      return false;
    }
  };

  const active = [];
  for (const file of files) {
    const expired = now - file.mtimeMs > (file.temporary ? TEMP_TTL_MS : limits.ttlMs);
    if (!expired || !remove(file)) active.push(file);
  }
  let totalBytes = active.reduce((sum, file) => sum + file.size, 0);
  let totalFiles = active.length;
  active.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  for (const file of active) {
    if (totalFiles + reservedFiles <= limits.maxFiles && totalBytes + reservedBytes <= limits.maxTotalBytes) {
      if (metrics) metrics.cleanup = cleanupFailed ? 'failed' : 'complete';
      if (cleanupReason) failStorage(metrics, cleanupReason);
      return true;
    }
    // Fresh temporary files may belong to an interrupted or older writer.
    if (file.temporary) continue;
    if (!remove(file)) return failStorage(metrics, cleanupReason);
    totalFiles--;
    totalBytes -= file.size;
  }
  const admitted = totalFiles + reservedFiles <= limits.maxFiles && totalBytes + reservedBytes <= limits.maxTotalBytes;
  if (admitted && metrics) metrics.cleanup = cleanupFailed ? 'failed' : 'complete';
  if (cleanupReason) failStorage(metrics, cleanupReason);
  if (!admitted) failStorage(metrics, 'capacity');
  return admitted;
}

/** Bounded explicit cleanup. The legacy force argument remains accepted. */
export function pruneSpilloverDirectory(dir, config = {}, _force = false) {
  try {
    const limits = limitsFor(config);
    if (!limits) return;
    const target = path.resolve(dir);
    withDirectoryLock(target, () => makeRoom(target, limits));
  } catch {
    // Cleanup errors must never affect tool execution.
  }
}

/**
 * Atomically save complete raw text after bounded capacity admission.
 * @returns {string | null} Absolute path, or null on refusal/failure.
 */
export function writeSpillover(rawText, spilloverConfig = DEFAULT_SPILLOVER_CONFIG, exec = undefined, metrics = null) {
  const start = startStorage(metrics, 'local');
  try {
    const effective = { ...DEFAULT_SPILLOVER_CONFIG, ...(spilloverConfig ?? {}) };
    if (!effective.enabled || typeof rawText !== 'string' || !rawText) return null;
    const limits = limitsFor(effective);
    if (!limits) return failStorage(metrics, 'invalid-config');
    const byteLength = Buffer.byteLength(rawText, 'utf8');
    if (byteLength > limits.maxFileBytes) return failStorage(metrics, 'file-too-large');
    if (byteLength > limits.maxTotalBytes) return failStorage(metrics, 'capacity');

    const dir = getSpilloverDirectory(effective);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return withDirectoryLock(dir, () => {
      if (!makeRoom(dir, limits, byteLength, 1, metrics)) return null;
      const filename = generateSpilloverFilename(exec?.callId, rawText);
      const targetPath = path.join(dir, filename);
      const tmpPath = path.join(dir, `.${filename}.tmp-${crypto.randomBytes(4).toString('hex')}`);
      let created = false;
      try {
        // Exclusive creation prevents following an existing temporary symlink.
        const fd = fs.openSync(tmpPath, 'wx', 0o600);
        created = true;
        try { fs.writeFileSync(fd, rawText, 'utf8'); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmpPath, targetPath);
        return targetPath;
      } finally {
        if (created) {
          try { fs.unlinkSync(tmpPath); } catch { /* Renamed or best-effort cleanup. */ }
        }
      }
    }, metrics);
  } catch {
    // Storage errors use the normal banner and a fixed diagnostic reason.
    return failStorage(metrics, 'storage-io');
  } finally {
    finishStorage(metrics, start);
  }
}
