import fs from 'node:fs';
import path from 'node:path';
import { checkVatId } from '../tax/vies.js';
import { classifyOrder } from '../tax/classifyOrder.js';
import { buildInvoice, findCustomerVatId } from './buildInvoice.js';
import { renderInvoice } from '../pdf/renderInvoice.js';
import { assertValidDocumentNumber } from './documentNumber.js';

// The full flow for one Shopify order:
// check VAT number -> work out VAT situation -> build invoice -> give it a number -> save the PDF
export async function createInvoiceForOrder(order, { store, seller, settings }) {
    // Already invoiced? Return the stored invoice (Shopify can send the same webhook twice)
    const existing = store.findByOrder(order.id);
    if (existing) {
        let pdfPath = store.getPdfPath(existing.number);
        // PDF missing (e.g. the NAS was offline)? Render it again from the stored, unchanged invoice data
        if (!pdfPath || !fs.existsSync(pdfPath)) {
            pdfPath = await savePdf(existing, settings.pdfDir, settings.brand);
            store.setPdfPath(existing.number, pdfPath);
        }
        return { invoice: existing, pdfPath, created: false };
    }

    const invoiceData = await prepareInvoiceData(order, { seller, settings });

    // Test orders get their own number series, so they never use up real invoice numbers
    const series = order.test ? `TEST-${settings.series}` : settings.series;
    const { invoice, created } = store.issue(invoiceData, { series });

    const pdfPath = await savePdf(invoice, settings.pdfDir, settings.brand);
    store.setPdfPath(invoice.number, pdfPath);

    return { invoice, pdfPath, created };
}

// Everything for the invoice except the number: check the VAT number, work out the VAT situation, build the lines.
// Also used by the restore script to rebuild an invoice from Shopify.
export async function prepareInvoiceData(order, { seller, settings }) {
    const customerVatId = findCustomerVatId(order);
    const vatCheck = customerVatId
        ? await checkVatId(customerVatId, { online: settings.viesEnabled, requesterVatId: seller.vatId })
        : null;

    const shippingAddress = order.shipping_address || order.billing_address;
    const classification = classifyOrder({
        sellerCountry: seller.countryCode,
        shipTo: {
            countryCode: shippingAddress?.country_code,
            zip: shippingAddress?.zip,
            provinceCode: shippingAddress?.province_code,
        },
        vatCheck,
    });

    return buildInvoice({ order, seller, classification, vatCheck });
}

// Saves the PDF (and a JSON copy as backup) to e.g. <pdfDir>/2026/INV-2026-1.pdf
// Used for both invoices and credit notes
export async function savePdf(invoice, pdfDir, brand) {
    // The number and year become folder and file names: only allow the strict format, never "../" or the like
    assertValidDocumentNumber(invoice.number);
    const year = String(invoice.issueDate).slice(0, 4);
    if (!/^\d{4}$/.test(year)) throw new Error(`Not a valid issue date: ${JSON.stringify(invoice.issueDate)}`);

    const folder = path.join(pdfDir, year);
    fs.mkdirSync(folder, { recursive: true });

    const pdfPath = path.join(folder, `${invoice.number}.pdf`);
    fs.writeFileSync(pdfPath, await renderInvoice(invoice, brand));
    fs.writeFileSync(path.join(folder, `${invoice.number}.json`), JSON.stringify(invoice, null, 2));
    return pdfPath;
}
