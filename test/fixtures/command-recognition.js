// Fixed replay corpus: successful reducer outputs paired with common command forms.
// The rates describe this corpus, not production traffic.
const git = 'On branch main\nnothing to commit, working tree clean\n';
const install = '[====================] 100%\nadded 2 packages\n';
const tests = '✔ example (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n';
const build = 'transforming...\n✓ built in 1s\n';
const lint = 'Checking formatting...\nChecking formatting...\nAll matched files use Prettier code style!\n';
const forms = [
  { command: 'git status', text: git, reducer: 'git' },
  { command: 'npm install', text: install, reducer: 'packageManager' },
  { command: 'node --test', text: tests, reducer: 'test' },
  { command: 'npx vite build', text: build, reducer: 'build' },
  { command: 'pnpm exec prettier --check src', text: lint, reducer: 'lint' }
];

export const commandRecognitionSamples = forms.flatMap(sample => [
  { ...sample, form: 'direct', arguments: { command: sample.command, workdir: '/workspace/project' } },
  { ...sample, form: 'redirect', arguments: { command: `${sample.command} 2>&1`, workdir: '/workspace/project' } },
  { ...sample, form: 'cd', arguments: { command: `cd packages/app && ${sample.command}`, workdir: '/workspace/project' } },
  { ...sample, form: 'combined', arguments: { command: `cd "packages/my app" && ${sample.command} 2>&1`, workdir: '/workspace/project' } }
]);
