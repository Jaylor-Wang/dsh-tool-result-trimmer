import { isHeadFirstWebCommand } from './reducers/command.js';

// Match tool families at name boundaries; unrelated names retain global budgets.
const HEAD_FIRST_TOOL = /^(?:web(?:[-_.]|$)|fetch$|mcp(?:__|[-_.]))/i;

export function resolveToolOptions(toolName, defaults, override = {}, exec = null) {
  const headFirst = (typeof toolName === 'string' && HEAD_FIRST_TOOL.test(toolName)) ||
    (toolName === 'bash' && isHeadFirstWebCommand(exec));
  return {
    stripAnsi: override.stripAnsi ?? defaults.stripAnsi,
    thresholdChars: override.thresholdChars ?? defaults.thresholdChars,
    headChars: override.headChars ?? (headFirst ? Math.max(defaults.headChars, defaults.tailChars) : defaults.headChars),
    tailChars: override.tailChars ?? (headFirst ? Math.min(defaults.headChars, defaults.tailChars) : defaults.tailChars)
  };
}
