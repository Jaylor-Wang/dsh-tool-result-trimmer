import { isExecutionFailure } from './failure.js';
import { commandTokens, hasDiagnostics, isFilePath } from './command.js';

const wpTagRegex = /^(?:<s>\s*)?\[webpack\.Progress\]\s*\d+%(?:\s+.*)?$/i;
const wpLegacyRegex = /^(?:100|[1-9]?\d)%\s+(?:building|sealing|emitting|done)$/i;

/** Reduce only recognized build progress; retain paths and all other lines. */
export function reduceBuild(exec, text, result) {
  if (isExecutionFailure(result, text) || typeof text !== 'string') return null;
  const tokens = commandTokens(exec);
  if (!tokens || hasDiagnostics(text) || tokens.some(token => /^(?:--watch(?:=.*)?|-w)$/i.test(token))) return null;
  const [tool, ...args] = tokens;
  let progress;
  let success;
  if (tool === 'vite' && args[0] === 'build') {
    progress = /^(?:transforming(?:\s*\(\d+\))?(?:\.\.\.)?|rendering chunks\.\.\.|computing gzip size\.\.\.)$/;
    success = /^✓ built in \d+(?:\.\d+)?(?:ms|s|m)\r?$/m;
  } else if (tool === 'cargo' && args[0] === 'build') {
    progress = /^\s*Compiling [A-Za-z0-9_-]+ v\d+(?:\.\d+){1,3}$/;
    success = /^\s*Finished `[^`]+` profile .+ in \d+(?:\.\d+)?s\r?$/m;
  } else if (tool === 'webpack' && args.includes('--progress')) {
    success = /^webpack \d+(?:\.\d+){1,3} compiled successfully in \d+(?:\.\d+)?\s*ms\r?$/m;
  } else {
    return null;
  }
  if (!success.test(text)) return null;
  const lines = text.split(/(?<=\n)/);
  const kept = lines.filter(line => {
    const stripped = line.replace(/\r?\n$/, '');
    if (tool === 'webpack') {
      if (wpTagRegex.test(stripped)) {
        const details = stripped.replace(/^(?:<s>\s*)?\[webpack\.Progress\]\s*\d+%\s*/i, '');
        if (isFilePath(details)) return true;
        return false;
      }
      if (wpLegacyRegex.test(stripped)) {
        if (isFilePath(stripped)) return true;
        return false;
      }
      return true;
    }
    return !progress.test(stripped);
  });
  if (kept.length === lines.length) return null;
  const output = kept.join('').replace(/(\r?\n){3,}/g, '$1$1');
  return output.length < text.length ? output : null;
}
