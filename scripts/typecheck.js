import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

// Resolve an existing local or NODE_PATH peer; never install or stub declarations.
function packageFile(name) {
  return require.resolve(`${name}/package.json`);
}

function declaredTypes(filename) {
  const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const types = pkg.types ?? pkg.typings;
  if (typeof types !== 'string') throw new Error(`No type entry in ${pkg.name}`);
  return path.resolve(path.dirname(filename), types);
}

let temporary;
try {
  const cordis = packageFile('@deepseek-ai/cordis');
  const compilerPackage = packageFile('typescript');
  const compiler = JSON.parse(fs.readFileSync(compilerPackage, 'utf8'));
  const executable = path.resolve(path.dirname(compilerPackage), compiler.bin.tsc);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trimmer-typecheck-'));
  const configuration = path.join(temporary, 'tsconfig.json');
  fs.writeFileSync(configuration, JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { paths: { '@deepseek-ai/cordis': [declaredTypes(cordis)] } }
  }), 'utf8');
  console.log('Checking public declarations against the installed Cordis peer.');
  const result = spawnSync(process.execPath, [executable, '--project', configuration, '--noEmit'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Typecheck failed: ${error.message}`);
  console.error('Provide the optional Cordis peer and TypeScript locally or through NODE_PATH.');
  process.exitCode = 1;
} finally {
  if (temporary) {
    const target = path.resolve(temporary);
    if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('dsh-trimmer-typecheck-')) {
      try { fs.rmSync(target, { recursive: true, force: true }); }
      catch (error) {
        console.error(`Typecheck cleanup failed: ${error.message}`);
        process.exitCode = 1;
      }
    } else {
      console.error('Refusing to clean an unexpected typecheck directory');
      process.exitCode = 1;
    }
  }
}
