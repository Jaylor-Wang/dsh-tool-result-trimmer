/**
 * Git output reducer.
 *
 * Optimizes `git status` and `git diff` outputs by removing non-actionable noise
 * while strictly preserving all file paths, modification states, and diff hunks.
 */

import { commandTokens, hasDiagnostics } from './command.js';
import { isExecutionFailure } from './failure.js';

const GIT_STATUS_HINT_REGEX = /^\s*\((?:use "git [^"]+"[^\)]*)\)\s*$/gm;
const GIT_STATUS_EXTRA_HINT_REGEX = /^\s*no changes added to commit \(use "git add" and\/or "git commit -a"\)\s*$/gm;
const GIT_DIFF_INDEX_REGEX = /^\s*index [0-9a-zA-Z._]+\.\.[0-9a-zA-Z._]+(?:\s+\d+)?\s*$/gm;

/**
 * Reduce git output.
 *
 * @param {object} exec
 * @param {string} text
 * @param {object} [result]
 * @returns {string | null}
 */
export function reduceGit(exec, text, result) {
  if (isExecutionFailure(result, text) || typeof text !== 'string') return null;
  const tokens = commandTokens(exec);
  if (!tokens || tokens[0] !== 'git') return null;

  // 1. git status
  if (tokens[1] === 'status') {
    if (hasDiagnostics(text)) return null;
    // Only collapse a complete known format. Preserve shell status markers,
    // branch divergence information, stderr, and unknown hook output.
    if (/^nothing to commit, working tree clean\r?$/m.test(text)) {
      const clean = text.match(/^On branch ([^\r\n]+)\r?\n(?:Your branch is up to date with [^\r\n]+\r?\n)?(?:\r?\n)*nothing to commit, working tree clean(?:\r?\n)?(?:(\[exit code: 0\])(?:\r?\n)?)?$/);
      if (!clean) return null;
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const ending = /\r?\n$/.test(text) ? newline : '';
      const status = clean[2] ? `${newline}${clean[2]}${ending}` : '';
      return `On branch ${clean[1]}: working tree clean${status}`;
    }

    // Strip repetitive "(use "git add <file>..." ...)" guidance lines
    let cleaned = text
      .replace(GIT_STATUS_HINT_REGEX, '')
      .replace(GIT_STATUS_EXTRA_HINT_REGEX, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned.length > 0 && cleaned.length < text.length ? cleaned : null;
  }

  // 2. git diff
  if (tokens[1] === 'diff') {
    // Fail-open for diff --stat, --name-only, or non-hunk diffs
    if (!text.includes('diff --git')) {
      return null;
    }

    // Strip purely noisy index hash line: `index 1234567..89abcdef 100644`
    let cleaned = text
      .replace(GIT_DIFF_INDEX_REGEX, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned.length > 0 && cleaned.length < text.length ? cleaned : null;
  }

  return null;
}
