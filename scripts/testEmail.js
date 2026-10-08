import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { seller, invoiceSettings } from '../config.js';
import { createMailer } from '../email/mailer.js';
import { buildDocumentEmail } from '../email/emailTemplate.js';
import { logoAttachment, isValidEmailAddress } from '../email/emailQueue.js';
import { classifyOrder } from '../tax/classifyOrder.js';
import { buildInvoice } from '../invoice/buildInvoice.js';
import { renderInvoice } from '../pdf/renderInvoice.js';

// A test e-mail with a sample invoice.
//
//   npm run test-email -- you@example.com          sends it through the mailbox in .env (checks that it works)
//   npm run test-email -- you@example.com --save   no mailbox needed: saves the exact e-mail as output/test-email.eml
//                                                  (double-click it to open it in Outlook or Windows Mail)
//
// Works also while EMAIL_ENABLED=false, so you can test before switching e-mail on for customers.

const to = process.argv[2];
const saveOnly = process.argv.includes('--save');
if (!isValidEmailAddress(to)) {
    console.log('Usage: npm run test-email -- <your e-mail address> [--save]');
    process.exit(1);
}

// A sample invoice, clearly marked as a test
const order = JSON.parse(fs.readFileSync('fixtures/order-nl-consumer.json', 'utf8'));
const classification = classifyOrder({ sellerCountry: seller.countryCode, shipTo: { countryCode: 'NL', zip: '2011 AB' } });
const invoice = { ...buildInvoice({ order, seller, classification }), number: 'TEST-INV-2026-0', issueDate: '2026-10-08' };
const pdf = await renderInvoice(invoice, invoiceSettings.brand);
const logo = logoAttachment(invoiceSettings.brand.logo);
const email = buildDocumentEmail(invoice, seller, { language: invoiceSettings.email.language, withLogo: Boolean(logo) });

const message = {
    from: invoiceSettings.email.from || `${seller.tradeName || seller.legalName} <facturen@example.nl>`,
    replyTo: invoiceSettings.email.replyTo || undefined,
    to,
    subject: `[TEST] ${email.subject}`,
    text: email.text,
    html: email.html,
    attachments: [{ filename: email.filename, content: pdf, contentType: 'application/pdf' }, ...(logo ? [logo] : [])],
};

if (saveOnly) {
    // Build the e-mail exactly as it would be sent, but write it to a file instead of sending it
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    const { message: raw } = await builder.sendMail(message);
    fs.mkdirSync('output', { recursive: true });
    fs.writeFileSync('output/test-email.eml', raw);
    console.log('Saved the test e-mail as output/test-email.eml (nothing was sent). Double-click it to open it.');
    process.exit(0);
}

const mailer = createMailer({ ...invoiceSettings.email, enabled: true });
console.log(`Connecting to ${invoiceSettings.email.host}:${invoiceSettings.email.port} as ${invoiceSettings.email.user}...`);
try {
    await mailer.verify();
    console.log('Connection and password OK.');
} catch (error) {
    console.log('Could not connect or log in:', error.message);
    console.log('Check SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD in .env, or use --save to test without a mailbox.');
    process.exit(1);
}

await mailer.send({ ...message, bcc: undefined }); // never send the test to the bookkeeping address
console.log(`Test e-mail sent to ${to}. Check that it arrived (and not in spam).`);
