import fs from 'node:fs';
import path from 'node:path';

// The logbook for the NAS admin panel. Everything the app writes with console.log / console.error is kept:
// in memory (the last few hundred lines) and in data/logs/<date>.jsonl, for 30 days.
// Each line gets a level (ok / warn / bad) and, when known, a plain Dutch sentence for colleagues.

const KEEP_DAYS = 30;
const IN_MEMORY = 500;

export function createLogBook({ dir = path.join(path.dirname(process.env.SETTINGS_PATH || './data/settings.json'), 'logs'), translate = () => null, now = () => new Date() } = {}) {
    const recent = [];

    function add(text, forcedLevel) {
        const tech = String(text).replace(/\s+$/, '');
        if (!tech) return;
        const plain = translate(tech);
        const entry = {
            time: now().toISOString(),
            level: forcedLevel || plain?.level || levelOf(tech),
            plain: plain?.text || null,
            tech,
        };
        recent.push(entry);
        if (recent.length > IN_MEMORY) recent.shift();
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(path.join(dir, `${entry.time.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
        } catch {
            // The logbook must never stop the app (e.g. a full disk): the line stays in memory
        }
    }

    // Copies every console line into the logbook; the console itself keeps working as before
    function install(target = console) {
        for (const [method, level] of [['log', null], ['info', null], ['warn', 'warn'], ['error', 'bad']]) {
            const original = target[method].bind(target);
            target[method] = (...args) => {
                original(...args);
                add(args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '), level);
            };
        }
    }

    // Newest first. Reads the files of the last days, so the log survives a restart.
    function read({ days = 7, level = '', query = '', limit = 300 } = {}) {
        const entries = [];
        const today = now();
        for (let i = 0; i < Math.min(days, KEEP_DAYS); i++) {
            const day = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
            try {
                for (const line of fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8').split('\n')) {
                    if (!line) continue;
                    try {
                        entries.push(JSON.parse(line));
                    } catch {
                        // a broken line is skipped
                    }
                }
            } catch {
                // no file for that day
            }
        }
        const all = entries.length ? entries : [...recent];
        const q = String(query).toLowerCase();
        return all
            .filter((entry) => !level || (level === 'problems' ? entry.level !== 'ok' : entry.level === level))
            .filter((entry) => !q || `${entry.plain || ''} ${entry.tech}`.toLowerCase().includes(q))
            .sort((a, b) => (a.time < b.time ? 1 : -1))
            .slice(0, limit);
    }

    // Removes log files older than KEEP_DAYS
    function prune() {
        try {
            const oldest = new Date(now().getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
            for (const file of fs.readdirSync(dir)) {
                if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < oldest) fs.rmSync(path.join(dir, file), { force: true });
            }
        } catch {
            // no log folder yet
        }
    }

    return { add, install, read, prune, recent };
}

function levelOf(text) {
    if (/⚠|refused|error|failed|could not|not made|cannot/i.test(text)) return /could not reach|will try again|next try/i.test(text) ? 'warn' : 'bad';
    return 'ok';
}
