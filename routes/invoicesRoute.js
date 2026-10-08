import fs from 'node:fs';
import express from 'express';
import { invoiceSettings } from '../config.js';
import { isValidToken } from '../invoice/downloadLinks.js';

export function invoicesRoute(store) {
    const router = express.Router();

    // Customer downloads their invoice: /invoices/INV-2026-00001/download?token=...
    router.get('/:number/download', (req, res) => {
        const { number } = req.params;

        if (!isValidToken(number, req.query.token, invoiceSettings.linkSecret)) {
            return res.status(403).send({ message: 'This download link is not valid' });
        }

        const pdfPath = store.getPdfPath(number);
        if (!pdfPath || !fs.existsSync(pdfPath)) {
            return res.status(404).send({ message: 'Invoice not found' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${number}.pdf"`);
        return fs.createReadStream(pdfPath).pipe(res);
    });

    return router;
}
