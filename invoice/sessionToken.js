import crypto from 'node:crypto';

// Checks the session token that the Shopify customer account sends with every request.
// It is signed by Shopify with the app's client secret, so nobody can make a fake one.
// It tells us which customer is logged in ("sub": gid://shopify/Customer/123).
//
// Returns { customerId } when the token is valid and a customer is logged in, otherwise throws.

const LEEWAY_SECONDS = 10; // small margin for clocks that are a few seconds off

export function verifySessionToken(token, { clientId, clientSecret, storeDomain, now = Date.now() }) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('No valid session token');
    const [header, payload, signature] = parts;

    // 1. The signature must be made with our client secret
    const expected = crypto.createHmac('sha256', clientSecret).update(`${header}.${payload}`).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Session token signature is wrong');

    const { alg } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (alg !== 'HS256') throw new Error('Session token uses an unknown signing method');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    // 2. It must not be expired, and meant for our app and our shop
    const seconds = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < seconds - LEEWAY_SECONDS) throw new Error('Session token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf > seconds + LEEWAY_SECONDS) throw new Error('Session token is not valid yet');
    if (claims.aud !== clientId) throw new Error('Session token is meant for another app');
    const shop = String(claims.dest || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (shop !== storeDomain) throw new Error('Session token is meant for another shop');

    // 3. A customer must be logged in
    const customerId = String(claims.sub || '').match(/^gid:\/\/shopify\/Customer\/(\d+)$/)?.[1];
    if (!customerId) throw new Error('No customer is logged in');

    return { customerId };
}
