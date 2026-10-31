import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import * as reducers from '../lib/reducers/index.js';

const fixturesDir = fileURLToPath(new URL('fixtures', import.meta.url));

const exec = command => ({ name: 'bash', arguments: { command } });
const cases = [
  ['tsc --build --verbose', 'Project build complete.'],
  ['vite build', 'vite v5.0.0 building for production...\ntransforming (1)...\ntransforming (2)...\n✓ 2 modules transformed.\ndist/index.js  1 kB\n✓ built in 1.2s'],
  ['webpack', 'asset main.js 5 KiB [emitted]\nwebpack 5.0.0 compiled successfully in 200 ms'],
  ['cargo build', '   Compiling alpha v1.0.0\n   Compiling beta v1.0.0\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.20s'],
  ['eslint .', 'Checked 2 files.'],
  ['prettier --check .', 'Checking formatting...\nChecking formatting...\nAll matched files use Prettier code style!'],
  ['ruff check .', 'All checks passed!'],
  ['biome check .', 'Checked 2 files in 10ms. No fixes applied.']
];

describe('P3 build and lint reducers', () => {
  for (const [command, text] of cases) {
    const kind = /^(?:eslint|prettier|ruff|biome)/.test(command) ? 'lint' : 'build';
    it(`${command}: protects failures, warnings and unknown formats`, () => {
      const reduce = kind === 'build' ? reducers.reduceBuild : reducers.reduceLint;
      assert.equal(typeof reduce, 'function');
      assert.equal(reduce(exec(command), text, { value: { kind: 'foreground', exitCode: 1 } }), null);
      assert.equal(reduce(exec(command), `${text}\n[exit code: 2]`, {}), null);
      assert.equal(reduce(exec(command), 'unknown output\npath:42:5 error detail', {}), null);
      const warning = `${text}\nwarning: src/a.js:3:4 keep diagnostic`;
      const reduced = reduce(exec(command), warning, {});
      assert.ok(reduced === null || reduced.includes('warning: src/a.js:3:4 keep diagnostic'));
    });
  }

  for (const [command, text] of [
    ['tsc --noEmit --extendedDiagnostics', 'Files: 85\nMemory used: 26327K\nTotal time: 0.061s'],
    ['tsc --build --verbose', "12:40:16 AM - Projects in this build:\n    * tsconfig.json\n"],
    ['eslint .', ''],
    ['ruff check .', 'All checks passed!'],
    ['biome check .', 'Checked 2 files in 10ms. No fixes applied.']
  ]) {
    it(`${command}: leaves output unchanged without a safe redundant format`, () => {
      const reduce = /^(?:tsc|webpack)/.test(command) ? reducers.reduceBuild : reducers.reduceLint;
      assert.equal(reduce(exec(command), text, {}), null);
      assert.deepEqual(reducers.applySemanticReducers(exec(command), text, {}), { reduced: false, text });
    });
  }

  it('reduces only explicit safe Vite progress and retains all asset paths', () => {
    const text = cases[1][1];
    const reduced = reducers.reduceBuild(exec('NODE_ENV=production npx vite.cmd build'), text, {});
    assert.ok(reduced && reduced.length < text.length);
    assert.ok(reduced.includes('dist/index.js'));
    assert.ok(reduced.includes('✓ built in 1.2s'));
    assert.equal(reducers.reduceBuild(exec('vite build'), reduced, {}), null);
  });

  it('reduces repeated Prettier progress while keeping the success message', () => {
    const text = cases[5][1];
    const reduced = reducers.reduceLint(exec('pnpm exec prettier.exe --check .'), text, {});
    assert.equal(reduced, 'Checking formatting...\nAll matched files use Prettier code style!');
    assert.equal(reducers.reduceLint(exec('prettier --check .'), reduced, {}), null);
  });

  it('reduces webpack progress while preserving assets, statistics and completion', () => {
    const text = '10% building\r\n25% building\r\nasset main.js 5 KiB [emitted]\r\nwebpack 5.90.0 compiled successfully in 200 ms\r\n[exit code: 0]\r\n';
    const expected = 'asset main.js 5 KiB [emitted]\r\nwebpack 5.90.0 compiled successfully in 200 ms\r\n[exit code: 0]\r\n';
    const command = 'NODE_ENV=production npx webpack.cmd --progress';
    assert.equal(reducers.reduceBuild(exec(command), text, {}), expected);
    assert.equal(reducers.reduceBuild(exec(command), expected, {}), null);
    assert.equal(reducers.applySemanticReducers(exec(command), text, {}).text, expected);
    assert.equal(reducers.reduceBuild(exec('webpack --watch --progress'), text, {}), null);
    assert.equal(reducers.reduceBuild(exec('webpack --progress'), text.replace('25% building', '25% building src/index.js'), {}).includes('25% building src/index.js'), true);
    assert.equal(reducers.reduceBuild(exec('webpack --progress'), text.replace('compiled successfully', 'compiled with 1 warning'), {}), null);
    assert.equal(reducers.reduceBuild(exec('webpack --progress'), text, { value: { kind: 'foreground', exitCode: 1 } }), null);
    assert.equal(reducers.reduceBuild(exec('webpack --progress'), '10% building\nunknown conclusion', {}), null);
    assert.equal(reducers.reduceBuild(exec('webpack'), text, {}), null);
  });

  it('reduces Cargo compilation progress and retains completion statistics', () => {
    const text = cases[3][1];
    const reduced = reducers.reduceBuild(exec('RUST_LOG=info cargo.exe build --release'), text, {});
    assert.ok(reduced && reduced.includes('Finished `dev` profile'));
    assert.ok(!reduced.includes('Compiling alpha'));
    assert.equal(reducers.reduceBuild(exec('cargo build'), reduced, {}), null);
  });

  it('preserves diagnostics and unknown lines byte-for-byte during reduction', () => {
    const text = `vite v5 building for production...\r\ntransforming (1)...\r\nKEEP src/file.ts:12:5\r\n✓ built in 1s\r\n[exit code: 0]\r\n`;
    const reduced = reducers.reduceBuild(exec('vite build'), text, {});
    assert.equal(reduced, text.replace('transforming (1)...\r\n', ''));
    assert.equal(reducers.reduceBuild(exec('vite build'), text.replace('KEEP', 'warning:'), {}), null);
  });

  it('does not infer a tool from shell chains, arbitrary scripts or quoted arguments', () => {
    const text = cases[1][1];
    for (const cmd of ['echo vite build', 'vite build && npm test', 'npm run build', 'echo "vite build"', 'vite build > output.log']) {
      assert.equal(reducers.reduceBuild(exec(cmd), text, {}), null, cmd);
    }
  });

  it('fails open when execution metadata cannot be inspected', () => {
    const broken = { get arguments() { throw new Error('inaccessible'); } };
    assert.equal(reducers.reduceBuild(broken, cases[1][1], {}), null);
    assert.equal(reducers.reduceLint(broken, cases[5][1], {}), null);
  });

  it('does not compress watch-mode or formatter write-mode output', () => {
    assert.equal(reducers.reduceBuild(exec('vite build --watch'), cases[1][1], {}), null);
    assert.equal(reducers.reduceBuild(exec('cargo build -w'), cases[3][1], {}), null);
    assert.equal(reducers.reduceLint(exec('prettier --check --write .'), cases[5][1], {}), null);
  });

  it('does not discard Vite progress lines containing source paths', () => {
    const text = 'transforming (1) src/main.js\ntransforming (2) src/other.js\n✓ built in 1s';
    assert.equal(reducers.reduceBuild(exec('vite build'), text, {}), null);
  });

  it('does not treat diagnostic-looking progress or failed text as harmless', () => {
    const text = 'vite v5 building for production...\ntransforming (1) ERROR: src/a.js\ntransforming (2) WARNING: src/b.js\n✓ 2 modules transformed.\n✓ built in 1s';
    assert.equal(reducers.reduceBuild(exec('vite build'), text, {}), null);
    assert.equal(reducers.reduceLint(exec('prettier --check .'), `${cases[5][1]}\n[warn] src/a.js`, {}), null);
  });

  it('registers separate switches and runs through the plugin without losing non-text blocks', async () => {
    const text = cases[1][1];
    assert.equal(reducers.applySemanticReducers(exec('vite build'), text, {}, { semanticReducers: { build: false } }).reduced, false);
    assert.equal(reducers.applySemanticReducers(exec('prettier --check .'), cases[5][1], {}, { semanticReducers: { lint: false } }).reduced, false);
    let handler;
    apply({ on(_event, fn) { handler = fn; } }, { thresholdChars: 10000 });
    const image = { type: 'image', data: 'unchanged' };
    const result = { content: [image, { type: 'text', text }], value: { kind: 'foreground', exitCode: 0 } };
    const decision = await handler(exec('vite build'), result, async () => ({ kind: 'accept' }));
    assert.equal(decision.content[0], image);
    assert.ok(decision.content[1].text.includes('✓ built in 1.2s'));
    assert.ok(decision.content[1].text.length < text.length);
  });

  it('reduces authentic webpack 5.112.2 output and fails open on real errors/warnings', () => {
    const successPath = path.join(fixturesDir, 'webpack-5.112.2-success.txt');
    const warningPath = path.join(fixturesDir, 'webpack-5.112.2-warning.txt');
    const errorPath = path.join(fixturesDir, 'webpack-5.112.2-error.txt');

    const successText = fs.readFileSync(successPath, 'utf8');
    const warningText = fs.readFileSync(warningPath, 'utf8');
    const errorText = fs.readFileSync(errorPath, 'utf8');

    const command = 'NODE_ENV=production npx webpack.cmd --progress';

    // 1. Success output: removes thousands of bytes of progress, keeps assets and stats
    const reduced = reducers.reduceBuild(exec(command), successText, {});
    assert.ok(reduced, 'Should reduce successful webpack output');
    assert.ok(reduced.length < successText.length / 10, 'Should significantly reduce 13KB progress output');
    assert.ok(reduced.includes('asset main.js'), 'Must preserve asset main.js');
    assert.ok(reduced.includes('compiled successfully'), 'Must preserve compilation conclusion');
    assert.ok(!reduced.includes('<s> [webpack.Progress]'), 'Must not contain webpack.Progress tags');

    // 1b. CRLF handling on authentic webpack progress
    const crlfSuccess = successText.replace(/\n/g, '\r\n');
    const crlfReduced = reducers.reduceBuild(exec(command), crlfSuccess, {});
    assert.ok(crlfReduced);
    assert.ok(crlfReduced.includes('asset main.js'));
    assert.ok(crlfReduced.includes('\r\n'));

    // 2. Idempotency on real output
    assert.equal(reducers.reduceBuild(exec(command), reduced, {}), null);

    // 3. Warning output fails open: returns null, preserves entire diagnostic
    assert.ok(warningText.includes('compiled with 1 warning'));
    assert.ok(warningText.includes('WARNING in'));
    assert.equal(reducers.reduceBuild(exec(command), warningText, {}), null);
    assert.equal(reducers.applySemanticReducers(exec(command), warningText, {}).reduced, false);

    // 3b. ANSI color-coded warning fails open and preserves ANSI sequences
    const ansiWarning = `\x1b[33m${warningText}\x1b[39m`;
    assert.equal(reducers.reduceBuild(exec(command), ansiWarning, {}), null);
    assert.equal(reducers.applySemanticReducers(exec(command), ansiWarning, {}).reduced, false);

    // 4. Error output fails open: returns null, preserves error details
    assert.ok(errorText.includes('compiled with 1 error'));
    assert.ok(errorText.includes('ERROR in'));
    assert.equal(reducers.reduceBuild(exec(command), errorText, { value: { kind: 'foreground', exitCode: 1 } }), null);
    assert.equal(reducers.applySemanticReducers(exec(command), errorText, { value: { kind: 'foreground', exitCode: 1 } }).reduced, false);

    // 5. Unknown format fails open
    assert.equal(reducers.reduceBuild(exec(command), 'Random text without success completion line', {}), null);
  });

  it('routes wrapped commands correctly through registry and plugin without packageManager collision', async () => {
    const viteText = 'vite v5.0.0 building for production...\ntransforming (1)...\ntransforming (2)...\n✓ 2 modules transformed.\ndist/index.js  1 kB\n✓ built in 1.2s\n';
    const warningText = 'vite v5.0.0 building for production...\n⠋ warning: src/file.ts:42:3 preserve this warning\n✓ built in 1.2s\n';
    const prettierText = 'Checking formatting...\nChecking formatting...\nAll matched files use Prettier code style!\n';

    const buildCommands = [
      'pnpm exec vite build',
      'npm exec vite build',
      'yarn exec vite build',
      'pnpm.cmd exec vite.exe build',
      'npx --yes vite build',
      'npx -y --no-install vite build',
      'npm exec --yes vite build',
      'pnpm exec --silent vite build',
      'pnpm --silent exec vite build'
    ];

    for (const cmd of buildCommands) {
      // 1. Registry dispatches to 'build', never 'packageManager'
      const outcome = reducers.applySemanticReducers(exec(cmd), viteText, {});
      assert.equal(outcome.reduced, true, `Failed to reduce for ${cmd}`);
      assert.equal(outcome.reducerName, 'build', `Wrong reducer for ${cmd}`);
      assert.ok(!outcome.text.includes('transforming (1)'), `Failed to strip progress for ${cmd}`);
      assert.ok(outcome.text.includes('✓ built in 1.2s'), `Lost completion line for ${cmd}`);

      // 2. Trailing newline and CRLF do not cause packageManager to steal
      const crlfText = viteText.replace(/\n/g, '\r\n');
      const crlfOutcome = reducers.applySemanticReducers(exec(cmd), crlfText, {});
      assert.equal(crlfOutcome.reduced, true);
      assert.equal(crlfOutcome.reducerName, 'build');
      assert.ok(!crlfOutcome.text.includes('transforming (1)'));

      // 3. Diagnostics (warning with spinner) are strictly preserved; packageManager must not delete them
      const warnOutcome = reducers.applySemanticReducers(exec(cmd), warningText, {});
      assert.equal(warnOutcome.reduced, false, `Warning should not be reduced for ${cmd}`);
      assert.ok(warnOutcome.text.includes('warning: src/file.ts:42:3'), `Diagnostic lost for ${cmd}`);

      // 4. When build reducer is disabled, packageManager does NOT step in and erase warnings
      const disabledOutcome = reducers.applySemanticReducers(exec(cmd), warningText, {}, { semanticReducers: { build: false } });
      assert.equal(disabledOutcome.reduced, false);
      assert.ok(disabledOutcome.text.includes('warning: src/file.ts:42:3'));

      // 5. Plugin metrics emit correct reducer name
      let metricsEvent = null;
      let handler;
      apply({ on(_event, fn) { handler = fn; } }, {
        metrics: { enabled: true, onEvent: e => { metricsEvent = e; } }
      });
      const result = { content: [{ type: 'text', text: viteText }], value: { kind: 'foreground', exitCode: 0 } };
      const decision = await handler(exec(cmd), result, async () => ({ kind: 'accept' }));
      assert.ok(decision.content);
      assert.equal(metricsEvent?.reducer, 'build');
      assert.equal(metricsEvent?.semanticReduced, true);
    }

    // Prettier wrapped commands dispatch to 'lint'
    for (const lintCmd of [
      'pnpm exec prettier --check .',
      'npm exec prettier -c .',
      'npx --yes prettier --check .',
      'npm exec --yes prettier -c .',
      'pnpm exec --silent prettier --check .'
    ]) {
      const lintOutcome = reducers.applySemanticReducers(exec(lintCmd), prettierText, {});
      assert.equal(lintOutcome.reduced, true);
      assert.equal(lintOutcome.reducerName, 'lint');
      assert.equal(lintOutcome.text, 'Checking formatting...\nAll matched files use Prettier code style!\n');

      let metricsEvent = null;
      let handler;
      apply({ on(_event, fn) { handler = fn; } }, {
        metrics: { enabled: true, onEvent: e => { metricsEvent = e; } }
      });
      const result = { content: [{ type: 'text', text: prettierText }], value: { kind: 'foreground', exitCode: 0 } };
      await handler(exec(lintCmd), result, async () => ({ kind: 'accept' }));
      assert.equal(metricsEvent?.reducer, 'lint');
    }
  });

  it('reduces modern Vite 7 / 8 output lines while retaining chunks and assets', () => {
    const vite7Text = `vite v7.3.6 building client environment for production...
transforming...
✓ 3 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                0.12 kB │ gzip: 0.12 kB
dist/assets/index-C1fOly32.js  0.73 kB │ gzip: 0.41 kB
✓ built in 71ms
`;
    const reduced = reducers.reduceBuild(exec('vite build'), vite7Text, {});
    assert.ok(reduced);
    assert.ok(!reduced.includes('transforming...'));
    assert.ok(!reduced.includes('rendering chunks...'));
    assert.ok(!reduced.includes('computing gzip size...'));
    assert.ok(reduced.includes('dist/index.html'));
    assert.ok(reduced.includes('dist/assets/index-C1fOly32.js'));
    assert.ok(reduced.includes('✓ built in 71ms'));
    assert.equal(reducers.reduceBuild(exec('vite build'), reduced, {}), null);
  });
});
