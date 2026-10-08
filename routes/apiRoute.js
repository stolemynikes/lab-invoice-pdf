import express from 'express';
import { shopify, invoiceSettings, PUBLIC_URL } from '../config.js';
import { verifySessionToken } from '../invoice/sessionToken.js';
import { downloadUrl, LINK_MINUTES } from '../invoice/downloadLinks.js';
import { rateLimit } from './rateLimit.js';

// The API for the buttons in the Shopify customer account (the "Factuur" card and the "Facturen" page).
// Every request must carry the session token of the logged-in customer. The answer only ever contains
// that customer's own invoices and credit notes, with download links that expire after a few minutes.

// The settings can be passed in for tests; normally they come from .env
export function apiRoute(store, { shopifySettings = shopify, linkSecret = invoiceSettings.linkSecret, publicUrl = PUBLIC_URL } = {}) {
    const router = express.Router();
    router.use(rateLimit({ max: 60 }));

    // The customer account runs on a Shopify address, so the browser asks permission first (CORS).
    // No cookies are used: only the session token in the Authorization header counts.
    router.use((req, res, next) => {
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Cache-Control': 'no-store',
        });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    // GET /api/documents            all invoices of the logged-in customer
    // GET /api/documents?order=123  only those of one order (for the order page)
    router.get('/documents', (req, res) => {
        let customerId;
        try {
            const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
            ({ customerId } = verifySessionToken(token, shopifySettings));
        } catch (error) {
            return res.status(401).send({ message: error.message });
        }

        const orderId = String(req.query.order || '').match(/(\d+)$/)?.[1];
        const link = (number) => downloadUrl(publicUrl, number, customerId, linkSecret);

        const documents = store
            .documentsForCustomer(customerId)
            .filter(({ invoice }) => !orderId || invoice.orderId === orderId)
            .map(({ invoice, creditNotes }) => ({
                orderId: invoice.orderId,
                orderName: invoice.orderName,
                orderDate: invoice.orderDate,
                total: invoice.totals.gross,
                currency: invoice.currency,
                invoice: { number: invoice.number, issueDate: invoice.issueDate, url: link(invoice.number) },
                creditNotes: creditNotes.map((creditNote) => ({
                    number: creditNote.number,
                    issueDate: creditNote.issueDate,
                    url: link(creditNote.number),
                })),
            }));

        return res.status(200).json({ documents, linkMinutes: LINK_MINUTES });
    });

    return router;
}
