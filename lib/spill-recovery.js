import { writeSpillover, DEFAULT_SPILLOVER_CONFIG } from './spillover.js';
import { failStorage, startStorage, finishStorage } from './storage-observation.js';

let hasSpillNotice;
try {
  ({ hasSpillNotice } = await import('@deepseek-ai/dsh-spill-policy/notice'));
} catch (error) {
  // Older hosts and standalone installs need no spill-policy dependency.
  const missingPeer = error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("'@deepseek-ai/dsh-spill-policy'");
  if (!missingPeer && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
}

// Match the persisted official grammar when its optional recognizer is absent.
function isOfficialNotice(text) {
  if (hasSpillNotice) return hasSpillNotice(text);
  const match = /^\((?:Omitted (0|[1-9][0-9]*) bytes\.|More bytes were omitted\.|)(?: Omitted ([1-9][0-9]*) images\.)? Full formatted result stored at: .+\. [\s\S]+\)$/.exec(text);
  return match !== null && match.slice(1).every(count => count === undefined || Number.isSafeInteger(Number(count)));
}

/** Recognize recovery conventions, without interpreting or opening their locators. */
export function findRecoveryNotices(text) {
  const notices = new Set();
  for (const match of text.matchAll(/^\[output truncated; full output: ([^\r\n]+)\][ \t]*\r?$/gm)) {
    if (match[1].trim()) notices.add(match[0].trimEnd());
  }
  const end = text.trimEnd();
  const separator = /\r?\n\r?\n(?=\()/g;
  let start = 0;
  for (const match of end.matchAll(separator)) start = match.index + match[0].length;
  const candidate = end.slice(start);
  if (isOfficialNotice(candidate)) notices.add(candidate);
  return [...notices];
}

/** Keep upstream retrieval metadata even if a tiny tail budget removes it. */
export function preserveRecoveryNotices(content, notices) {
  if (!notices.length) return content;
  const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
  const missing = notices.filter(notice => !text.includes(notice));
  return missing.length ? [...content, { type: 'text', text: `\n\n${missing.join('\n\n')}` }] : content;
}

/** Persist new raw text through the host capability, or the standalone writer. */
export async function saveRecoveryText(ctx, text, config, exec, metrics = null) {
  const start = startStorage(metrics, 'none');
  try {
    if (!config.enabled || typeof text !== 'string' || !text) return null;
    const maxFileBytes = config.maxFileBytes ?? DEFAULT_SPILLOVER_CONFIG.maxFileBytes;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) return failStorage(metrics, 'invalid-config');
    if (Buffer.byteLength(text, 'utf8') > maxFileBytes) return failStorage(metrics, 'file-too-large');

    const store = typeof ctx.get === 'function' ? ctx.get('spillStore') : ctx.spillStore;
    const sessionId = exec?.agent?.session?.header?.id;
    const capable = typeof store?.saveText === 'function';
    const owned = typeof sessionId === 'string' && sessionId
      && typeof exec?.name === 'string' && exec.name && typeof exec?.callId === 'string' && exec.callId;
    if (capable && owned) {
      if (metrics) metrics.spilloverBackend = 'session';
      const ref = await store.saveText({
        owner: { sessionId },
        source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: exec.parent === undefined ? 'result' : 'dispatch' },
        suggestedName: `${exec.name}.txt`,
        content: text
      });
      // Locators are opaque: a backend can return a URI rather than a local path.
      if (typeof ref?.locator !== 'string' || !ref.locator.trim()
        || typeof ref.retrievalHint !== 'string' || !ref.retrievalHint.trim()) return failStorage(metrics, 'backend-response');
      return { locator: ref.locator, retrievalHint: ref.retrievalHint };
    }

    if (metrics) metrics.spilloverFallbackReason = capable ? 'missing-source' : 'missing-store';
    const locator = writeSpillover(text, config, exec, metrics);
    return locator ? { locator } : null;
  } catch {
    // Backend failures never reject a successful tool result or trigger a duplicate write.
    return failStorage(metrics, 'backend-error');
  } finally {
    finishStorage(metrics, start);
  }
}
