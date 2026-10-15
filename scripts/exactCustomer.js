import { exact, shopify } from '../config.js';
import { fetchOrderByName } from '../shopify/shopifyClient.js';
import { customerFromOrder, ensureCustomer } from '../exact/exactCustomer.js';

// Makes sure the customer of a Shopify order exists in Exact with a contact person (needed to e-mail invoices).
// Only works in the administrations listed in EXACT_WRITE_DIVISIONS.
//
//   npm run exact-customer -- LD1005

const orderName = process.argv[2];
if (!orderName) {
    console.log('Usage: npm run exact-customer -- <order name, e.g. LD1005>');
    process.exit(1);
}

const order = await fetchOrderByName(shopify, orderName);
if (!order) {
    console.log(`Order ${orderName} not found in Shopify`);
    process.exit(1);
}

const customer = customerFromOrder(order);
const result = await ensureCustomer(exact, customer);
console.log(`Relation: ${result.created.account ? 'created' : 'already there'}`);
console.log(`Contact person with ${customer.email}: ${result.created.contact ? 'created' : 'already there'}`);
console.log('The relation now has a contact person to e-mail invoices to.');
