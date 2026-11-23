/**
 * Package manager output reducer.
 *
 * Removes noisy progress bars, funding reminders, update notices,
 * and transitive deprecation notices while preserving installed package
 * summaries, vulnerability notices, and errors.
 */

import { commandTokens, hasDiagnostics, isFilePath } from './command.js';
import { isExecutionFailure } from './failure.js';

const NPM_WARN_DEPRECATED_REGEX = /^[ \t]*npm WARN deprecated [^\n\r]+$/gm;
const NPM_NOTICE_REGEX = /^[ \t]*npm notice\b[^\n\r]*$/gm;
const NPM_FUNDING_REGEX = /^[ \t]*\d+ packages are looking for funding\.(?:\r?\n[ \t]*(?:run|Run) `?npm fund`?[^\n\r]*)?/gm;
const SPINNER_PROGRESS_REGEX = /^[ \t]*[\u2800-\u28FF][ \t]+(?:fetching|resolving|downloading|installing|linking|building)(?:[ \t]+(?:packages?|dependencies))?(?:\.{3}|…)?(?:[ \t]+\d+(?:\/\d+)?(?:%)?)?[ \t]*\r?\n?$/i;
const PROGRESS_BAR_REGEX = /^[ \t]*\[[=\-> ]{5,}\][ \t]+\d+(?:\.\d+)?%[ \t]*\r?$/gm;
const PIP_HEADER_REGEX = /^[ \t]*(?:Downloading|Installing collected packages:)[ \t]+[^\r\n]*\r?\n?$/;
const PIP_BAR_LINE_REGEX = /^[ \t][^\r\n]*\[[=\-> \t]+\][ \t]+\d[\d. \t%KkMmBb/s]*\r?\n?$/;
const YARN_SUCCESS_HINT_REGEX = /^[ \t]*info Direct dependencies[ \t]*\r?$/gm;

// Linear line-by-line pip progress removal (avoids nested/cross-line regex backtracking).
function stripPipProgress(text) {
  if (!text.includes('Downloading') && !text.includes('Installing collected packages:')) return text;
  const lines = text.split(/(?<=\n)/);
  const kept = [];
  for (let i = 0; i < lines.length; ) {
    if (PIP_HEADER_REGEX.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].includes('[') && PIP_BAR_LINE_REGEX.test(lines[j])) j++;
      if (j > i + 1) {
        const block = lines.slice(i, j).join('');
        if (!hasDiagnostics(block) && !isFilePath(block)) {
          i = j;
          continue;
        }
      }
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.length === lines.length ? text : kept.join('');
}

/**
 * Reduce package manager command outputs.
 *
 * @param {object} exec
 * @param {string} text
 * @param {object} [result]
 * @param {{ failed?: boolean, tokens?: string[] | null }} [precomputed]
 * @returns {string | null}
 */
export function reducePackageManager(exec, text, result, precomputed) {
  if (typeof text !== 'string') return null;
  // Always fail-open on command failure to preserve error details
  if (precomputed ? precomputed.failed : isExecutionFailure(result, text)) return null;

  // Only package operations qualify. Script aliases, child tools, shell chains,
  // and wrappers that could not be parsed must retain their original output.
  const tokens = precomputed ? precomputed.tokens : commandTokens(exec);
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
  let cleaned = stripPipProgress(strippedSpinners)
    .replace(PROGRESS_BAR_REGEX, removeSafeNoise)
    .replace(NPM_WARN_DEPRECATED_REGEX, '')
    .replace(NPM_NOTICE_REGEX, removeSafeNoise)
    .replace(NPM_FUNDING_REGEX, removeSafeNoise)
    .replace(YARN_SUCCESS_HINT_REGEX, '')
    .replace(/\n{3,}/g, '\n\n');

  // Must only reduce if package manager noise was actually removed, not just whitespace trim
  if (cleaned.trim() === text.trim()) {
    return null;
  }

  cleaned = cleaned.trim();
  return cleaned.length > 0 && cleaned.length < text.length ? cleaned : null;
}
