import { isExecutionFailure } from './failure.js';
import { commandTokens, hasDiagnostics } from './command.js';

/** Collapse duplicate formatter progress without removing file or diagnostic lines. */
export function reduceLint(exec, text, result) {
  if (isExecutionFailure(result, text) || typeof text !== 'string') return null;
  const tokens = commandTokens(exec);
  if (!tokens || tokens[0] !== 'prettier' || (!tokens.includes('--check') && !tokens.includes('-c')) || tokens.some(token => /^(?:--write(?:=.*)?|-w)$/i.test(token)) || hasDiagnostics(text)) return null;
  if (!/^All matched files use Prettier code style!\r?$/m.test(text)) return null;
  let seen = false;
  let removed = false;
  const lines = text.split(/(?<=\n)/).filter(line => {
    if (!/^Checking formatting\.\.\.\r?\n?$/.test(line)) return true;
    if (!seen) { seen = true; return true; }
    removed = true;
    return false;
  });
  return removed ? lines.join('') : null;
}
