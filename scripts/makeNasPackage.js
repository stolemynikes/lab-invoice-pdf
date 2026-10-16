// Makes build/factuur-app-nas.zip: only what the NAS needs to run the invoice app (same as Kasper's).
// Never included: .env (secrets), data (database + Exact login), node_modules, output, tests, shopify-app.
// Run with: node scripts/makeNasPackage.js   - then follow docs/synology-nl.md
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const include = [
    'Dockerfile',
    'docker-compose.yml',
    '.dockerignore',
    '.env.example',
    'package.json',
    'package-lock.json',
    'index.js',
    'config.js',
    'README.md',
    'admin',
    'assets',
    'docs',
    'email',
    'exact',
    'invoice',
    'pdf',
    'routes',
    'scripts',
    'shopify',
    'tax',
];

const folder = path.join('build', 'factuur-app');
fs.rmSync('build', { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });

for (const name of include) {
    fs.cpSync(name, path.join(folder, name), { recursive: true });
}

// Windows 10/11 has its own tar, which can also make zip files (Git Bash has another tar that cannot).
// It writes folders with "/", so the NAS unpacks them as real folders.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const zip = path.join('build', 'factuur-app-nas.zip');
try {
    execFileSync(tar, ['-a', '-c', '-f', zip, '-C', folder, '.']);
    console.log(`Made ${zip}`);
} catch {
    console.log(`Could not make a zip; copy the folder ${folder} to the NAS instead`);
}
console.log('Not included on purpose: .env and data/ (copy them yourself), node_modules, output, test, shopify-app');
