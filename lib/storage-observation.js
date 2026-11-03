import { performance } from 'node:perf_hooks';

// Fixed codes only: never include exception messages, paths, or execution metadata.
export const STORAGE_FAILURE_REASONS = Object.freeze([
  'invalid-config', 'file-too-large', 'lock-busy', 'lock-invalid', 'lock-owner-unknown',
  'lock-changed', 'lock-recovery-blocked', 'lock-unsupported', 'scan-limit',
  'capacity', 'cleanup-limit', 'cleanup-io', 'storage-io', 'backend-error', 'backend-response'
]);

export function failStorage(state, reason) {
  if (state && state.spilloverReason == null) state.spilloverReason = reason;
  return null;
}

export function startStorage(state, backend) {
  if (!state) return null;
  state.spilloverBackend = backend;
  state.spilloverReason = null;
  return performance.now();
}

export function finishStorage(state, start) {
  if (state && start !== null) state.spilloverDurationMs = Math.max(0, performance.now() - start);
}

/** One warning per fixed reason per interval, with bounded per-plugin state. */
export function createStorageDiagnostics(ctx, config = {}) {
  let enabled = true;
  let intervalMs = 60000;
  try {
    enabled = config?.enabled !== false;
    const configuredInterval = config?.intervalMs;
    if (Number.isSafeInteger(configuredInterval) && configuredInterval > 0) intervalMs = configuredInterval;
  } catch { enabled = false; }
  const last = new Map();
  return state => {
    try {
      if (!enabled || !STORAGE_FAILURE_REASONS.includes(state?.spilloverReason)) return;
      const now = performance.now();
      const previous = last.get(state.spilloverReason);
      if (previous !== undefined && now - previous < intervalMs) return;
      last.set(state.spilloverReason, now);
      const pending = ctx.logger?.warn?.('[tool-result-trimmer] storage diagnostic %o', {
        reason: state.spilloverReason,
        backend: ['session', 'local'].includes(state.spilloverBackend) ? state.spilloverBackend : 'none'
      });
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch { /* Diagnostics must never alter tool results. */ }
  };
}
