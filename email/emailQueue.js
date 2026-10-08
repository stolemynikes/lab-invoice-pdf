import fs from 'node:fs';
import path from 'node:path';
import { buildDocumentEmail } from './emailTemplate.js';

// The logo at the top of the e-mail, as an attached image (PNG/JPG only: SVG does not show in most mail programs)
export function logoAttachment(logo) {
    if (!logo || !/\.(png|jpe?g)$/i.test(logo) || !fs.existsSync(logo)) return null;
    return { filename: path.basename(logo), path: path.resolve(logo), cid: 'logo' };
}

// The e-mails with invoices and credit notes.
// 1. queueDocumentEmail: when a document is made, an e-mail is put in the queue (once per document).
// 2. sendQueuedEmails: sends what is in the queue. If sending fails (e.g. the mail server is down),
//    the e-mail stays in the queue and the catch-up tries again later (at most 10 times).

// A normal e-mail address, without spaces or line breaks (those could be used to add extra recipients)
const EMAIL_ADDRESS = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i;

export function isValidEmailAddress(address) {
    return typeof address === 'string' && address.length <= 254 && EMAIL_ADDRESS.test(address);
}

// Returns true when an e-mail was queued
export function queueDocumentEmail(store, document) {
    if (!isValidEmailAddress(document.customerEmail)) return false;
    store.queueEmail(document.number, document.orderId, document.customerEmail);
    return true;
}

// Sends the e-mails in the queue (only for one order when orderId is given).
// send(message) actually sends one e-mail. Returns how many were sent and what went wrong.
export async function sendQueuedEmails({ store, seller, settings, send, orderId = null }) {
    const result = { sent: 0, errors: [] };
    if (!send) return result;

    for (const number of store.pendingEmails(orderId)) {
        const job = store.claimEmail(number);
        if (!job) continue; // someone else is already sending it

        try {
            const document = store.findDocument(number);
            const pdfPath = store.getPdfPath(number);
            if (!document || !pdfPath || !fs.existsSync(pdfPath)) throw new Error('PDF not found');

            const logo = logoAttachment(settings.brand?.logo);
            const email = buildDocumentEmail(document, seller, { language: settings.email?.language, withLogo: Boolean(logo) });
            await send({
                to: job.to_address,
                subject: email.subject,
                text: email.text,
                html: email.html,
                attachments: [{ filename: email.filename, path: pdfPath, contentType: 'application/pdf' }, ...(logo ? [logo] : [])],
            });
            store.markEmailSent(number);
            result.sent++;
        } catch (error) {
            store.markEmailFailed(number, error.message);
            result.errors.push(`${number}: e-mail not sent yet (${error.message})`);
        }
    }
    return result;
}
