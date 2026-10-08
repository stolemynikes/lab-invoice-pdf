import { createInvoiceForOrder } from './createInvoice.js';
import { createCreditNoteForRefund } from './createCreditNote.js';
import { queueDocumentEmail, sendQueuedEmails } from '../email/emailQueue.js';

// Order payment statuses that get an invoice
export const PAID_STATUSES = ['paid', 'partially_refunded', 'refunded'];

// Makes everything one order needs: the invoice (once it is paid) and a credit note per refund,
// e-mails them to the customer, and saves the numbers on the order in Shopify.
// Used by the webhooks, the catch-up and the invoice-order command, so they all work the same way.
//
// saveNumbers(orderId) saves the numbers in Shopify, sendEmail(message) sends one e-mail.
// If either fails (e.g. no internet), it is remembered and the catch-up tries again later. Nothing is lost.
export async function processOrder(order, { store, seller, settings, saveNumbers, sendEmail }) {
    const result = {
        invoice: null,
        invoiceCreated: false,
        pdfPath: null,
        creditNotes: [],
        numbersSaved: false,
        numbersError: null,
        emailsSent: 0,
        emailErrors: [],
    };
    if (!PAID_STATUSES.includes(order.financial_status)) return result;

    const context = { store, seller, settings };
    const { invoice, created, pdfPath } = await createInvoiceForOrder(order, context);
    Object.assign(result, { invoice, invoiceCreated: created, pdfPath });

    for (const refund of order.refunds || []) {
        const creditNote = await createCreditNoteForRefund(refund, order, context);
        if (creditNote) result.creditNotes.push(creditNote);
    }

    const newDocuments = [
        ...(created ? [invoice] : []),
        ...result.creditNotes.filter((c) => c.created).map((c) => c.creditNote),
    ];
    if (newDocuments.length > 0) store.markNumbersPending(order.id);

    //e-mail every new document to the customer (once)
    if (settings.email?.enabled) {
        for (const document of newDocuments) queueDocumentEmail(store, document);
        const emails = await sendQueuedEmails({ store, seller, settings, send: sendEmail, orderId: order.id });
        result.emailsSent = emails.sent;
        result.emailErrors = emails.errors;
    }

    //the numbers on the order in Shopify
    if (saveNumbers && store.ordersWithPendingNumbers().includes(String(order.id))) {
        try {
            await saveNumbers(order.id);
            store.clearNumbersPending(order.id);
            result.numbersSaved = true;
        } catch (error) {
            result.numbersError = error.message;
        }
    }
    return result;
}
