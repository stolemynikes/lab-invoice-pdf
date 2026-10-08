import fs from 'node:fs';
import { seller, invoiceSettings, checkSellerDetails } from '../config.js';
import { InvoiceStore } from '../invoice/invoiceStore.js';
import { createInvoiceForOrder } from '../invoice/createInvoice.js';
import { formatMoney } from '../invoice/money.js';

// Makes a test invoice from a Shopify order saved as a JSON file.
//
//   npm run generate -- fixtures/order-nl-consumer.json
//   npm run generate -- fixtures/order-be-business.json --offline   (skip the VIES check)
//
// Test invoices use the DEMO number series and the ./output folder,
// so they never use up your real invoice numbers.

const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith('--'));
const offline = args.includes('--offline');

if (files.length === 0) {
    console.log('Usage: npm run generate -- <order.json> [more orders...] [--offline]');
    process.exit(1);
}

const problems = checkSellerDetails(seller);
if (problems.length > 0) {
    console.log('Note: your company details are not complete yet (fix these in .env):');
    problems.forEach((problem) => console.log(`  - ${problem}`));
    console.log();
}

const store = new InvoiceStore('./output/demo.db');
const settings = { ...invoiceSettings, pdfDir: './output', series: 'DEMO', viesEnabled: !offline };

for (const file of files) {
    const order = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { invoice, pdfPath, created } = await createInvoiceForOrder(order, { store, seller, settings });

    console.log(`${created ? 'Created' : 'Already existed'}: ${invoice.number} for order ${invoice.orderName}`);
    console.log(`  VAT situation: ${invoice.scenario} (${invoice.destinationCountry})`);
    console.log(`  Total: ${formatMoney(invoice.totals.gross)} incl. ${formatMoney(invoice.totals.vat)} VAT`);
    console.log(`  PDF: ${pdfPath}`);
    for (const warning of invoice.warnings) {
        console.log(`  ⚠ ${warning}`);
    }
    console.log();
}

store.close();
