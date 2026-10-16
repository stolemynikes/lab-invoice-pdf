import crypto from 'node:crypto';

// Access to the internal admin routes (/internal/admin/...), used only by the NAS admin panel.
// - Needs ADMIN_KEY (a long random text, the same in the panel's .env). Without it the routes do not exist.
// - Requests that came in through a tunnel or proxy (they carry forwarding headers) are always refused:
//   the panel talks to the app directly inside the NAS, never via the internet.
// - Every refusal gets the same answer, so nobody can find out why.

const PROXY_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'cf-ray', 'ngrok-trace-id'];

export function adminGuard(adminKey) {
    const expected = Buffer.from(`Bearer ${adminKey || ''}`);
    return (req, res, next) => {
        const viaProxy = PROXY_HEADERS.some((name) => req.get(name));
        const given = Buffer.from(String(req.get('authorization') || ''));
        const keyOk = adminKey && adminKey.length >= 32 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
        if (viaProxy || !keyOk) return res.status(404).send({ message: 'Not found' });
        res.set('Cache-Control', 'no-store');
        next();
    };
}
