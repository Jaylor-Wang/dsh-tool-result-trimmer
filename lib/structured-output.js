// Inspect the same separator-free text projection used by mechanical trimming.
export function inspectStructuredOutput(blocks) {
  const textBlocks = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string');
  if (!textBlocks.length) return null;
  const text = textBlocks.map(block => block.text).join('');
  if (!/^[ \t\r\n]*(?:[\[{"\-\d]|true|false|null)/.test(text)) return null;
  try {
    const value = JSON.parse(text);
    return { text, value, singleTextBlock: textBlocks.length === 1 };
  } catch {
    return null;
  }
}

// Limit both the number and serialized size of samples, without cutting JSON values.
export function summarizeArray(value, originalText, headBudget, tailBudget, savedPath = null) {
  try {
    if (!Array.isArray(value) || value.length < 3) return null;
    // Do not reserialize numeric tokens that JSON.parse cannot represent exactly.
    const numbers = originalText.replace(/"(?:\\.|[^"\\])*"/g, '').match(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
    if (numbers.some(number => {
      const value = Number(number);
      return /[.eE]/.test(number) || number === '-0' || !Number.isSafeInteger(value);
    })) return null;
    const head = [];
    const tail = [];
    for (let i = 0; i < Math.min(3, value.length); i++) {
      const candidate = value.slice(0, i + 1);
      if (JSON.stringify(candidate).length > headBudget) break;
      head.push(value[i]);
    }
    for (let i = 0; i < Math.min(3, value.length - head.length); i++) {
      const candidate = value.slice(value.length - i - 1);
      if (JSON.stringify(candidate).length > tailBudget) break;
      tail.unshift(value[value.length - i - 1]);
    }
    if (!head.length || !tail.length || head.length + tail.length >= value.length) return null;
    const text = JSON.stringify({
      _dshToolResultTrimmer: 'array-summary',
      totalItems: value.length,
      head,
      tail,
      spilloverPath: typeof savedPath === 'string' ? savedPath : savedPath?.locator ?? null,
      ...(savedPath?.retrievalHint ? { spilloverRetrievalHint: savedPath.retrievalHint } : {})
    });
    return text.length < originalText.length ? text : null;
  } catch {
    return null;
  }
}
