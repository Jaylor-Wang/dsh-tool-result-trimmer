import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trimToolText, trimToolContent, computeSnapPoints, countLines, stripAnsi } from '../lib/trimmer.js';

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
});
