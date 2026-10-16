import fs from 'node:fs';
import path from 'node:path';

// Settings changed in the NAS admin panel. They are saved in data/settings.json (next to the database,
// on the NAS volume) and go before .env. Only the keys an app allows can be set this way.
// After saving, the app restarts itself (Docker starts it again), so every part reads the new values.

export function settingsPath() {
    return process.env.SETTINGS_PATH || './data/settings.json';
}

// Puts the saved panel settings into process.env, before config.js reads them
export function applySettingsFile(allowedKeys, file = settingsPath()) {
    const saved = readSettings(file);
    for (const key of allowedKeys) {
        if (saved[key] !== undefined && saved[key] !== null) process.env[key] = String(saved[key]);
    }
}

export function readSettings(file = settingsPath()) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

// Merges new values into the file. Unknown keys and values with line breaks are refused.
export function saveSettings(values, allowedKeys, file = settingsPath()) {
    const current = readSettings(file);
    for (const [key, value] of Object.entries(values)) {
        if (!allowedKeys.includes(key)) throw new Error(`Setting ${key} cannot be changed here`);
        const text = String(value ?? '');
        if (/[\r\n\0]/.test(text) || text.length > 500) throw new Error(`Setting ${key} has an invalid value`);
        current[key] = text;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write a temporary file first, so a crash never leaves half a settings file. Only readable for the app user.
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(current, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    return current;
}
