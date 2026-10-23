/**
 * Test runner output reducer.
 *
 * Implements strict Fail-Open mechanics:
 * - If tests fail or exit with error, this reducer yields (returns null),
 *   allowing full error stacks and failure evidence to pass through.
 * - If ALL tests pass cleanly, collapses verbose per-test tick lines
 *   into a clean, concise single-paragraph test suite summary.
 */

/**
 * Check if the text contains any genuine failure signal.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasFailureSignal(text) {
  // If zero-fail patterns exist, check if there are actual failure markers
  if (/\b(?:0 failed|0 failures|failures:\s*0|fail:\s*0|fail\s+0)\b/i.test(text)) {
    // Non-zero fail counters or cross symbol
    if (/\b(?:[1-9]\d*\s+failed|[1-9]\d*\s+failures|fail\s+[1-9]\d*|✖)\b/.test(text)) {
      return true;
    }
    if (/\b(?:AssertionError|UnhandledPromiseRejection|panicked at)\b/i.test(text)) {
      return true;
    }
    return false;
  }

  return /\b(?:FAIL|FAILED|ERR!|error|failures|panicked at|✖)\b/i.test(text);
}

/**
 * Reduce test runner output when all tests pass cleanly.
 *
 * @param {object} exec
 * @param {string} text
 * @param {object} [result]
 * @returns {string | null}
 */
export function reduceTestOutput(exec, text, result) {
  // 1. Strict Fail-Open guard: never touch failed test runs
  if (result?.isError) return null;

  const cmd = exec?.arguments?.command;
  if (typeof cmd !== 'string') return null;

  // Match test commands
  const isTestCmd = /(?:^|[\s;&|])(?:npm\s+test|pnpm\s+test|yarn\s+test|node\s+--test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/i.test(cmd);
  if (!isTestCmd) return null;

  // If there's any real failure signal, fail-open
  if (hasFailureSignal(text)) {
    return null;
  }

  // 2. node --test format
  const nodeMatch = text.match(/ℹ\s+tests\s+(\d+)(?:[\s\S]*?)ℹ\s+pass\s+(\d+)(?:[\s\S]*?)ℹ\s+fail\s+0(?:[\s\S]*?duration_ms\s+([\d\.]+))?/i);
  if (nodeMatch) {
    const [, total, passed, duration] = nodeMatch;
    const durStr = duration ? ` (~${(parseFloat(duration) / 1000).toFixed(1)}s)` : '';
    return `✓ All tests passed: ${passed} of ${total} passed, 0 failed${durStr}`;
  }

  // 3. vitest / jest format
  const vitestMatch = text.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/i);
  if (vitestMatch) {
    const [, passed] = vitestMatch;
    const durMatch = text.match(/Duration\s+([\d\.]+m?s)/i);
    const durStr = durMatch ? ` (${durMatch[1]})` : '';
    return `✓ All tests passed: ${passed} passed${durStr}`;
  }

  // 4. pytest format
  const pytestMatch = text.match(/={3,}\s*(\d+)\s+passed(?:,\s*\d+\s+warnings?)?\s+in\s+([\d\.]+s)\s*={3,}/i);
  if (pytestMatch) {
    const [, passed, dur] = pytestMatch;
    return `✓ All tests passed: ${passed} passed in ${dur}`;
  }

  // 5. cargo test format
  const cargoMatch = text.match(/test result:\s*ok\.\s*(\d+)\s+passed;\s*0\s+failed;.*?finished in\s+([\d\.]+s)/i);
  if (cargoMatch) {
    const [, passed, dur] = cargoMatch;
    return `✓ Cargo tests passed: ${passed} passed, 0 failed (${dur})`;
  }

  return null;
}
