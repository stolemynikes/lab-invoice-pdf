import fs from 'node:fs';
import path from 'node:path';

// One lock for all work with Exact, shared by the server and the scripts (a file next to the Exact login).
// Without it, the server and e.g. `npm run exact-invoice-order` could both see "no invoice yet" and both
// make one, or both refresh the Exact login at the same time (Exact then cancels one of them).
//
// The lock is re-entrant inside one process, and a lock left behind by a crashed process is taken over
// after STALE_MS or when that process is gone.

const STALE_MS = 15 * 60 * 1000;
let depth = 0;

export class ExactBusyError extends Error {
    constructor() {
        super('another run is busy with Exact, try again in a minute');
    }
}

export function lockPathFor(settings) {
    return settings.lockPath || path.join(path.dirname(settings.tokenPath), 'exact.lock');
}

// Runs fn while holding the lock. waitMs: how long to wait for another run to finish (0 = give up right away).
export async function withExactLock(settings, fn, { waitMs = 0 } = {}) {
    if (depth > 0) return runNested(fn);

    const file = lockPathFor(settings);
    const until = Date.now() + waitMs;
    while (!tryTake(file)) {
        if (Date.now() >= until) throw new ExactBusyError();
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    depth = 1;
    try {
        return await fn();
    } finally {
        depth = 0;
        fs.rmSync(file, { force: true });
    }
}

async function runNested(fn) {
    depth++;
    try {
        return await fn();
    } finally {
        depth--;
    }
}

function tryTake(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
        return true;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    // Someone has it. Take it over only when that run is clearly dead.
    let holder = null;
    try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        // Half-written or removed in between: try again next time. Still empty after STALE_MS (the process
        // was killed right after making the file, e.g. by a container update): take it over, or nothing ever runs.
        holder = null;
    }
    const age = holder ? Date.now() - Number(holder.at) : Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (!holder && age <= STALE_MS) return false;
    if (age > STALE_MS || !isAlive(holder.pid)) {
        fs.rmSync(file, { force: true });
        try {
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

function isAlive(pid) {
    try {
        process.kill(Number(pid), 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM'; // exists, but owned by another user
    }
}
