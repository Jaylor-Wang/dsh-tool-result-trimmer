/**
 * Pure trimming logic for DSH tool execution results.
 *
 * Provides eager, tail-heavy, line-aware trimming of oversized tool outputs,
 * and automatic terminal ANSI escape sequence stripping.
 */

const DEFAULT_THRESHOLD = 10000;
const DEFAULT_HEAD = 1500;
const DEFAULT_TAIL = 5000;
const MIN_SAVINGS = 200; // minimum character savings required to justify inserting a banner

/**
 * Comprehensive ANSI escape sequence regex matching CSI, OSC, and 2-byte escape sequences.
 */
export const ANSI_REGEX = /(?:\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*?(?:\x07|\x1B\\)|[ -/][@-~]|[@-Z\\-_]))/g;

/**
 * Strip ANSI escape codes (colors, styling, cursor controls, window titles) from text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return text;
  if (!text.includes('\x1b')) return text;
  return text.replace(ANSI_REGEX, '');
}

/**
 * Format the omission banner inserted between retained head and tail.
 *
 * @param {number} omittedChars
 * @param {number} omittedLines
 * @returns {string}
 */
export function formatBanner(omittedChars, omittedLines) {
  const linePart = omittedLines > 0 ? ` (~${omittedLines.toLocaleString()} lines)` : '';
  return `\n\n[... tool output trimmed: omitted ${omittedChars.toLocaleString()} characters${linePart} ...]\n\n`;
}

/**
 * Count newlines ('\n') in a text slice.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Check if a UTF-16 code unit is a leading (high) surrogate (0xD800-0xDBFF).
 *
 * @param {number} code
 * @returns {boolean}
 */
function isLeadingSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

/**
 * Find line-snapped split indices for trimming.
 *
 * @param {string} text
 * @param {number} headBudget
 * @param {number} tailBudget
 * @returns {{ headEnd: number, tailStart: number } | null}
 */
export function computeSnapPoints(text, headBudget, tailBudget) {
  const total = text.length;
  if (headBudget + tailBudget >= total) {
    return null;
  }

  // 1. Head boundary: look for last newline within [0, headBudget]
  let headNewline = text.lastIndexOf('\n', headBudget);
  let headEnd;
  if (headNewline !== -1) {
    headEnd = headNewline + 1; // Include '\n' in head so it ends cleanly
  } else {
    // If no newline before budget, try finding first newline after budget
    const nextNewline = text.indexOf('\n', headBudget);
    if (nextNewline !== -1 && nextNewline < headBudget + 500 && nextNewline < total - tailBudget) {
      headEnd = nextNewline + 1;
    } else {
      // Fallback: character boundary
      headEnd = headBudget;
    }
  }

  // Ensure headEnd does not bisect a UTF-16 surrogate pair (e.g. Emoji)
  if (headEnd > 0 && headEnd < total && isLeadingSurrogate(text.charCodeAt(headEnd - 1))) {
    headEnd--;
  }

  // 2. Tail boundary: look for first newline at or after (total - tailBudget)
  const idealTailStart = total - tailBudget;
  let tailNewline = text.indexOf('\n', idealTailStart);
  let tailStart;
  if (tailNewline !== -1) {
    tailStart = tailNewline + 1; // Start tail immediately after the newline
  } else {
    // Look backwards from idealTailStart within a bounded window to prevent unbounded expansion
    const maxBackward = Math.min(500, tailBudget);
    const prevNewline = text.lastIndexOf('\n', idealTailStart);
    if (prevNewline !== -1 && prevNewline > headEnd && prevNewline >= idealTailStart - maxBackward) {
      tailStart = prevNewline + 1;
    } else {
      // Fallback: character boundary
      tailStart = idealTailStart;
    }
  }

  // Ensure tailStart does not bisect a UTF-16 surrogate pair
  if (tailStart > 0 && tailStart < total && isLeadingSurrogate(text.charCodeAt(tailStart - 1))) {
    tailStart++;
  }

  // Prevent overlap and ensure minimum savings
  if (headEnd >= tailStart || (tailStart - headEnd) < MIN_SAVINGS) {
    return null;
  }

  return { headEnd, tailStart };
}

/**
 * Trim a single string if it exceeds threshold.
 *
 * @param {string} text - Raw output string
 * @param {object} [options]
 * @param {boolean} [options.stripAnsi]
 * @param {number} [options.thresholdChars]
 * @param {number} [options.headChars]
 * @param {number} [options.tailChars]
 * @returns {{ changed: boolean, text: string, omittedChars: number, omittedLines: number }}
 */
