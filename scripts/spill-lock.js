#!/usr/bin/env node
import { getSpilloverDirectory, repairSpilloverLock } from '../lib/spillover.js';

const args = process.argv.slice(2);
let directory = getSpilloverDirectory({});
const options = {};
let valid = true;
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--directory':
      if (!args[i + 1] || args[i + 1].startsWith('--')) valid = false;
      else directory = args[++i];
      break;
    case '--apply': options.apply = true; break;
    case '--writers-stopped': options.writersStopped = true; break;
    case '--fingerprint':
      if (!/^[a-f0-9]{64}$/.test(args[i + 1] ?? '')) valid = false;
      else options.fingerprint = args[++i];
      break;
    default: valid = false;
  }
}
if (!valid) {
  console.error('Usage: dsh-trimmer-lock [--directory PATH] [--apply --writers-stopped --fingerprint HASH]');
  process.exitCode = 2;
} else {
  const result = repairSpilloverLock(directory, options);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'refused') process.exitCode = 1;
}
