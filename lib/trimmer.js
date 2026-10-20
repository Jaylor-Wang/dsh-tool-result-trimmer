/**
 * Pure trimming logic for DSH tool execution results.
 *
 * Provides eager, tail-heavy, line-aware trimming of oversized tool outputs.
 */

const DEFAULT_THRESHOLD = 10000;
const DEFAULT_HEAD = 1500;
const DEFAULT_TAIL = 5000;
const MIN_SAVINGS = 200; // minimum character savings required to justify inserting a banner

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

  // 2. Tail boundary: look for first newline at or after (total - tailBudget)
  const idealTailStart = total - tailBudget;
  let tailNewline = text.indexOf('\n', idealTailStart);
  let tailStart;
  if (tailNewline !== -1) {
    tailStart = tailNewline + 1; // Start tail immediately after the newline
  } else {
    // Look backwards from idealTailStart
    const prevNewline = text.lastIndexOf('\n', idealTailStart);
    if (prevNewline !== -1 && prevNewline > headEnd) {
      tailStart = prevNewline + 1;
    } else {
      // Fallback: character boundary
      tailStart = idealTailStart;
    }
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
 * @param {number} [options.thresholdChars]
 * @param {number} [options.headChars]
 * @param {number} [options.tailChars]
 * @returns {{ changed: boolean, text: string, omittedChars: number, omittedLines: number }}
 */
export function trimToolText(text, options = {}) {
  if (typeof text !== 'string') {
    return { changed: false, text, omittedChars: 0, omittedLines: 0 };
  }

  const threshold = options.thresholdChars ?? DEFAULT_THRESHOLD;
  if (text.length <= threshold) {
    return { changed: false, text, omittedChars: 0, omittedLines: 0 };
  }

  const headBudget = options.headChars ?? DEFAULT_HEAD;
  const tailBudget = options.tailChars ?? DEFAULT_TAIL;

  const points = computeSnapPoints(text, headBudget, tailBudget);
  if (!points) {
    return { changed: false, text, omittedChars: 0, omittedLines: 0 };
  }

  const { headEnd, tailStart } = points;
  const omittedText = text.slice(headEnd, tailStart);
  const omittedChars = omittedText.length;
  const omittedLines = countLines(omittedText);
  const banner = formatBanner(omittedChars, omittedLines);

  const trimmedText = text.slice(0, headEnd) + banner + text.slice(tailStart);

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
 * @returns {{ changed: boolean, content: Array<object>, totalOmittedChars: number }}
 */
export function trimToolContent(blocks, options = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { changed: false, content: blocks, totalOmittedChars: 0 };
  }

  // Calculate total characters in text blocks
  let totalTextChars = 0;
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      totalTextChars += block.text.length;
    }
  }

  const threshold = options.thresholdChars ?? DEFAULT_THRESHOLD;
  if (totalTextChars <= threshold) {
    return { changed: false, content: blocks, totalOmittedChars: 0 };
  }

  let totalOmittedChars = 0;
  let changed = false;

  const newBlocks = blocks.map(block => {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      return block;
    }

    // Only trim blocks that are themselves over budget or contribute to overflow
    if (block.text.length <= (options.headChars ?? DEFAULT_HEAD)) {
      return block;
    }

    const res = trimToolText(block.text, options);
    if (res.changed) {
      changed = true;
      totalOmittedChars += res.omittedChars;
      return {
        ...block,
        text: res.text
      };
    }
    return block;
  });

  return {
    changed,
    content: changed ? newBlocks : blocks,
    totalOmittedChars
  };
}