export function trimToolText(text, options = {}) {
  if (typeof text !== 'string') {
    return { changed: false, text, omittedChars: 0, omittedLines: 0 };
  }

  let workingText = text;
  let changed = false;

  if (options.stripAnsi) {
    const stripped = stripAnsi(text);
    if (stripped !== text) {
      workingText = stripped;
      changed = true;
    }
  }

  const threshold = options.thresholdChars ?? DEFAULT_THRESHOLD;
  if (workingText.length <= threshold) {
    return { changed, text: workingText, omittedChars: 0, omittedLines: 0 };
  }

  const headBudget = options.headChars ?? DEFAULT_HEAD;
  const tailBudget = options.tailChars ?? DEFAULT_TAIL;

  const points = computeSnapPoints(workingText, headBudget, tailBudget);
  if (!points) {
    return { changed, text: workingText, omittedChars: 0, omittedLines: 0 };
  }

  const { headEnd, tailStart } = points;
  const omittedText = workingText.slice(headEnd, tailStart);
  const omittedChars = omittedText.length;
  const omittedLines = countLines(omittedText);
  const banner = formatBanner(omittedChars, omittedLines);

  const trimmedText = workingText.slice(0, headEnd) + banner + workingText.slice(tailStart);

  return {
    changed: true,
    text: trimmedText,
    omittedChars,
    omittedLines
  };
}

/**
 * Trim rich tool result blocks.
 *
 * @param {Array<object>} blocks - Content blocks ({ type: 'text'|'image'|... })
 * @param {object} [options]
 * @param {boolean} [options.stripAnsi]
 * @returns {{ changed: boolean, content: Array<object>, totalOmittedChars: number }}
 */
export function trimToolContent(blocks, options = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { changed: false, content: blocks, totalOmittedChars: 0 };
  }

  const shouldStripAnsi = options.stripAnsi ?? true;
  const threshold = options.thresholdChars ?? DEFAULT_THRESHOLD;

  // 1. Fast pre-scan: calculate raw text length and detect ANSI escape codes
  // This achieves true 0-allocation pass-through when output is within threshold and has no ANSI codes.
  let rawTotalTextChars = 0;
  let hasAnsi = false;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block?.type === 'text' && typeof block.text === 'string') {
      rawTotalTextChars += block.text.length;
      if (shouldStripAnsi && !hasAnsi && block.text.includes('\x1b')) {
        hasAnsi = true;
      }
    }
  }

  // Fast exit: if no ANSI needs stripping and output is within threshold,
  // return the original blocks array directly with zero overhead and zero object allocations.
  if (!hasAnsi && rawTotalTextChars <= threshold) {
    return { changed: false, content: blocks, totalOmittedChars: 0 };
  }

  // 2. Prepare blocks: strip ANSI escape codes only if present
  let changed = false;
  const preparedBlocks = hasAnsi
    ? blocks.map(block => {
        if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.includes('\x1b')) {
          return block;
        }
        const stripped = stripAnsi(block.text);
        if (stripped !== block.text) {
          changed = true;
          return { ...block, text: stripped };
        }
        return block;
      })
    : blocks;

  // 3. Index text blocks and calculate total length across all prepared text blocks
  let fullText = '';
  const textSpans = [];
  for (let i = 0; i < preparedBlocks.length; i++) {
    const block = preparedBlocks[i];
    if (block?.type === 'text' && typeof block.text === 'string') {
      const start = fullText.length;
      fullText += block.text;
      const end = fullText.length;
      textSpans.push({ index: i, start, end, block });
    }
  }

  if (fullText.length <= threshold) {
    return { changed, content: changed ? preparedBlocks : blocks, totalOmittedChars: 0 };
  }

  // 4. Trim across the whole result
  const headBudget = options.headChars ?? DEFAULT_HEAD;
  const tailBudget = options.tailChars ?? DEFAULT_TAIL;

  const points = computeSnapPoints(fullText, headBudget, tailBudget);
  if (!points) {
    return { changed, content: changed ? preparedBlocks : blocks, totalOmittedChars: 0 };
  }

  const { headEnd, tailStart } = points;
  const omittedText = fullText.slice(headEnd, tailStart);
  const omittedChars = omittedText.length;
  const omittedLines = countLines(omittedText);
  const banner = formatBanner(omittedChars, omittedLines);

  let bannerInserted = false;
  let spanCursor = 0;
  const newBlocks = [];

  for (let i = 0; i < preparedBlocks.length; i++) {
    const block = preparedBlocks[i];
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      newBlocks.push(block);
      continue;
    }

    const span = textSpans[spanCursor++];
    const headStart = span.start;
    const headCut = Math.min(span.end, headEnd);
    const headPart = headCut > headStart ? span.block.text.slice(0, headCut - headStart) : '';

    const tailCut = Math.max(span.start, tailStart);
    const tailEnd = span.end;
    const tailPart = tailCut < tailEnd ? span.block.text.slice(tailCut - headStart) : '';

    let blockText = headPart;

    if (!bannerInserted && span.end >= headEnd) {
      blockText += banner;
      bannerInserted = true;
    }

    blockText += tailPart;

    if (blockText.length > 0 || preparedBlocks.length === 1) {
      newBlocks.push({ ...block, text: blockText });
    }
  }

  return {
    changed: true,
    content: newBlocks,
    totalOmittedChars: omittedChars
  };
}
