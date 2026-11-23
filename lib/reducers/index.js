import { performance } from 'node:perf_hooks';
import { commandTokens } from './command.js';
import { isExecutionFailure } from './failure.js';
import { reduceGit } from './git.js';
import { reducePackageManager } from './package-manager.js';
import { reduceTestOutput } from './test-runner.js';
import { reduceBuild } from './build.js';
import { reduceLint } from './lint.js';

export { isExecutionFailure, reduceGit, reducePackageManager, reduceTestOutput, reduceBuild, reduceLint };

const MAX_REDUCER_TEXT_CHARS = 1024 * 1024;
const SLOW_REDUCER_MS = 50;

/**
 * Registry of available command-aware semantic reducers.
 */
export const DEFAULT_REDUCERS = [
  { name: 'git', fn: reduceGit },
  { name: 'packageManager', fn: reducePackageManager },
  { name: 'test', fn: reduceTestOutput },
  { name: 'build', fn: reduceBuild },
  { name: 'lint', fn: reduceLint }
];

const BUILTIN_NAMES = new Set(DEFAULT_REDUCERS.map(entry => entry.name));

// O(1) command dispatch table keyed by normalized executable token.
const REDUCERS_BY_TOOL = Object.freeze({
  git: new Set(['git']),
  npm: new Set(['packageManager', 'test']),
  pnpm: new Set(['packageManager', 'test']),
  yarn: new Set(['packageManager', 'test']),
  pip: new Set(['packageManager']),
  pip3: new Set(['packageManager']),
  node: new Set(['test']),
  vitest: new Set(['test']),
  jest: new Set(['test']),
  pytest: new Set(['test']),
  go: new Set(['test']),
  cargo: new Set(['test', 'build']),
  vite: new Set(['build']),
  webpack: new Set(['build']),
  prettier: new Set(['lint'])
});

/**
 * Coordinate and execute semantic reducers on single or concatenated text.
 *
 * Implements strict Fail-Open error handling: parses command context and
 * execution state once, dispatches built-in reducers in O(1) by executable
 * name, skips oversized inputs safely, and catches reducer exceptions.
 *
 * @param {object} exec - Tool execution descriptor
 * @param {string} text - Cleaned text content
 * @param {object} [result] - Tool execution result descriptor
 * @param {object} [config] - Plugin configuration
 * @param {{ onSlowReducer?: (info: { reducer: string, durationMs: number }) => void, trippedReducers?: Set<string>, slowThresholdMs?: number } | ((info: { reducer: string, durationMs: number }) => void) | null} [guard]
 * @returns {{ reduced: boolean, text: string, reducerName?: string }}
 */
export function applySemanticReducers(exec, text, result, config = {}, guard = null) {
  const reducersConfig = config.semanticReducers ?? {};
  if (reducersConfig.enabled === false) {
    return { reduced: false, text };
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_REDUCER_TEXT_CHARS) {
    return { reduced: false, text };
  }

  const onSlowReducer = typeof guard === 'function' ? guard : guard?.onSlowReducer ?? null;
  const trippedReducers = typeof guard === 'object' && guard !== null ? guard.trippedReducers ?? null : null;
  const slowThresholdMs = typeof guard === 'object' && guard !== null && Number.isFinite(guard.slowThresholdMs)
    ? guard.slowThresholdMs : SLOW_REDUCER_MS;

  // Parse command tokens once and route built-in reducers directly by executable.
  const tokens = commandTokens(exec);
  const matchedBuiltins = tokens ? REDUCERS_BY_TOOL[tokens[0]] ?? null : null;
  const hasCustomReducers = DEFAULT_REDUCERS.some(entry => !BUILTIN_NAMES.has(entry.name));
  if (!matchedBuiltins && !hasCustomReducers) {
    return { reduced: false, text };
  }

  // Inspect execution failure once before running any matching built-in reducer.
  let failed;
  const getPrecomputed = () => {
    if (failed === undefined) failed = isExecutionFailure(result, text);
    return { failed, tokens };
  };

  for (const { name, fn } of DEFAULT_REDUCERS) {
    if (reducersConfig[name] === false) continue;
    if (trippedReducers?.has(name)) continue;
    const isBuiltin = BUILTIN_NAMES.has(name);
    if (isBuiltin) {
      if (!matchedBuiltins?.has(name)) continue;
      if (getPrecomputed().failed) continue;
    }

    const start = onSlowReducer ? performance.now() : 0;
    try {
      const reducedText = isBuiltin ? fn(exec, text, result, getPrecomputed()) : fn(exec, text, result);
      if (onSlowReducer) {
        const durationMs = performance.now() - start;
        if (durationMs >= slowThresholdMs) {
          onSlowReducer({ reducer: name, durationMs });
          // Fail-open on slow reduction: discard result and let mechanical trimming handle it.
          continue;
        }
      }
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
