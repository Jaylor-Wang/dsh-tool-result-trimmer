/**
 * Return true when execution failed or its completion state is uncertain.
 * Missing metadata is allowed for legacy tools; reducers still require their
 * own format evidence. Explicit unknown states must never imply success.
 *
 * @param {object} [result]
 * @param {string} [text]
 * @returns {boolean}
 */
export function isExecutionFailure(result, text) {
  try {
    if (result?.isError === true) return true;
    if (result?.failed === true || result?.timedOut === true || result?.aborted === true) return true;
    if (result?.signal != null) return true;

    // Legacy adapters expose these fields on the result itself.
    for (const field of ['exitCode', 'code']) {
      if (result?.[field] !== undefined && result[field] !== 0) return true;
    }
    if (result?.status !== undefined) {
      const status = result.status;
      if (status !== 0 && (typeof status !== 'string' || !/^(?:ok|success|succeeded|completed)$/i.test(status.trim()))) return true;
    }
    if (result?.sandbox?.denied === true || result?.sandbox?.runnerFailed === true) return true;

    // DSH shell tools keep process facts in their canonical value. Restrict
    // inspection to the shell union rather than guessing application schemas.
    const value = result?.value;
    if (value && typeof value === 'object') {
      if (value.kind === 'background' || value.kind === 'promoted') return true;
      if (value.kind === 'foreground') {
        if (value.exitCode !== 0 || value.signal != null || value.timedOut === true || value.aborted === true || value.stopped !== undefined || value.sandbox?.denied === true || value.sandbox?.runnerFailed === true) return true;
      }
    }

    // These are complete DSH status lines, not general error-word matches.
    if (typeof text === 'string') {
      for (const match of text.matchAll(/^\[exit code: (-?\d+|null)\]\r?$/gm)) {
        if (match[1] === 'null' || Number(match[1]) !== 0) return true;
      }
      if (/^\[(?:killed by signal: [^\r\n]+|timed out after \d+ms|stopped: [^\r\n]+|still running after \d+ms; moved to background job [^\r\n]+|sandbox: the sandbox runner itself failed under [^\r\n]+)\]\r?$/m.test(text)) return true;
    }
    return false;
  } catch {
    // Inspection failures must protect diagnostic output.
    return true;
  }
}
