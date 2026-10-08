import crypto from 'node:crypto';

// Download links contain a signature, so customers can only open their own invoice
// and nobody can guess other invoice links by changing the number.

function signature(invoiceNumber, secret) {
    return crypto.createHmac('sha256', secret).update(invoiceNumber).digest('base64url');
}

export function downloadUrl(publicUrl, invoiceNumber, secret) {
    return `${publicUrl}/invoices/${encodeURIComponent(invoiceNumber)}/download?token=${signature(invoiceNumber, secret)}`;
}

export function isValidToken(invoiceNumber, token, secret) {
    if (!token || !secret) return false;
    const a = Buffer.from(signature(invoiceNumber, secret));
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
