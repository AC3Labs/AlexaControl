'use strict';

// Syntax check: runs `node --check` on every .js file and validates that
// entry.tp is well formed JSON.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const folders = ['src', 'scripts', 'test'];
let failed = 0;
let checked = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      checked += 1;
      try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      } catch (err) {
        failed += 1;
        process.stderr.write(`Syntax error in ${path.relative(root, full)}\n${err.stderr}\n`);
      }
    }
  }
}

for (const folder of folders) walk(path.join(root, folder));

try {
  JSON.parse(fs.readFileSync(path.join(root, 'entry.tp'), 'utf8'));
  checked += 1;
} catch (err) {
  failed += 1;
  process.stderr.write(`entry.tp is not valid JSON: ${err.message}\n`);
}

process.stdout.write(`Checked ${checked} files, ${failed} problem(s).\n`);
process.exit(failed ? 1 : 0);
