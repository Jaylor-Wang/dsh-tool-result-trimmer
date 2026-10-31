import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writeSpillover,
  getSpilloverDirectory,
  sanitizeCallId,
  generateSpilloverFilename,
  pruneSpilloverDirectory,
  DEFAULT_SPILLOVER_CONFIG
} from '../lib/spillover.js';
import { apply } from '../lib/index.js';
import { trimToolText, trimToolContent, formatBanner } from '../lib/trimmer.js';

describe('Spillover unit tests', () => {
  const testDir = path.join(os.tmpdir(), `dsh-test-spillover-${Date.now()}`);

  after(() => {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('should return null when spillover is disabled', () => {
    const res = writeSpillover('some large text', { enabled: false });
    assert.equal(res, null);
  });

  it('should return null when text is empty', () => {
    const res = writeSpillover('', { enabled: true, directory: testDir });
    assert.equal(res, null);
  });

  it('should return null when text exceeds maxFileBytes', () => {
    const res = writeSpillover('1234567890', {
      enabled: true,
      directory: testDir,
      maxFileBytes: 5 // only allows 5 bytes
    });
    assert.equal(res, null);
  });

  it('should write raw text atomically to target directory and return file path', () => {
    const rawContent = 'Line 1: build diagnostics\nLine 2: error trace\n'.repeat(50);
    const savedPath = writeSpillover(rawContent, {
      enabled: true,
      directory: testDir
    }, { callId: 'bash-call-123' });

    assert.ok(savedPath);
    assert.ok(fs.existsSync(savedPath));
    const diskContent = fs.readFileSync(savedPath, 'utf8');
    assert.equal(diskContent, rawContent);

    // Verify filename security: contains sanitized callId, does NOT contain command or raw text
    const filename = path.basename(savedPath);
    assert.ok(filename.startsWith('trimmed-bash-call-123-'));
    assert.ok(filename.endsWith('.log'));
    assert.ok(!filename.includes('diagnostics'));
  });

  it('should sanitize unsafe callIds', () => {
    assert.equal(sanitizeCallId('../../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeCallId('call#1?*<>:|"'), 'call1');
    assert.equal(sanitizeCallId(''), 'exec');
    assert.equal(sanitizeCallId(undefined), 'exec');
  });

  it('should format banner with savedPath when provided', () => {
    const bannerWithout = formatBanner(1000, 20);
    assert.equal(bannerWithout, '\n\n[... tool output trimmed: omitted 1,000 characters (~20 lines) ...]\n\n');

    const bannerWith = formatBanner(1000, 20, 'C:\\tmp\\trimmed-123.log');
    assert.equal(bannerWith, '\n\n[... tool output trimmed: omitted 1,000 characters (~20 lines); full output saved to C:\\tmp\\trimmed-123.log ...]\n\n');
  });

  it('should prune expired files according to TTL', () => {
    const pruneDir = path.join(os.tmpdir(), `dsh-test-prune-${Date.now()}`);
    fs.mkdirSync(pruneDir, { recursive: true });

    try {
      const oldFile = path.join(pruneDir, generateSpilloverFilename('old', 'old content'));
      const newFile = path.join(pruneDir, generateSpilloverFilename('new', 'new content'));
      fs.writeFileSync(oldFile, 'old content');
      fs.writeFileSync(newFile, 'new content');

      // Set old file mtime to 10 days ago
      const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

      pruneSpilloverDirectory(pruneDir, { ttlMs: 1000 * 60 * 60 * 24 }, true); // TTL 1 day

      assert.ok(!fs.existsSync(oldFile), 'Old file should be pruned');
      assert.ok(fs.existsSync(newFile), 'New file should be kept');
    } finally {
      fs.rmSync(pruneDir, { recursive: true, force: true });
    }
  });

  it('should enforce maxFiles and maxTotalBytes during pruning', () => {
    const budgetDir = path.join(os.tmpdir(), `dsh-test-budget-${Date.now()}`);
    fs.mkdirSync(budgetDir, { recursive: true });

    try {
      // Use production filename shapes so cleanup only touches owned files.
      const filenames = [];
      for (let i = 1; i <= 5; i++) {
        const filename = generateSpilloverFilename(`file-${i}`, 'x'.repeat(100));
        filenames.push(filename);
        const p = path.join(budgetDir, filename);
        fs.writeFileSync(p, 'x'.repeat(100)); // 100 bytes each
        const mtime = (Date.now() - (10 - i) * 1000) / 1000;
        fs.utimesSync(p, mtime, mtime);
      }

      // Limit to 2 files maximum
      pruneSpilloverDirectory(budgetDir, { maxFiles: 2, maxTotalBytes: 10000, ttlMs: 99999999 }, true);

      const remaining = fs.readdirSync(budgetDir);
      assert.equal(remaining.length, 2);
      assert.ok(remaining.includes(filenames[3]));
      assert.ok(remaining.includes(filenames[4]));
    } finally {
      fs.rmSync(budgetDir, { recursive: true, force: true });
    }
  });

  it('should fail-open gracefully when directory creation fails or write is blocked', () => {
    // A real file deterministically blocks directory creation on every platform.
    fs.mkdirSync(testDir, { recursive: true });
    const invalidPath = path.join(testDir, 'not-a-directory');
    fs.writeFileSync(invalidPath, 'fixture');
    const res = writeSpillover('some content', {
      enabled: true,
      directory: invalidPath
    });
    // Must return null without throwing
    assert.equal(res, null);
  });
});

describe('Spillover integration with Plugin pipeline', () => {
  const pluginSpillDir = path.join(os.tmpdir(), `dsh-plugin-spill-${Date.now()}`);

  function createMockCtx() {
    const listeners = [];
    return {
      listeners,
      on(event, handler, options) {
        listeners.push({ event, handler, options });
      }
    };
  }

  after(() => {
    try {
      if (fs.existsSync(pluginSpillDir)) {
        fs.rmSync(pluginSpillDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('should save full raw output to spillover directory when mechanical trimming occurs', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1000,
      headChars: 200,
      tailChars: 300,
      spillover: {
        enabled: true,
        directory: pluginSpillDir
      }
    });

    const handler = ctx.listeners[0].handler;
    const longText = 'Error diagnostic trace line...\n'.repeat(100); // ~3100 chars
    const exec = { name: 'bash', callId: 'call-spill-1', arguments: { command: 'cargo build' } };
    const result = { content: [{ type: 'text', text: longText }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));

    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content);
    const trimmedText = decision.content[0].text;
    assert.ok(trimmedText.includes('[... tool output trimmed:'));
    assert.ok(trimmedText.includes('full output saved to'));

    // Extract file path from banner
    const match = trimmedText.match(/full output saved to ([^ \]]+)/);
    assert.ok(match, 'Banner must contain saved file path');
    const savedFile = match[1];
    assert.ok(fs.existsSync(savedFile));
    assert.equal(fs.readFileSync(savedFile, 'utf8'), longText);
  });

  it('should NOT write spillover file if output only undergoes ANSI stripping within threshold', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 10000,
      spillover: {
        enabled: true,
        directory: pluginSpillDir
      }
    });

    const handler = ctx.listeners[0].handler;
    const initialFiles = fs.existsSync(pluginSpillDir) ? fs.readdirSync(pluginSpillDir).length : 0;

    const exec = { name: 'bash', callId: 'call-ansi-only', arguments: { command: 'echo test' } };
    const result = { content: [{ type: 'text', text: '\x1b[32mSUCCESS\x1b[0m everything ok' }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content[0].text, 'SUCCESS everything ok');

    const currentFiles = fs.existsSync(pluginSpillDir) ? fs.readdirSync(pluginSpillDir).length : 0;
    assert.equal(currentFiles, initialFiles, 'No file should be written for pure ANSI strip without truncation');
  });

  it('should save pre-reduction raw text when semantic reduction is followed by mechanical trimming', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 500, // Small threshold so even reduced output exceeds it
      headChars: 100,
      tailChars: 100,
      spillover: {
        enabled: true,
        directory: pluginSpillDir
      }
    });

    const handler = ctx.listeners[0].handler;
    // Dirty git status with 200 modified files (~6000 chars)
    const dirtyFiles = Array.from({ length: 150 }, (_, i) => `\tmodified:   src/file_${i}.ts\n`).join('');
    const rawGitStatus = `On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n${dirtyFiles}\nno changes added to commit (use "git add" and/or "git commit -a")`;

    const exec = { name: 'bash', callId: 'call-git-spill', arguments: { command: 'git status' } };
    const result = { content: [{ type: 'text', text: rawGitStatus }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content);
    const trimmed = decision.content[0].text;
    assert.ok(trimmed.includes('full output saved to'));

    const match = trimmed.match(/full output saved to ([^ \]]+)/);
    assert.ok(match);
    const savedPath = match[1];
    const diskContent = fs.readFileSync(savedPath, 'utf8');

    // Crucial requirement: saved file must contain pre-reduction raw content (e.g. including the (use "git add...") hints)
    assert.equal(diskContent, rawGitStatus);
  });

  it('should bypass spillover on bypass directive (# no-trim)', async () => {
    const ctx = createMockCtx();
    apply(ctx, {
      thresholdChars: 1000,
      spillover: {
        enabled: true,
        directory: pluginSpillDir
      }
    });

    const handler = ctx.listeners[0].handler;
    const initialFiles = fs.existsSync(pluginSpillDir) ? fs.readdirSync(pluginSpillDir).length : 0;

    const exec = { name: 'bash', callId: 'call-bypass', arguments: { command: 'npm test # no-trim' } };
    const longText = 'Test log...\n'.repeat(100);
    const result = { content: [{ type: 'text', text: longText }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.equal(decision.content, undefined); // untouched

    const currentFiles = fs.existsSync(pluginSpillDir) ? fs.readdirSync(pluginSpillDir).length : 0;
    assert.equal(currentFiles, initialFiles, 'No spillover file for bypassed commands');
  });

  it('should fail-open and complete trimming normally if spillover write fails', async () => {
    const ctx = createMockCtx();
    // A file in place of a directory exercises a portable disk failure.
    fs.mkdirSync(pluginSpillDir, { recursive: true });
    const blockedDirectory = path.join(pluginSpillDir, 'not-a-directory');
    fs.writeFileSync(blockedDirectory, 'fixture');
    apply(ctx, {
      thresholdChars: 1000,
      headChars: 200,
      tailChars: 300,
      spillover: {
        enabled: true,
        directory: blockedDirectory
      }
    });

    const handler = ctx.listeners[0].handler;
    const longText = 'Some error lines...\n'.repeat(100);
    const exec = { name: 'bash', callId: 'call-fail-disk', arguments: { command: 'mvn clean install' } };
    const result = { content: [{ type: 'text', text: longText }] };

    const decision = await handler(exec, result, async () => ({ kind: 'accept' }));
    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content);
    // Trimming still succeeded with standard banner (without throwing)
    assert.ok(decision.content[0].text.includes('[... tool output trimmed:'));
    assert.ok(!decision.content[0].text.includes('full output saved to'));
  });
});
