import fs from 'node:fs';
import { seller, shopify, invoiceSettings } from '../config.js';
import { InvoiceStore } from '../invoice/invoiceStore.js';
import { processOrder, PAID_STATUSES } from '../invoice/processOrder.js';
import { formatMoney } from '../invoice/money.js';
import { fetchOrderByName } from '../shopify/shopifyClient.js';
import { saveDocumentNumbers } from '../shopify/documentNumbers.js';
import { createMailer } from '../email/mailer.js';

// Makes the invoice and credit notes (one per refund) for an existing Shopify order,
// e-mails them to the customer, and saves the invoice numbers on the order in Shopify.
// Use it for orders the webhooks missed, or to test with a real order.
//
//   npm run invoice-order -- LD1004
//   npm run invoice-order -- LD1004 --redo-test   (test orders only: make everything again, e.g. after changing the design)

const orderName = process.argv[2];
const redoTest = process.argv.includes('--redo-test');
if (!orderName) {
    console.log('Usage: npm run invoice-order -- <order name, e.g. LD1004> [--redo-test]');
    process.exit(1);
}

const order = await fetchOrderByName(shopify, orderName);
if (!order) {
    console.log(`Order ${orderName} not found in Shopify`);
    process.exit(1);
}
if (!PAID_STATUSES.includes(order.financial_status)) {
    console.log(`Order ${orderName} is not paid yet (status: ${order.financial_status}). No invoice made.`);
    process.exit(1);
}

const store = new InvoiceStore(invoiceSettings.databasePath);
if (redoTest) {
    if (!order.test) {
        console.log(`Order ${orderName} is a real order. Real invoices can never be made again.`);
        process.exit(1);
    }
    const removedFiles = store.deleteTestInvoice(order.id);
    if (removedFiles) {
        // Remove the old test PDFs and their JSON copies too, so a restore can never pick them up
        for (const pdfPath of removedFiles) {
            fs.rmSync(pdfPath, { force: true });
            fs.rmSync(pdfPath.replace(/\.pdf$/, '.json'), { force: true });
        }
        console.log(`Old test invoice and credit notes for ${orderName} removed`);
    }
}

const result = await processOrder(order, {
    store,
    seller,
    settings: invoiceSettings,
    saveNumbers: (orderId) => saveDocumentNumbers(shopify, store, orderId),
    sendEmail: createMailer(invoiceSettings.email)?.send,
});
store.close();

//invoice
const { invoice } = result;
console.log(`${result.invoiceCreated ? 'Created' : 'Already existed'}: invoice ${invoice.number} for order ${invoice.orderName}`);
console.log(`  VAT situation: ${invoice.scenario} (${invoice.destinationCountry})`);
console.log(`  Total: ${formatMoney(invoice.totals.gross)} incl. ${formatMoney(invoice.totals.vat)} VAT`);
console.log(`  PDF: ${result.pdfPath}`);
logWarnings(invoice.warnings);

//credit notes, one per refund
for (const { creditNote, created, pdfPath } of result.creditNotes) {
    console.log(`${created ? 'Created' : 'Already existed'}: credit note ${creditNote.number} (refund of ${creditNote.refundDate})`);
    console.log(`  Total: ${formatMoney(creditNote.totals.gross)} incl. ${formatMoney(creditNote.totals.vat)} VAT`);
    console.log(`  PDF: ${pdfPath}`);
    logWarnings(creditNote.warnings);
}

//invoice numbers on the Shopify order
if (result.numbersSaved) console.log('Invoice numbers saved on the order in Shopify');
if (result.emailsSent) console.log(`E-mailed ${result.emailsSent} document(s) to the customer`);
result.emailErrors.forEach((error) => console.log(`  ${error} – the catch-up will try again`));
if (result.numbersError) console.log(`Invoice numbers not saved in Shopify yet (the catch-up will try again): ${result.numbersError}`);

function logWarnings(warnings) {
    for (const warning of warnings) {
        console.log(`  ⚠ ${warning}`);
    }
}
