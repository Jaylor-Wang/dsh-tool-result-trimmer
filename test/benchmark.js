import { trimToolContent, trimToolText, stripAnsi } from '../lib/trimmer.js';

function runBenchmark(name, fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < Math.min(iterations, 100); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const elapsed = performance.now() - start;
  const avgMs = elapsed / iterations;
  const opsSec = Math.round((iterations / elapsed) * 1000);

  console.log(
    `[Benchmark] ${name.padEnd(45)}: ${avgMs.toFixed(4)} ms/op (${opsSec.toLocaleString()} ops/sec)`
  );
}

console.log('--- Tool Result Trimmer Performance Benchmark ---');

// 1. Threshold pass-through (zero allocation path)
const shortCleanBlocks = [
  { type: 'text', text: 'Command executed with exit code 0.' },
  { type: 'text', text: 'Output: completed 12 tasks in 45ms.' }
];
runBenchmark('Pass-through (within threshold, no ANSI)', () => {
  trimToolContent(shortCleanBlocks, { thresholdChars: 10000 });
}, 50000);

// 2. ANSI-only cleaning (within threshold)
const shortAnsiBlocks = [
  { type: 'text', text: '\x1b[32mPASS\x1b[0m test/core.test.js (120ms)\n\x1b[32mPASS\x1b[0m test/util.test.js (80ms)' }
];
runBenchmark('ANSI stripping (within threshold)', () => {
  trimToolContent(shortAnsiBlocks, { thresholdChars: 10000, stripAnsi: true });
}, 20000);

// 3. Oversized single-block text (100,000 characters build failure log)
const longLines = [];
for (let i = 1; i <= 2000; i++) {
  longLines.push(`[step-${i}] 2026-03-30T10:00:${String(i % 60).padStart(2, '0')}.000Z Compiling package target module chunk #${i}...`);
}
longLines.push('Error: Build failed with 14 errors. See above diagnostics.');
const massiveText = longLines.join('\n');
const massiveSingleBlock = [{ type: 'text', text: massiveText }];
console.log(`Massive single block size: ${(massiveText.length / 1024).toFixed(1)} KB`);

runBenchmark('Oversized 100KB single-block trim', () => {
  trimToolContent(massiveSingleBlock, { thresholdChars: 10000, headChars: 1500, tailChars: 5000 });
}, 5000);

// 4. Oversized multi-block text (8 blocks totaling ~80,000 characters)
const multiBlocks = [];
for (let b = 1; b <= 8; b++) {
  multiBlocks.push({
    type: 'text',
    text: `=== Log Block ${b} ===\n` + 'Info log line payload...\n'.repeat(300)
  });
}
const multiBlocksTotal = multiBlocks.reduce((sum, b) => sum + b.text.length, 0);
console.log(`Multi-block aggregate size: ${(multiBlocksTotal / 1024).toFixed(1)} KB across ${multiBlocks.length} blocks`);

runBenchmark('Oversized ~80KB multi-block trim', () => {
  trimToolContent(multiBlocks, { thresholdChars: 10000, headChars: 1500, tailChars: 5000 });
}, 2000);

// 5. Massive text with ANSI escape sequences (60,000 characters)
const ansiLines = [];
for (let i = 1; i <= 1000; i++) {
  ansiLines.push(`\x1b[34m[INFO]\x1b[0m \x1b[1mTask ${i}\x1b[0m: \x1b[32mSuccess\x1b[0m in 12ms`);
}
ansiLines.push('\x1b[31;1mFATAL:\x1b[0m Exit code 1 returned from worker process.');
const massiveAnsiText = ansiLines.join('\n');
const massiveAnsiBlock = [{ type: 'text', text: massiveAnsiText }];

runBenchmark('Oversized 60KB ANSI-heavy trim', () => {
  trimToolContent(massiveAnsiBlock, { thresholdChars: 10000, headChars: 1500, tailChars: 5000, stripAnsi: true });
}, 1000);

console.log('--- Benchmark completed successfully ---');
