import fs from 'node:fs';
import express from 'express';
import { invoiceSettings } from '../config.js';
import { checkDownloadLink } from '../invoice/downloadLinks.js';
import { rateLimit } from './rateLimit.js';
import { isValidDocumentNumber } from '../invoice/documentNumber.js';

export function invoicesRoute(store, { linkSecret = invoiceSettings.linkSecret } = {}) {
    const router = express.Router();
    router.use(rateLimit({ max: 30 }));

    // Customer downloads an invoice or credit note: /invoices/INV-2026-1/download?customer=..&expires=..&token=..
    // The link must be valid, not expired, and made for the customer who owns the document.
    router.get('/:number/download', (req, res) => {
        const { number } = req.params;
        // Anything that is not a real document number (e.g. "../" or SQL) is refused straight away
        const customerId = isValidDocumentNumber(number) && checkDownloadLink(number, req.query, linkSecret);
        const document = customerId && store.findDocument(number);

        // Same answer for every problem, so nobody can find out which invoice numbers exist
        if (!document || !document.customerId || document.customerId !== customerId) {
            return res.status(403).send({ message: 'This download link is not valid (anymore). Open the invoice again from your account.' });
        }

        const pdfPath = store.getPdfPath(number);
        if (!pdfPath || !fs.existsSync(pdfPath)) {
            return res.status(404).send({ message: 'Invoice not found' });
        }

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${number}.pdf"`,
            'Cache-Control': 'private, no-store', // never keep a copy in a shared cache
            'Referrer-Policy': 'no-referrer', // never pass the link on to other websites
            'X-Content-Type-Options': 'nosniff',
        });
        return fs.createReadStream(pdfPath).pipe(res);
    });

    return router;
}
