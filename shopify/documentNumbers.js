import { saveDocumentNumbersOnOrder } from './shopifyClient.js';

// Saves the invoice and credit note numbers on the Shopify order.
// No download links: those are only handed out to the logged-in customer (routes/apiRoute.js).
// The numbers and dates are a safety net for the restore script, if the local data is ever lost.
// Throws when Shopify cannot be reached, so the caller can try again later.
export async function saveDocumentNumbers(shopify, store, orderId) {
    const invoice = store.findByOrder(orderId);
    if (!invoice) return;
    await saveDocumentNumbersOnOrder(shopify, orderId, {
        invoiceNumber: invoice.number,
        issueDate: invoice.issueDate,
        creditNotes: store.creditNotesForOrder(orderId).map((creditNote) => ({
            number: creditNote.number,
            issueDate: creditNote.issueDate,
            refundId: creditNote.refundId,
        })),
    });
}
