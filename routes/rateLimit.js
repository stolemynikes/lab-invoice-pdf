// A simple brake: at most `max` requests per minute per visitor (IP address).
// Stops someone from trying thousands of links or tokens.
// Behind Cloudflare Tunnel every request comes from the tunnel, so the real visitor address is taken
// from the Cf-Connecting-IP header that Cloudflare adds (nobody can reach the app without passing Cloudflare).
export function rateLimit({ max = 60 } = {}) {
    const hits = new Map();

    // Forget old visitors every minute
    setInterval(() => hits.clear(), 60 * 1000).unref();

    return (req, res, next) => {
        const key = req.get('cf-connecting-ip') || req.ip;
        const count = (hits.get(key) ?? 0) + 1;
        hits.set(key, count);
        if (count === max + 1) console.log(`Rate limit: ${key} made more than ${max} requests in a minute to ${req.baseUrl}`);
        if (count > max) {
            return res.status(429).send({ message: 'Too many requests, please try again in a minute' });
        }
        next();
    };
}
