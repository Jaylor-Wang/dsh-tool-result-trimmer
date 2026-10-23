import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trimToolText, trimToolContent, computeSnapPoints, countLines, stripAnsi, isBypassed } from '../lib/trimmer.js';

describe('stripAnsi', () => {
  it('should strip SGR color and styling codes', () => {
    const colored = '\x1b[31mError:\x1b[0m \x1b[1;32mBuild succeeded\x1b[0m in \x1b[4m200ms\x1b[24m';
    assert.equal(stripAnsi(colored), 'Error: Build succeeded in 200ms');
  });

  it('should strip cursor controls, clear line, and OSC title codes', () => {
    const raw = '\x1b[2K\x1b[1GProgress: 100%\x1b[?25h\x1b(B \x1b]0;npm install\x07Done';
    assert.equal(stripAnsi(raw), 'Progress: 100% Done');
  });

  it('should leave plain text completely unchanged', () => {
    const plain = 'Normal text without escape codes 12345.';
    assert.equal(stripAnsi(plain), plain);
  });
});

describe('trimToolText', () => {
  it('should not trim text below threshold', () => {
    const text = 'Hello world, short output.';
    const res = trimToolText(text, { thresholdChars: 1000 });
    assert.equal(res.changed, false);
    assert.equal(res.text, text);
    assert.equal(res.omittedChars, 0);
  });

  it('should trim oversized multi-line text with line-aware snapping', () => {
    // Generate 500 lines of test output
    const lines = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(`Line ${String(i).padStart(4, '0')}: execution step diagnostic log payload dummy data...`);
    }
    const fullText = lines.join('\n');
    assert.ok(fullText.length > 20000);

    const res = trimToolText(fullText, {
      thresholdChars: 5000,
      headChars: 1000,
      tailChars: 2000
    });

    assert.equal(res.changed, true);
    assert.ok(res.omittedChars > 15000);
    assert.ok(res.omittedLines > 200);

    // Head should start with Line 0001
    assert.ok(res.text.startsWith('Line 0001:'));
    // Tail should end with Line 0500
    assert.ok(res.text.endsWith('Line 0500: execution step diagnostic log payload dummy data...'));

    // Verify omission banner exists
    assert.ok(res.text.includes('[... tool output trimmed: omitted'));
    assert.ok(res.text.includes('lines) ...]'));

    // Verify line cleanliness:
    // Split by banner and ensure head ends cleanly and tail starts cleanly
    const parts = res.text.split(/\n\n\[\.\.\. tool output trimmed: [^\n]+ \.\.\.\]\n\n/);
    assert.equal(parts.length, 2);

    const headPart = parts[0];
    const tailPart = parts[1];

    // Head part should end with a newline or be a clean line
    assert.ok(!headPart.endsWith('Line 0')); // Not cut mid-word
    // Tail part should start with 'Line '
    assert.ok(tailPart.startsWith('Line '));
  });

  it('should handle large single line with no newlines gracefully', () => {
    const giantLine = 'A'.repeat(15000);
    const res = trimToolText(giantLine, {
      thresholdChars: 5000,
      headChars: 1000,
      tailChars: 2000
    });

    assert.equal(res.changed, true);
    assert.equal(res.omittedLines, 0);
    assert.ok(res.omittedChars > 10000);
    assert.ok(res.text.includes('[... tool output trimmed: omitted 12,000 characters ...]'));
  });

  it('should handle unicode and multibyte Chinese characters safely', () => {
    const lines = [];
    for (let i = 1; i <= 300; i++) {
      lines.push(`第 ${i} 行: 执行任务正常运行中，测试多字节中文字符完整性，绝不断裂与乱码！`);
    }
    const fullText = lines.join('\n');

    const res = trimToolText(fullText, {
      thresholdChars: 4000,
      headChars: 800,
      tailChars: 1200
    });

    assert.equal(res.changed, true);
    assert.ok(res.omittedChars > 5000);
    assert.ok(res.text.startsWith('第 1 行:'));
    assert.ok(res.text.endsWith('绝不断裂与乱码！'));
  });

  it('should not trim if headBudget + tailBudget >= total', () => {
    const text = 'A'.repeat(6000);
    const res = trimToolText(text, {
      thresholdChars: 5000,
      headChars: 3500,
      tailChars: 3500
    });
    assert.equal(res.changed, false);
    assert.equal(res.text, text);
  });

  it('should not bisect UTF-16 surrogate pairs (emoji) at head or tail cutoffs', () => {
    const hasUnpaired = (str) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str);

    // 1. Cut at head boundary (index 10 is high surrogate, index 11 is low surrogate)
    const headEmojiText = 'A'.repeat(10) + '😀' + 'B'.repeat(500);
    const headRes = trimToolText(headEmojiText, {
      thresholdChars: 100,
      headChars: 11,
      tailChars: 50
    });
    assert.equal(headRes.changed, true);
    assert.equal(hasUnpaired(headRes.text), false);
    assert.ok(headRes.text.startsWith('AAAAAAAAAA\n\n[... tool output trimmed:'));

    // 2. Cut at tail boundary
    // total = 600, tailChars = 100 -> idealTailStart = 500
    // Place emoji at index 499 (high surrogate at 499, low at 500)
    const tailEmojiText = 'A'.repeat(499) + '😀' + 'B'.repeat(99);
    const tailRes = trimToolText(tailEmojiText, {
      thresholdChars: 200,
      headChars: 50,
      tailChars: 100
    });
    assert.equal(tailRes.changed, true);
    assert.equal(hasUnpaired(tailRes.text), false);
    assert.ok(tailRes.text.endsWith('BBBBBBBBBB'));
  });

  it('should bound backward search for tail newline to prevent unbounded tail expansion', () => {
    // 4000 'A's + newline + 4000 'B's. tailBudget is 500.
    // The previous newline is 3500 chars before idealTailStart.
    // Backward search should NOT expand tail to 4000 characters.
    const text = 'A'.repeat(4000) + '\n' + 'B'.repeat(4000);
    const res = trimToolText(text, {
      thresholdChars: 2000,
      headChars: 500,
      tailChars: 500
    });
    assert.equal(res.changed, true);
    // Tail should be bounded near 500 chars (around 500, not 4000)
    const parts = res.text.split(/\n\n\[\.\.\. tool output trimmed: [^\n]+ \.\.\.\]\n\n/);
    assert.equal(parts.length, 2);
    assert.ok(parts[1].length <= 600);
  });
});

