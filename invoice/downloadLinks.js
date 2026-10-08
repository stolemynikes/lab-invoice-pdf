import crypto from 'node:crypto';

// Download links for invoices and credit notes.
// A link only works for the customer it was made for, and only for a short time (10 minutes),
// so a forwarded or leaked link is quickly useless. Links are only handed out to a logged-in customer
// (see routes/apiRoute.js), and the signature makes it impossible to change the number, customer or time.

export const LINK_MINUTES = 10;

function signature(number, customerId, expires, secret) {
    return crypto.createHmac('sha256', secret).update(`${number}|${customerId}|${expires}`).digest('base64url');
}

export function downloadUrl(publicUrl, number, customerId, secret, { now = Date.now(), minutes = LINK_MINUTES } = {}) {
    const expires = Math.floor(now / 1000) + minutes * 60;
    const token = signature(number, customerId, expires, secret);
    const query = new URLSearchParams({ customer: String(customerId), expires: String(expires), token });
    return `${publicUrl}/invoices/${encodeURIComponent(number)}/download?${query}`;
}

// Checks a link. Returns the customer id when it is valid, otherwise null.
export function checkDownloadLink(number, { customer, expires, token }, secret, { now = Date.now() } = {}) {
    if (!secret || !customer || !expires || !token) return null;
    if (Number(expires) < Math.floor(now / 1000)) return null; // expired

    const a = Buffer.from(signature(number, String(customer), String(expires), secret));
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? String(customer) : null;
}
