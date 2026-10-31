/**
 * Package manager output reducer.
 *
 * Removes noisy progress bars, funding reminders, update notices,
 * and transitive deprecation notices while preserving installed package
 * summaries, vulnerability notices, and errors.
 */

import { commandTokens, hasDiagnostics, isFilePath } from './command.js';
import { isExecutionFailure } from './failure.js';

const NPM_WARN_DEPRECATED_REGEX = /^\s*npm WARN deprecated [^\n\r]+$/gm;
const NPM_NOTICE_REGEX = /^\s*npm notice\b[^\n\r]*$/gm;
const NPM_FUNDING_REGEX = /^\s*\d+ packages are looking for funding\.(?:\r?\n\s*(?:run|Run) `?npm fund`?[^\n\r]*)?/gm;
const SPINNER_PROGRESS_REGEX = /^\s*[\u2800-\u28FF]\s+(?:fetching|resolving|downloading|installing|linking|building)(?:\s+(?:packages?|dependencies))?(?:\.{3}|…)?(?:\s+\d+(?:\/\d+)?(?:%)?)?\s*$/i;
const PROGRESS_BAR_REGEX = /^\s*\[[=\-> ]{5,}\][ \t]+\d+(?:\.\d+)?%[ \t]*\r?$/gm;
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
  if (isExecutionFailure(result, text) || typeof text !== 'string') return null;

  // Only package operations qualify. Script aliases, child tools, shell chains,
  // and wrappers that could not be parsed must retain their original output.
  const tokens = commandTokens(exec);
  if (!tokens || !['npm', 'pnpm', 'yarn', 'pip', 'pip3'].includes(tokens[0])) return null;
  if (!['install', 'i', 'ci', 'add', 'update', 'upgrade', 'remove', 'uninstall', 'audit', 'dedupe', 'prune', 'download', 'wheel'].includes(tokens[1])) return null;

  // If text already indicates an error, fail-open
  if (/\b(?:ERR!|npm ERR!|error Command failed|Traceback \(most recent call last\))\b/i.test(text)) {
    return null;
  }

  // Progressive spinners should only remove transient progress indicators,
  // never lines containing diagnostics or file paths.
  const lines = text.split(/(?<=\n)/);
  const strippedSpinners = lines.map(line => {
    if (SPINNER_PROGRESS_REGEX.test(line)) {
      if (hasDiagnostics(line) || isFilePath(line)) return line;
      return '';
    }
    return line;
  }).join('');

  const removeSafeNoise = match => hasDiagnostics(match) || isFilePath(match) ? match : '';
  let cleaned = strippedSpinners
    .replace(PROGRESS_BAR_REGEX, removeSafeNoise)
    .replace(NPM_WARN_DEPRECATED_REGEX, '')
    .replace(NPM_NOTICE_REGEX, removeSafeNoise)
    .replace(NPM_FUNDING_REGEX, removeSafeNoise)
    .replace(PIP_PROGRESS_REGEX, removeSafeNoise)
    .replace(YARN_SUCCESS_HINT_REGEX, '')
    .replace(/\n{3,}/g, '\n\n');

  // Must only reduce if package manager noise was actually removed, not just whitespace trim
  if (cleaned.trim() === text.trim()) {
    return null;
  }

  cleaned = cleaned.trim();
  return cleaned.length > 0 && cleaned.length < text.length ? cleaned : null;
}
