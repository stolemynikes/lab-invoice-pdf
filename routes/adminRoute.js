import express from 'express';
import { adminGuard } from '../admin/adminAuth.js';
import { saveSettings } from '../admin/settingsFile.js';

// The internal admin routes, only for the NAS admin panel (see admin/adminAuth.js for who may use them).
// The same set of routes exists in every app the panel manages:
//   GET  /internal/admin/status            how it is going, what needs attention
//   GET  /internal/admin/settings          the settings the panel may show and change
//   PUT  /internal/admin/settings          save settings, then the app restarts itself
//   POST /internal/admin/enabled           switch the app's main job on or off
//   POST /internal/admin/restart           restart the app
//   GET  /internal/admin/log               the logbook
//   POST /internal/admin/actions/:action   app specific, e.g. "retry" an order
//
// provider: { name, enabledKey, allowedKeys, status(), fields(), validate(values), actions: { name: async (body) => result } }

// When this app started
const STARTED_AT = new Date().toISOString();

export function adminRoute({ adminKey, provider, logBook, restart = () => setTimeout(() => process.exit(0), 300), env = process.env }) {
    const router = express.Router();
    router.use(adminGuard(adminKey));
    router.use(express.json({ limit: '20kb' }));

    router.get('/status', async (req, res, next) => {
        try {
            // startedAt: the panel sees from this that the app restarted (and tells the colleagues)
            res.json({ ...(await provider.status()), startedAt: STARTED_AT });
        } catch (error) {
            next(error);
        }
    });

    router.get('/settings', (req, res) => res.json({ fields: provider.fields() }));

    router.put('/settings', (req, res) => {
        const values = req.body?.values;
        if (!values || typeof values !== 'object' || Array.isArray(values)) return res.status(400).json({ message: 'No settings sent' });
        const problems = provider.validate(values);
        if (problems.length) return res.status(400).json({ message: problems.join(' ') });
        try {
            saveSettings(values, provider.allowedKeys);
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }
        // Settings the app reads at every use (provider.liveKeys, e.g. prices for the numbers) work at once;
        // everything else is read at the start, so then the app restarts
        const live = Object.keys(values).every((key) => provider.liveKeys?.includes(key));
        if (live) {
            for (const [key, value] of Object.entries(values)) env[key] = String(value);
            console.log(`Settings changed in the admin panel: ${Object.keys(values).join(', ')} (no restart needed)`);
            return res.json({ ok: true, restarting: false });
        }
        console.log(`Settings changed in the admin panel: ${Object.keys(values).join(', ')} (restarting)`);
        res.json({ ok: true, restarting: true });
        restart();
    });

    router.post('/enabled', (req, res) => {
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false' });
        saveSettings({ [provider.enabledKey]: String(enabled) }, provider.allowedKeys);
        console.log(`${provider.name} switched ${enabled ? 'on' : 'off'} in the admin panel (restarting)`);
        res.json({ ok: true, enabled, restarting: true });
        restart();
    });

    // Restart the app (Docker starts it again). Re-reads the panel settings; .env itself needs a rebuild.
    router.post('/restart', (req, res) => {
        console.log(`${provider.name} restarted from the admin panel`);
        res.json({ ok: true, restarting: true });
        restart();
    });

    router.get('/log', (req, res) => {
        const level = ['ok', 'warn', 'bad', 'problems'].includes(req.query.level) ? req.query.level : '';
        const query = String(req.query.q || '').slice(0, 100);
        const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
        res.json({ entries: logBook.read({ days, level, query }) });
    });

    router.post('/actions/:action', async (req, res, next) => {
        const action = provider.actions[req.params.action];
        if (!Object.hasOwn(provider.actions, req.params.action) || typeof action !== 'function') return res.status(404).json({ message: 'Unknown action' });
        try {
            res.json(await action(req.body || {}));
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ message: error.message });
            next(error);
        }
    });

    return router;
}

export function badRequest(message) {
    return Object.assign(new Error(message), { status: 400 });
}
