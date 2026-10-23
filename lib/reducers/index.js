import { reduceGit } from './git.js';
import { reducePackageManager } from './package-manager.js';
import { reduceTestOutput } from './test-runner.js';

export { reduceGit, reducePackageManager, reduceTestOutput };

/**
 * Registry of available command-aware semantic reducers.
 */
export const DEFAULT_REDUCERS = [
  { name: 'git', fn: reduceGit },
  { name: 'packageManager', fn: reducePackageManager },
  { name: 'test', fn: reduceTestOutput }
];

/**
 * Coordinate and execute semantic reducers on single or concatenated text.
 *
 * Implements strict Fail-Open error handling: if any reducer throws an error,
 * the error is caught and the original text is preserved safely.
 *
 * @param {object} exec - Tool execution descriptor
 * @param {string} text - Cleaned text content
 * @param {object} [result] - Tool execution result descriptor
 * @param {object} [config] - Plugin configuration
 * @returns {{ reduced: boolean, text: string, reducerName?: string }}
 */
export function applySemanticReducers(exec, text, result, config = {}) {
  const reducersConfig = config.semanticReducers ?? {};
  if (reducersConfig.enabled === false) {
    return { reduced: false, text };
  }

  for (const { name, fn } of DEFAULT_REDUCERS) {
    // Check if individual reducer is disabled in config
    if (reducersConfig[name] === false) {
      continue;
    }

    try {
      const reducedText = fn(exec, text, result);
      if (typeof reducedText === 'string' && reducedText.length > 0 && reducedText !== text) {
        return {
          reduced: true,
          text: reducedText,
          reducerName: name
        };
      }
    } catch {
      // Fail-open: continue to next reducer or mechanical fallback
    }
  }

  return { reduced: false, text };
}
