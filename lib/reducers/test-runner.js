/**
 * Test runner output reducer.
 *
 * Implements strict Fail-Open mechanics:
 * - If tests fail or exit with error, this reducer yields (returns null),
 *   allowing full error stacks and failure evidence to pass through.
 * - If ALL tests pass cleanly, collapses verbose per-test tick lines
 *   into a clean, concise single-paragraph test suite summary.
 */

import { commandTokens } from './command.js';
import { isExecutionFailure } from './failure.js';

/**
 * Check if the text contains any genuine failure signal.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasFailureSignal(text) {
  // Symbols are not word characters; do not surround them with word boundaries.
  if (/✖|\b(?:cancelled|canceled)(?:[ \t]*[:=][ \t]*|[ \t]*)0*[1-9]\d*\b|\b0*[1-9]\d*[ \t]+(?:cancelled|canceled)\b/i.test(text)) return true;
  if (/\b(?:AssertionError|UnhandledPromiseRejection|panicked at)\b/i.test(text) || /\b(?:error|fatal|exception|traceback)\b/i.test(text)) return true;
  // If zero-fail patterns exist, check if there are actual failure markers.
  if (/\b(?:0 failed|0 failures|failures:\s*0|fail:\s*0|fail\s+0)\b/i.test(text)) {
    if (/\b(?:0*[1-9]\d*\s+failed|0*[1-9]\d*\s+failures|fail\s+0*[1-9]\d*)\b/i.test(text)) {
      return true;
    }
    return false;
  }

  return /\b(?:FAIL|FAILED|ERR!|error|failures|panicked at|✖)\b/i.test(text);
}

// Linear single-pass parser for `node --test` summary lines (avoids multi-wildcard backtracking).
function parseNodeTestSummary(text) {
  if (!text.includes('ℹ')) return null;
  let testsCount = 0;
  let total = null;
  let passed = null;
  let failZero = false;
  let duration = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith('ℹ')) continue;
    if (/^ℹ[ \t]+(?:cancelled|canceled|skipped|todo)[ \t]+0*[1-9]\d*$/i.test(rawLine)) return null;
    const testsMatch = /^ℹ[ \t]+tests[ \t]+(\d+)$/i.exec(rawLine);
    if (testsMatch) {
      testsCount++;
      if (testsCount > 1) return null;
      total = testsMatch[1];
      continue;
    }
    if (total !== null && passed === null) {
      const passMatch = /^ℹ[ \t]+pass[ \t]+(\d+)$/i.exec(rawLine);
      if (passMatch) { passed = passMatch[1]; continue; }
    }
    if (passed !== null && !failZero) {
      if (/^ℹ[ \t]+fail[ \t]+0$/i.test(rawLine)) { failZero = true; continue; }
    }
    if (failZero && duration === null) {
      const durMatch = /^ℹ[ \t]+duration_ms[ \t]+([\d.]+)$/i.exec(rawLine);
      if (durMatch) duration = durMatch[1];
    }
  }
  if (testsCount !== 1 || passed === null || !failZero || Number(total) !== Number(passed)) return null;
  return { total, passed, duration };
}

/**
 * Reduce test runner output when all tests pass cleanly.
 *
 * @param {object} exec
 * @param {string} text
 * @param {object} [result]
 * @param {{ failed?: boolean, tokens?: string[] | null }} [precomputed]
 * @returns {string | null}
 */
export function reduceTestOutput(exec, text, result, precomputed) {
  if (typeof text !== 'string') return null;
  // 1. Strict Fail-Open guard: never touch failed test runs
  if (precomputed ? precomputed.failed : isExecutionFailure(result, text)) return null;
  const tokens = precomputed ? precomputed.tokens : commandTokens(exec);
  if (!tokens) return null;
  const [tool, ...args] = tokens;
  const isTestCmd = ['vitest', 'jest', 'pytest'].includes(tool)
    || (tool === 'node' && args[0] === '--test')
    || (['npm', 'pnpm', 'yarn', 'cargo', 'go'].includes(tool) && args[0] === 'test');
  if (!isTestCmd) return null;

  // If there's any real failure signal, fail-open
  if (hasFailureSignal(text)) {
    return null;
  }

  // 2. node --test format
  const nodeSummary = parseNodeTestSummary(text);
  if (nodeSummary) {
    const { total, passed, duration } = nodeSummary;
    const durStr = duration ? ` (~${(parseFloat(duration) / 1000).toFixed(1)}s)` : '';
    return `✓ All tests passed: ${passed} of ${total} passed, 0 failed${durStr}`;
  }

  // 3. vitest / jest format
  const vitestMatch = text.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/i);
  if (vitestMatch) {
    const [, passed, total] = vitestMatch;
    if (Number(passed) !== Number(total)) return null;
    if ([...text.matchAll(/\bTests\s+\d+\s+passed\s+\(\d+\)/gi)].length !== 1) return null;
    const durMatch = text.match(/Duration\s+([\d\.]+m?s)/i);
    const durStr = durMatch ? ` (${durMatch[1]})` : '';
    return `✓ All tests passed: ${passed} passed${durStr}`;
  }

  // 4. pytest format
  const pytestMatch = text.match(/^[ \t]*={3,}[ \t]*(\d+)[ \t]+passed(?:,[ \t]*\d+[ \t]+warnings?)?[ \t]+in[ \t]+([\d.]+s)[ \t]*={3,}[ \t]*\r?$/im);
  if (pytestMatch) {
    const [, passed, dur] = pytestMatch;
    return `✓ All tests passed: ${passed} passed in ${dur}`;
  }

  // Cargo can emit a separate summary per test binary and for doctests.
  const cargoSummaries = text.match(/^[ \t]*test result:[^\r\n]*/gim);
  if (cargoSummaries?.length === 1) {
    const cargoMatch = cargoSummaries[0].match(/^[ \t]*test result: ok\. ([1-9]\d*) passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in (\d+(?:\.\d+)?s)[ \t]*$/i);
    if (cargoMatch) {
      const [, passed, dur] = cargoMatch;
      return `✓ Cargo tests passed: ${passed} passed, 0 failed (${dur})`;
    }
  }

  return null;
}
