import fs from 'node:fs';
import { createInvoiceForOrder, savePdf } from './createInvoice.js';
import { buildCreditNote } from './buildCreditNote.js';

// The full flow for one Shopify refund:
// make sure the order has an invoice -> build the credit note -> give it a number -> save the PDF
// Returns null when the refund paid nothing back (e.g. only restocked items).
export async function createCreditNoteForRefund(refund, order, { store, seller, settings }) {
    // Already made? Return the stored credit note (Shopify can send the same webhook twice)
    const existing = store.findCreditNoteByRefund(refund.id);
    if (existing) {
        let pdfPath = store.getPdfPath(existing.number);
        if (!pdfPath || !fs.existsSync(pdfPath)) {
            pdfPath = await savePdf(existing, settings.pdfDir, settings.brand);
            store.setPdfPath(existing.number, pdfPath);
        }
        return { creditNote: existing, pdfPath, created: false };
    }

    // A credit note always refers to an invoice, so make the invoice first if it is missing
    const { invoice } = await createInvoiceForOrder(order, { store, seller, settings });

    const creditNoteData = buildCreditNote({ refund, order, invoice, seller });
    if (!creditNoteData) return null;

    // Test orders get their own series, so they never use up real credit note numbers
    const series = order.test ? `TEST-${settings.creditSeries}` : settings.creditSeries;
    const { creditNote, created } = store.issueCreditNote(creditNoteData, { series });

    const pdfPath = await savePdf(creditNote, settings.pdfDir, settings.brand);
    store.setPdfPath(creditNote.number, pdfPath);

    return { creditNote, pdfPath, created };
}
