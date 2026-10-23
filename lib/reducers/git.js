/**
 * Git output reducer.
 *
 * Optimizes `git status` and `git diff` outputs by removing non-actionable noise
 * while strictly preserving all file paths, modification states, and diff hunks.
 */

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
  if (result?.isError) return null;
  const cmd = exec?.arguments?.command;
  if (typeof cmd !== 'string') return null;

  // Check if it's a git command
  if (!/(?:^|[\s;&|])git(?:\.exe)?\s+/i.test(cmd)) return null;

  // 1. git status
  if (/\bgit(?:\.exe)?\s+status\b/i.test(cmd)) {
    // If working tree is clean
    if (/nothing to commit,\s*working tree clean/i.test(text)) {
      const branchMatch = text.match(/On branch ([^\n\r]+)/i);
      const branch = branchMatch ? branchMatch[1].trim() : 'current branch';
      return `On branch ${branch}: working tree clean`;
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
  if (/\bgit(?:\.exe)?\s+diff\b/i.test(cmd)) {
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
