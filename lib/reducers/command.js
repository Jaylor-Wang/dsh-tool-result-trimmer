const WRAPPER_FLAGS = new Set(['--yes', '-y', '--no', '--no-install', '--silent', '-q', '--quiet', '--offline', '--prefer-offline', '--ignore-scripts']);
const WRAPPER_VALUES = new Set(['--package', '--prefix', '--workspace', '-w', '--filter', '-F', '--dir', '-C', '--cwd', '--registry', '--userconfig', '--cache']);

// Consume only known wrapper options; unknown options and shell-call modes fail open.
function skipWrapperOptions(tokens, start, npx = false) {
  let index = start;
  while (tokens[index]?.startsWith('-')) {
    const token = tokens[index];
    if (token === '--') return index + 1;
    const equals = token.indexOf('=');
    const option = equals === -1 ? token : token.slice(0, equals);
    if (WRAPPER_FLAGS.has(option)) {
      if (equals !== -1 && !/^(?:true|false)$/.test(token.slice(equals + 1))) return null;
      index++;
    } else if (WRAPPER_VALUES.has(option) || (npx && option === '-p')) {
      if (equals !== -1) {
        if (!token.slice(equals + 1)) return null;
        index++;
      } else {
        if (!tokens[index + 1] || tokens[index + 1].startsWith('-')) return null;
        index += 2;
      }
    } else {
      return null;
    }
  }
  return index;
}

// Recognize only a simple command with unambiguous wrappers and arguments.
export function commandTokens(exec) {
  let command;
  try { command = exec?.arguments?.command; } catch { return null; }
  if (typeof command !== 'string' || /[;&|<>`$\n\r"'()#]/.test(command)) return null;
  const tokens = command.trim().split(/\s+/);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(tokens[0])) tokens.shift();
  const executable = token => token?.replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
  if (!tokens[0]) return null;

  const tool = executable(tokens[0]);
  let start = 0;
  if (tool === 'npx') {
    start = skipWrapperOptions(tokens, 1, true);
    if (start === null) return null;
  } else if (['npm', 'pnpm', 'yarn'].includes(tool)) {
    const subcommand = skipWrapperOptions(tokens, 1);
    if (subcommand === null || !tokens[subcommand]) return null;
    if (tokens[subcommand] === 'exec') {
      start = skipWrapperOptions(tokens, subcommand + 1);
      if (start === null) return null;
    } else {
      // Normalize manager options so callers can inspect the actual subcommand.
      return [tool, ...tokens.slice(subcommand)];
    }
  }

  if (!tokens[start] || tokens[start].startsWith('-')) return null;
  return [executable(tokens[start]), ...tokens.slice(start + 1)];
}

export function hasDiagnostics(text) {
  return /\b(?:warn(?:ing)?|error|failed|failure|fatal|exception|traceback)\b/i.test(text);
}

// Include absolute POSIX/UNC paths and relative paths; numeric progress ratios are not paths.
export const isFilePath = str => /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/]|[^\s\\/]*[^\s\\/\d][^\s\\/]*[\\/]\S+|[\w.-]+\.[A-Za-z][\w-]*\b)/i.test(str);
