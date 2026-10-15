import { exact, shopify, seller, invoiceSettings } from '../config.js';
import { fetchOrderByName, fetchProductDetails } from '../shopify/shopifyClient.js';
import { invoiceOrderInExact } from '../exact/exactInvoice.js';
import { creditRefundsInExact } from '../exact/exactCredit.js';

// Makes the Exact invoice for one Shopify order right now (the same steps the server does by itself).
// Only in the administrations in EXACT_WRITE_DIVISIONS; with EXACT_TEST_ORDERS_ONLY=true only test orders.
//
//   npm run exact-invoice-order -- LD1006

const orderName = process.argv[2];
if (!orderName) {
    console.log('Usage: npm run exact-invoice-order -- <order name, e.g. LD1006>');
    process.exit(1);
}

const order = await fetchOrderByName(shopify, orderName);
if (!order) {
    console.log(`Order ${orderName} not found in Shopify`);
    process.exit(1);
}

const result = await invoiceOrderInExact(order, {
    settings: exact,
    seller,
    invoiceSettings,
    fetchProduct: (productId, variantId) => fetchProductDetails(shopify, productId, variantId),
    log: console.log,
});
console.log(`${orderName}: ${result.status}${result.number ? `, Exact invoice ${result.number}` : ''}${result.emailed ? ', e-mailed by Exact' : ''}`);
for (const warning of result.warnings || []) console.log(`  ⚠ ${warning}`);

const credits = await creditRefundsInExact(order, { settings: exact, seller, invoiceSettings, log: console.log });
for (const credit of credits) console.log(`${orderName}: credit note ${credit.number} for refund ${credit.refundId}`);
