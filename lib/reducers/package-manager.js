/**
 * Package manager output reducer.
 *
 * Removes noisy progress bars, funding reminders, update notices,
 * and transitive deprecation notices while preserving installed package
 * summaries, vulnerability notices, and errors.
 */

const NPM_WARN_DEPRECATED_REGEX = /^\s*npm WARN deprecated [^\n\r]+$/gm;
const NPM_NOTICE_REGEX = /^\s*npm notice\b[^\n\r]*$/gm;
const NPM_FUNDING_REGEX = /^\s*\d+ packages are looking for funding\.(?:\r?\n\s*(?:run|Run) `?npm fund`?[^\n\r]*)?/gm;
const PROGRESS_SPINNER_LINE_REGEX = /^\s*[\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.*$/gm;
const PROGRESS_BAR_REGEX = /^\s*\[[=\->\s]{5,}\]\s+.*$/gm;
const PIP_PROGRESS_REGEX = /^\s*(?:Downloading|Installing collected packages:)\s+.*(?:\r?\n\s+.*\[[=\->\s]+\]\s+\d+[\d\.\s%KkMmBb\/s]+)+/gm;
const YARN_SUCCESS_HINT_REGEX = /^\s*info Direct dependencies\s*$/gm;

/**
 * Reduce package manager command outputs.
 *
 * @param {object} exec
 * @param {string} text
 * @param {object} [result]
 * @returns {string | null}
 */
export function reducePackageManager(exec, text, result) {
  // Always fail-open on command failure to preserve error details
  if (result?.isError) return null;

  const cmd = exec?.arguments?.command;
  if (typeof cmd !== 'string') return null;

  // Match package managers: npm, pnpm, yarn, pip
  if (!/(?:^|[\s;&|])(?:npm|pnpm|yarn|pip|pip3)(?:\.cmd|\.exe)?\s+/i.test(cmd)) {
    return null;
  }

  // If text already indicates an error, fail-open
  if (/\b(?:ERR!|npm ERR!|error Command failed|Traceback \(most recent call last\))\b/i.test(text)) {
    return null;
  }

  let cleaned = text
    .replace(PROGRESS_SPINNER_LINE_REGEX, '')
    .replace(PROGRESS_BAR_REGEX, '')
    .replace(NPM_WARN_DEPRECATED_REGEX, '')
    .replace(NPM_NOTICE_REGEX, '')
    .replace(NPM_FUNDING_REGEX, '')
    .replace(PIP_PROGRESS_REGEX, '')
    .replace(YARN_SUCCESS_HINT_REGEX, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned.length > 0 && cleaned.length < text.length ? cleaned : null;
}
