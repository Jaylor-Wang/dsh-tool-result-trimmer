import path from 'node:path';

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

// Parse literal words only. Expansion, escaping and arbitrary shell syntax stay opaque.
function literalWords(command) {
  if (/[`$\n\r\0]/.test(command)) return null;
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else {
        if (quote === '"' && char === '\\' && /[\\"$`]/.test(command[index + 1] ?? '')) {
          word += command[++index];
        } else word += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else {
      if (/[;&|<>()[\]{}*?~#!\\]/.test(char)) return null;
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

// Preserve the caller's directory; resolve one literal cd relative to it without I/O.
export function commandContext(exec) {
  try {
    const args = exec?.arguments;
    if (typeof args?.command !== 'string') return null;
    if (/[\n\r\0]/.test(args.command)) return null;
    let command = args.command.trim();
    command = command.replace(/\s+2>&1$/, '').trimEnd();
    let workdir = args.workdir;
    if (workdir !== undefined && (typeof workdir !== 'string' || !workdir.trim() || /[\n\r\0]/.test(workdir))) return null;
    // Quoted operators remain literal words, never shell separators.
    const cd = command.match(/^cd\s+((?:[^\s'";&|<>`$()#]+|'[^'\n\r]*'|"[^"\n\r]*")+)\s*&&\s*(.+)$/);
    if (cd) {
      const directory = literalWords(cd[1]);
      if (directory?.length !== 1 || !directory[0] || directory[0].startsWith('-')) return null;
      const target = directory[0];
      if (/^[A-Za-z]:(?![\\/])/.test(target)) return null;
      const flavor = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(workdir ?? '') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(target) ? path.win32 : path.posix;
      if (flavor.isAbsolute(target)) workdir = flavor.normalize(target);
      else workdir = workdir ? flavor.join(workdir, target) : flavor.normalize(target);
      command = cd[2];
    }
    // Keep other quoted arguments and shell constructs outside this limited grammar.
    if (/[;&|<>`$\n\r"'()#]/.test(command)) return null;
    const tokens = command.trim().split(/\s+/);
    if (!tokens[0]) return null;
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/.test(tokens[0])) tokens.shift();
    return tokens.length ? { tokens, workdir } : null;
  } catch {
    return null;
  }
}

// Recognize a single command after literal directory and stderr wrappers.
export function commandTokens(exec) {
  const context = commandContext(exec);
  if (!context) return null;
  const tokens = context.tokens;
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

const CURL_FLAGS_WITH_VALUE = new Set([
  '-A', '--user-agent', '-b', '--cookie', '-d', '--data', '--data-raw', '--data-binary',
  '-e', '--referer', '-H', '--header', '-m', '--max-time', '--connect-timeout',
  '-o', '--output', '-O', '--output-dir', '-X', '--request'
]);
const CURL_FLAGS = new Set(['-f', '--fail', '--fail-with-body', '-g', '--globoff', '-i', '--include', '-I', '--head', '-k', '--insecure', '-L', '--location', '-s', '--silent', '-S', '--show-error', '--compressed']);

function isSingleLiteralCommand(command) {
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = null;
      else if (char === '$' || char === '`') return false;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '\\') {
      index++;
    } else if (/[;&|<>()*?~`$#\n\r\0]/.test(char)) {
      return false;
    }
  }
  return quote === null;
}

function commandWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') word += command[++index];
        else word += char;
      } else if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\') {
      if (index + 1 >= command.length) return null;
      word += command[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function isJinaUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === 'r.jina.ai';
  } catch {
    return false;
  }
}

function isJinaCurl(tokens) {
  const executable = tokens[0]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase();
  if (executable !== 'curl') return false;
  const urls = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--') {
      urls.push(...tokens.slice(index + 1));
      break;
    }
    if (CURL_FLAGS.has(token)) continue;
    if (CURL_FLAGS_WITH_VALUE.has(token)) {
      if (!tokens[index + 1]) return false;
      index++;
      continue;
    }
    if (token === '--url') {
      if (!tokens[index + 1]) return false;
      urls.push(tokens[++index]);
      continue;
    }
    if (token.startsWith('--url=')) {
      urls.push(token.slice('--url='.length));
      continue;
    }
    if (/^-[sfSLkgiI]+$/.test(token)) continue;
    if (token.startsWith('-')) return false;
    urls.push(token);
  }
  return urls.length === 1 && isJinaUrl(urls[0]);
}

// Mark only literal Exa web calls and single-URL Jina fetches as web output.
export function isHeadFirstWebCommand(exec) {
  if (exec?.name !== 'bash') return false;
  const rawCommand = exec?.arguments?.command;
  if (typeof rawCommand !== 'string') return false;
  const command = rawCommand.trim().replace(/\s+2>&1$/, '').trimEnd();
  if (!command || !isSingleLiteralCommand(command)) return false;

  const tokens = commandWords(command);
  if (!tokens?.length) return false;
  const executable = tokens[0].split(/[\\/]/).at(-1)?.replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
  if (executable === 'mcporter') {
    return /^exa\.(?:web_search_exa|web_fetch_exa)$/i.test(tokens[2] ?? '') && tokens[1]?.toLowerCase() === 'call';
  }
  return isJinaCurl(tokens);
}

export function hasDiagnostics(text) {
  return /\b(?:warn(?:ing)?|error|failed|failure|fatal|exception|traceback)\b/i.test(text);
}

// Include absolute POSIX/UNC paths and relative paths; numeric progress ratios are not paths.
export const isFilePath = str => /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/]|[^\s\\/]*[^\s\\/\d][^\s\\/]*[\\/]\S+|[\w.-]+\.[A-Za-z][\w-]*\b)/i.test(str);
