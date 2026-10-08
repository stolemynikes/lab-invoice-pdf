import { seller, shopify, invoiceSettings, PUBLIC_URL } from '../config.js';
import { InvoiceStore } from '../invoice/invoiceStore.js';
import { createInvoiceForOrder } from '../invoice/createInvoice.js';
import { downloadUrl } from '../invoice/downloadLinks.js';
import { formatMoney } from '../invoice/money.js';
import { fetchOrderByName, saveInvoiceLinkOnOrder } from '../shopify/shopifyClient.js';

// Makes the invoice for an existing Shopify order and puts the download link on the order.
// Use it for orders the webhook missed, or to test with a real order.
//
//   npm run invoice-order -- LD1004

const orderName = process.argv[2];
if (!orderName) {
    console.log('Usage: npm run invoice-order -- <order name, e.g. LD1004>');
    process.exit(1);
}

const order = await fetchOrderByName(shopify, orderName);
if (!order) {
    console.log(`Order ${orderName} not found in Shopify`);
    process.exit(1);
}
if (order.financial_status !== 'paid') {
    console.log(`Order ${orderName} is not paid yet (status: ${order.financial_status}). No invoice made.`);
    process.exit(1);
}

const store = new InvoiceStore(invoiceSettings.databasePath);
const { invoice, pdfPath, created } = await createInvoiceForOrder(order, { store, seller, settings: invoiceSettings });
store.close();

console.log(`${created ? 'Created' : 'Already existed'}: ${invoice.number} for order ${invoice.orderName}`);
console.log(`  VAT situation: ${invoice.scenario} (${invoice.destinationCountry})`);
console.log(`  Total: ${formatMoney(invoice.totals.gross)} incl. ${formatMoney(invoice.totals.vat)} VAT`);
console.log(`  PDF: ${pdfPath}`);
for (const warning of invoice.warnings) {
    console.log(`  ⚠ ${warning}`);
}

const url = downloadUrl(PUBLIC_URL, invoice.number, invoiceSettings.linkSecret);
await saveInvoiceLinkOnOrder(shopify, order.id, url, invoice.number);
console.log(`  Download link saved on the order: ${url}`);