describe('trimToolContent', () => {
  it('should preserve non-text blocks (e.g. image) completely untouched', () => {
    const imageBlock = {
      type: 'image',
      data: 'base64imagedata...',
      mimeType: 'image/png'
    };
    const textBlock = {
      type: 'text',
      text: 'B'.repeat(15000)
    };

    const blocks = [imageBlock, textBlock];
    const res = trimToolContent(blocks, {
      thresholdChars: 5000,
      headChars: 1000,
      tailChars: 2000
    });

    assert.equal(res.changed, true);
    assert.equal(res.content.length, 2);
    // Image block is reference-identical or untouched
    assert.deepEqual(res.content[0], imageBlock);
    // Text block is trimmed
    assert.ok(res.content[1].text.includes('[... tool output trimmed:'));
  });

  it('should return original content if total text within threshold', () => {
    const blocks = [
      { type: 'text', text: 'Small output' }
    ];
    const res = trimToolContent(blocks, { thresholdChars: 10000 });
    assert.equal(res.changed, false);
    assert.equal(res.content, blocks);
  });

  it('should strip ANSI escape sequences even if text is within threshold', () => {
    const blocks = [
      { type: 'text', text: '\x1b[32mPASS\x1b[0m test/app.test.js' }
    ];
    const res = trimToolContent(blocks, { thresholdChars: 10000, stripAnsi: true });
    assert.equal(res.changed, true);
    assert.equal(res.content[0].text, 'PASS test/app.test.js');
  });

  it('should respect stripAnsi: false and keep ANSI if requested', () => {
    const blocks = [
      { type: 'text', text: '\x1b[32mPASS\x1b[0m test/app.test.js' }
    ];
    const res = trimToolContent(blocks, { thresholdChars: 10000, stripAnsi: false });
    assert.equal(res.changed, false);
    assert.equal(res.content[0].text, '\x1b[32mPASS\x1b[0m test/app.test.js');
  });

  it('should trim across multiple text blocks when aggregate length exceeds threshold', () => {
    // 2 blocks each 4000 characters (total 8000), threshold is 6000
    // Neither individual block exceeds threshold, but their aggregate does.
    const blocks = [
      { type: 'text', text: 'Head line 1\n' + 'A'.repeat(4000) },
      { type: 'text', text: 'B'.repeat(4000) + '\nTail line end' }
    ];

    const res = trimToolContent(blocks, {
      thresholdChars: 6000,
      headChars: 500,
      tailChars: 500
    });

    assert.equal(res.changed, true);
    assert.ok(res.totalOmittedChars > 6500);

    // Total length across all returned blocks should be strictly constrained
    const totalOutputLen = res.content.reduce((sum, b) => sum + (b.text?.length ?? 0), 0);
    assert.ok(totalOutputLen < 2000);

    // Verify Head preserved in first block and Tail in last
    assert.ok(res.content[0].text.startsWith('Head line 1\n'));
    assert.ok(res.content.at(-1).text.endsWith('Tail line end'));
  });

  it('should preserve intervening non-text blocks when trimming multi-block outputs', () => {
    const imageBlock = { type: 'image', data: 'data:image/png;base64,...' };
    const blocks = [
      { type: 'text', text: 'Start log...\n' + '1'.repeat(4000) },
      imageBlock,
      { type: 'text', text: '2'.repeat(4000) + '\nEnd log summary' }
    ];

    const res = trimToolContent(blocks, {
      thresholdChars: 6000,
      headChars: 500,
      tailChars: 500
    });

    assert.equal(res.changed, true);
    // Image block must be preserved intact
    const imgIndex = res.content.findIndex(b => b.type === 'image');
    assert.ok(imgIndex !== -1);
    assert.deepEqual(res.content[imgIndex], imageBlock);

    // First text block should contain head and banner
    assert.ok(res.content[0].text.startsWith('Start log...\n'));
    assert.ok(res.content[0].text.includes('[... tool output trimmed:'));

    // Second text block should contain tail
    assert.ok(res.content[2].text.endsWith('End log summary'));
  });

  it('should achieve true 0-allocation pass-through when input is within threshold and has no ANSI', () => {
    const blocks = [
      { type: 'text', text: 'Clean output line 1' },
      { type: 'text', text: 'Clean output line 2' }
    ];
    const res = trimToolContent(blocks, { thresholdChars: 1000 });
    assert.equal(res.changed, false);
    // Strict reference equality check: no array clone, no block clone
    assert.equal(res.content, blocks);
    assert.equal(res.content[0], blocks[0]);
    assert.equal(res.content[1], blocks[1]);
  });

  it('should gracefully pass through output without trimming when head + tail budgets overlap total length', () => {
    // Total length = 4000, but head (2500) + tail (2500) = 5000 > 4000
    // Even though total (4000) > threshold (3000), trimming cannot safely extract savings without overlapping
    const text = 'Line of execution text...\n'.repeat(150); // ~3900 chars
    const blocks = [{ type: 'text', text }];
    const res = trimToolContent(blocks, {
      thresholdChars: 3000,
      headChars: 2500,
      tailChars: 2500
    });
    // Should safely pass through without crashing or corrupting text
    assert.equal(res.changed, false);
    assert.equal(res.content[0].text, text);
    assert.equal(res.totalOmittedChars, 0);
  });
});

