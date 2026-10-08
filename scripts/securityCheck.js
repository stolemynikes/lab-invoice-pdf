import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Checks for known security problems. It only looks, it never installs or changes anything.
//   1. The packages the app uses (from package-lock.json), against npm's list of known vulnerabilities
//   2. Node.js: is there a newer release with security fixes?
//
//   npm run security-check
//
// Ends with exit code 1 when something was found, so the Synology Task Scheduler can e-mail you
// (see docs/synology-nl.md → "Automatische beveiligingscontrole").

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADVISORIES_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const NODE_RELEASES_URL = 'https://nodejs.org/dist/index.json';

// The packages that run in the app (not the test tools), with their installed version
export function installedPackages(lock) {
    const packages = {};
    for (const [location, info] of Object.entries(lock.packages || {})) {
        if (!location.includes('node_modules/') || info.dev || !info.version) continue;
        const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
        (packages[name] ??= new Set()).add(info.version);
    }
    return Object.fromEntries(Object.entries(packages).map(([name, versions]) => [name, [...versions]]));
}

// Does a version fall in a range like "<4.20.0" or ">=2.0.0 <2.3.1 || >=3.0.0 <3.0.4"?
// Returns null when the range cannot be read (then it is reported, to be safe).
export function inRange(version, range) {
    const v = parseVersion(version);
    if (!v) return null;
    let unreadable = false;
    for (const set of String(range).split('||')) {
        const comparators = set.trim().split(/\s+/).filter(Boolean);
        if (comparators.length === 0 || comparators.includes('*')) return true;
        const matches = comparators.every((comparator) => {
            const [, operator = '=', target] = /^(<=|>=|<|>|=)?v?(.+)$/.exec(comparator) || [];
            const t = parseVersion(target);
            if (!t) {
                unreadable = true;
                return false;
            }
            const order = compare(v, t);
            return { '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0, '=': order === 0 }[operator];
        });
        if (matches) return true;
    }
    return unreadable ? null : false;
}

function parseVersion(text) {
    const match = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(text || '').trim());
    if (!match) return null;
    return [1, 2, 3].map((i) => (match[i] && /^\d+$/.test(match[i]) ? Number(match[i]) : 0));
}

function compare(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

// The problems that apply to the installed versions
export function findProblems(installed, advisories) {
    const problems = [];
    for (const [name, list] of Object.entries(advisories || {})) {
        for (const advisory of list) {
            for (const version of installed[name] || []) {
                const affected = inRange(version, advisory.vulnerable_versions);
                if (affected === false) continue;
                problems.push({
                    name,
                    version,
                    severity: advisory.severity,
                    title: advisory.title,
                    url: advisory.url,
                    unsure: affected === null,
                });
            }
        }
    }
    return problems;
}

// Newer Node.js releases of the same main version that contain security fixes
export function nodeSecurityReleases(releases, current = process.version) {
    const major = current.split('.')[0];
    const now = parseVersion(current.slice(1));
    return releases
        .filter((release) => release.version.startsWith(`${major}.`) && release.security)
        .filter((release) => compare(parseVersion(release.version.slice(1)), now) > 0)
        .map((release) => release.version);
}

async function main() {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const installed = installedPackages(lock);
    let found = false;

    //1. packages
    const response = await fetch(ADVISORIES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(installed),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`npm answered ${response.status}`);
    const problems = findProblems(installed, await response.json());
    if (problems.length === 0) {
        console.log(`Packages: OK, no known vulnerabilities in ${Object.keys(installed).length} packages.`);
    } else {
        found = true;
        console.log(`Packages: ${problems.length} known problem(s):`);
        for (const p of problems) {
            console.log(`  - ${p.name} ${p.version} (${p.severity}${p.unsure ? ', check by hand' : ''}): ${p.title}`);
            console.log(`    ${p.url}`);
        }
        console.log('  What to do: on the pc, run "npm audit fix" and "npm test", then copy the files to the NAS and build the project again.');
    }

    //2. Node.js
    const releases = await (await fetch(NODE_RELEASES_URL, { signal: AbortSignal.timeout(30_000) })).json();
    const newer = nodeSecurityReleases(releases);
    if (newer.length === 0) {
        console.log(`Node.js ${process.version}: OK, no newer security release.`);
    } else {
        found = true;
        console.log(`Node.js ${process.version}: security update available (${newer[0]}).`);
        console.log('  What to do: Container Manager → Project → factuur-app → Build (this downloads the newest Node.js 24), then start it again.');
    }

    process.exitCode = found ? 1 : 0;
}

// Only run when started as a command (not when the tests load this file)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.log('Security check could not run:', error.message);
        process.exitCode = 2;
    });
}
