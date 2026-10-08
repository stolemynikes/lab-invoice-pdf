import fs from 'node:fs';
import path from 'node:path';
import { seller, invoiceSettings } from '../config.js';
import { classifyOrder } from '../tax/classifyOrder.js';
import { buildInvoice } from '../invoice/buildInvoice.js';
import { renderInvoice, DESIGN_OPTIONS } from '../pdf/renderInvoice.js';

// Makes every design combination as a PDF, plus a page to pick the one you like.
//
//   npm run designs
//
// Then open output/designs/index.html in your browser.

const OUTPUT = './output/designs';

// Two sample orders: one with VAT, one with the EU business text
const SAMPLES = {
    nl: { file: 'fixtures/order-nl-consumer.json', vatCheck: null },
    be: { file: 'fixtures/order-be-business.json', vatCheck: { vatId: 'BE0403170701', prefix: 'BE', status: 'valid' } },
};

fs.mkdirSync(OUTPUT, { recursive: true });

let count = 0;
for (const [sampleName, sample] of Object.entries(SAMPLES)) {
    const order = JSON.parse(fs.readFileSync(sample.file, 'utf8'));
    const address = order.shipping_address;
    const classification = classifyOrder({
        sellerCountry: seller.countryCode,
        shipTo: { countryCode: address.country_code, zip: address.zip, provinceCode: address.province_code },
        vatCheck: sample.vatCheck,
    });
    const invoice = {
        ...buildInvoice({ order, seller, classification, vatCheck: sample.vatCheck }),
        number: 'INV-2026-00000001',
        issueDate: '2026-10-08',
    };

    for (const header of DESIGN_OPTIONS.header) {
        for (const table of DESIGN_OPTIONS.table) {
            for (const total of DESIGN_OPTIONS.total) {
                for (const accent of DESIGN_OPTIONS.accent) {
                    const design = { header, table, total, accent };
                    const pdf = await renderInvoice(invoice, { ...invoiceSettings.brand, design });
                    fs.writeFileSync(path.join(OUTPUT, `${sampleName}-${header}-${table}-${total}-${accent}.pdf`), pdf);
                    count++;
                }
            }
        }
    }
}

fs.copyFileSync('./scripts/designPicker.html', path.join(OUTPUT, 'index.html'));
console.log(`Made ${count} designs. Open ${path.resolve(OUTPUT, 'index.html')} in your browser.`);