describe('isBypassed', () => {
  it('should return false for undefined or empty exec', () => {
    assert.equal(isBypassed(undefined), false);
    assert.equal(isBypassed(null), false);
    assert.equal(isBypassed({}), false);
  });

  it('should detect explicit bypassTrim and noTrim argument flags', () => {
    assert.equal(isBypassed({ arguments: { bypassTrim: true } }), true);
    assert.equal(isBypassed({ arguments: { noTrim: true } }), true);
    assert.equal(isBypassed({ arguments: { _bypassTrim: true } }), true);
    assert.equal(isBypassed({ arguments: { bypassTrim: false } }), false);
  });

  it('should detect environment variable prefixes in command strings', () => {
    assert.equal(isBypassed({ arguments: { command: 'DSH_TRIM_BYPASS=1 npm test' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'VAR=1 DSH_NO_TRIM=1 pytest' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'cd src && NO_TRIM=1 cargo check' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'npm test DSH_TRIM_BYPASS=0' } }), false);
    assert.equal(isBypassed({ arguments: { command: 'npm test' } }), false);
  });

  it('should detect inline comment directives in command strings and descriptions', () => {
    assert.equal(isBypassed({ arguments: { command: 'npm test # no-trim' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'git diff # [no-trim]' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'node build.js // bypass-trim' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'cat file.txt # raw-output' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'git log', description: 'check commits # no-trim' } }), true);
    assert.equal(isBypassed({ arguments: { command: 'npm test # ordinary comment' } }), false);
  });

  it('should respect process.env override when set', () => {
    const orig = process.env.DSH_TRIM_BYPASS;
    try {
      process.env.DSH_TRIM_BYPASS = '1';
      assert.equal(isBypassed({ arguments: { command: 'npm test' } }), true);
    } finally {
      if (orig !== undefined) {
        process.env.DSH_TRIM_BYPASS = orig;
      } else {
        delete process.env.DSH_TRIM_BYPASS;
      }
    }
  });
});
