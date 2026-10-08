import { seller, shopify, invoiceSettings } from '../config.js';
import { InvoiceStore } from '../invoice/invoiceStore.js';
import { runCatchUp } from '../invoice/catchUp.js';
import { fetchOrdersUpdatedSince } from '../shopify/shopifyClient.js';
import { saveDocumentNumbers } from '../shopify/documentNumbers.js';
import { createMailer } from '../email/mailer.js';

// Runs the catch-up once by hand: makes every invoice and credit note that is still missing.
// (The app also does this by itself when it starts and every hour.)
//
//   npm run catch-up

const store = new InvoiceStore(invoiceSettings.databasePath);
const startDate = invoiceSettings.startDate || store.getSetting('first_used');
console.log(`Checking Shopify for orders since ${store.getSetting('last_catch_up') ?? startDate} (never before ${startDate})...`);

const summary = await runCatchUp({
    store,
    seller,
    settings: invoiceSettings,
    startDate: invoiceSettings.startDate,
    fetchOrdersSince: (since) => fetchOrdersUpdatedSince(shopify, since),
    saveNumbers: (orderId) => saveDocumentNumbers(shopify, store, orderId),
    sendEmail: createMailer(invoiceSettings.email)?.send,
    log: console.log,
});
store.close();

console.log(`Checked ${summary.checked} order(s): ${summary.invoices} invoice(s) and ${summary.creditNotes} credit note(s) made, ${summary.numbersSaved} order(s) updated in Shopify, ${summary.emailsSent} e-mail(s) sent.`);
if (summary.skippedOld) console.log(`Skipped ${summary.skippedOld} order(s) from before ${startDate}.`);
for (const error of summary.errors) {
    console.log(`  ⚠ ${error}`);
}
