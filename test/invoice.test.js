import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

import { findTerritory } from '../tax/territories.js';
import { classifyOrder } from '../tax/classifyOrder.js';
import { checkVatId } from '../tax/vies.js';
import { buildInvoice, findCustomerVatId } from '../invoice/buildInvoice.js';
import { InvoiceStore } from '../invoice/invoiceStore.js';
import { createInvoiceForOrder } from '../invoice/createInvoice.js';
import { downloadUrl, isValidToken } from '../invoice/downloadLinks.js';
import { isValidWebhook, getAccessToken } from '../shopify/shopifyClient.js';
import { renderInvoice } from '../pdf/renderInvoice.js';
import { checkSellerDetails } from '../config.js';

const seller = {
    legalName: 'Test Shop B.V.',
    registeredSeat: 'Amsterdam',
    addressLines: ['Teststraat 1', '1000 AA Amsterdam'],
    countryCode: 'NL',
    kvkNumber: '12345678',
    vatId: 'NL000000000B01',
};

const loadOrder = (name) => JSON.parse(fs.readFileSync(path.join('fixtures', name), 'utf8'));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'invoices-'));
const validVies = async () => ({ ok: true, json: async () => ({ valid: true, requestIdentifier: 'WAPIAAAA123' }) });

function invoiceFor(orderFile, vatCheck = null) {
    const order = loadOrder(orderFile);
    const address = order.shipping_address;
    const classification = classifyOrder({
        sellerCountry: 'NL',
        shipTo: { countryCode: address.country_code, zip: address.zip, provinceCode: address.province_code },
        vatCheck,
    });
    return buildInvoice({ order, seller, classification, vatCheck });
}

describe('territories', () => {
    it('knows which addresses are inside the EU VAT area', () => {
        expect(findTerritory({ countryCode: 'DE', zip: '50667' }).inEU).toBe(true);
        expect(findTerritory({ countryCode: 'CH', zip: '8001' }).inEU).toBe(false);
        expect(findTerritory({ countryCode: 'GB', zip: 'SW1A 2AA' }).inEU).toBe(false);
    });

    it('handles the special cases', () => {
        expect(findTerritory({ countryCode: 'GB', zip: 'BT1 1AA' })).toMatchObject({ inEU: true, vatCountry: 'XI' });
        expect(findTerritory({ countryCode: 'MC', zip: '98000' })).toMatchObject({ inEU: true, vatCountry: 'FR' });
        expect(findTerritory({ countryCode: 'ES', zip: '35001', provinceCode: 'GC' }).inEU).toBe(false);
        expect(findTerritory({ countryCode: 'ES', zip: '28001' }).inEU).toBe(true);
        expect(findTerritory({ countryCode: 'DE', zip: '27498' }).inEU).toBe(false);
        expect(findTerritory({ countryCode: 'FR', zip: '97100' }).inEU).toBe(false);
    });
});

describe('VAT situation', () => {
    it('Dutch consumer -> domestic', () => {
        expect(invoiceFor('order-nl-consumer.json').scenario).toBe('domestic');
    });

    it('German consumer -> EU consumer sale with German VAT', () => {
        const invoice = invoiceFor('order-de-consumer.json');
        expect(invoice.scenario).toBe('eu_b2c');
        expect(invoice.vatSummary).toEqual([{ rate: 0.19, net: 6000, vat: 1140 }]);
    });

    it('Belgian business with a valid VAT number -> 0% with legal note', async () => {
        const vatCheck = await checkVatId('BE 0403.170.701', { fetchFn: validVies });
        const invoice = invoiceFor('order-be-business.json', vatCheck);
        expect(invoice.scenario).toBe('eu_b2b');
        expect(invoice.buyer.vatId).toBe('BE0403170701');
        expect(invoice.legalNotes[0]).toContain('Article 138');
        expect(invoice.warnings).toEqual([]);
    });

    it('business whose VAT number cannot be confirmed is treated as a consumer', async () => {
        const vatCheck = await checkVatId('BE0403170701', { fetchFn: async () => ({ ok: false }) });
        expect(vatCheck.status).toBe('unavailable');
        const invoice = invoiceFor('order-be-business.json', vatCheck);
        expect(invoice.scenario).toBe('eu_b2c');
        expect(invoice.warnings.join(' ')).toContain('could not be confirmed');
    });

    it('UK and Canary Islands -> export with legal note', () => {
        const uk = invoiceFor('order-uk-export.json');
        expect(uk.scenario).toBe('export');
        expect(uk.legalNotes[0]).toContain('Article 146');
        expect(uk.warnings.join(' ')).toContain('£135');

        const canary = invoiceFor('order-es-canary-islands.json');
        expect(canary.scenario).toBe('export');
        expect(canary.legalNotes[0]).toContain('Canary Islands');
    });
});

describe('invoice amounts', () => {
    it('splits prices into net + VAT per rate, matching the Shopify total', () => {
        const invoice = invoiceFor('order-nl-consumer.json');
        const beakers = invoice.lines[0];
        expect(beakers).toMatchObject({ quantity: 2, unitPriceNet: 10000, discountNet: 2000, netTotal: 18000, vatAmount: 3780 });
        expect(invoice.vatSummary).toEqual([
            { rate: 0.21, net: 18500, vat: 3885 },
            { rate: 0.09, net: 1000, vat: 90 },
        ]);
        expect(invoice.totals).toEqual({ net: 19500, vat: 3975, gross: 23475 });
        expect(invoice.warnings).toEqual([]);
    });

    it('warns when VAT was charged on an export', () => {
        const order = loadOrder('order-uk-export.json');
        order.line_items[0].tax_lines = [{ title: 'VAT', rate: 0.21, price: '5.21' }];
        const classification = classifyOrder({ sellerCountry: 'NL', shipTo: { countryCode: 'GB', zip: 'SW1A 2AA' } });
        const invoice = buildInvoice({ order, seller, classification });
        expect(invoice.legalNotes).toEqual([]);
        expect(invoice.warnings.join(' ')).toContain('VAT was charged');
    });

    it('finds the VAT number the customer entered at checkout', () => {
        expect(findCustomerVatId(loadOrder('order-be-business.json'))).toBe('BE 0403.170.701');
        expect(findCustomerVatId(loadOrder('order-nl-consumer.json'))).toBeNull();
    });
});

describe('invoice numbers', () => {
    it('are sequential and one per order', () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const draft = invoiceFor('order-nl-consumer.json');
        const now = new Date('2026-10-08T12:00:00Z');

        const first = store.issue(draft, { now });
        const again = store.issue(draft, { now });
        const second = store.issue({ ...draft, orderId: '999' }, { now });

        expect(first.invoice.number).toBe('INV-2026-00001');
        expect(again).toMatchObject({ created: false, invoice: { number: 'INV-2026-00001' } });
        expect(second.invoice.number).toBe('INV-2026-00002');
        store.close();
    });

    it('restart every year and keep test orders separate', () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const draft = invoiceFor('order-nl-consumer.json');
        store.issue(draft, { now: new Date('2026-12-31T12:00:00Z') });
        const nextYear = store.issue({ ...draft, orderId: '2' }, { now: new Date('2027-01-01T12:00:00Z') });
        const test = store.issue({ ...draft, orderId: '3' }, { series: 'TEST-INV', now: new Date('2027-01-02T12:00:00Z') });

        expect(nextYear.invoice.number).toBe('INV-2027-00001');
        expect(test.invoice.number).toBe('TEST-INV-2027-00001');
        store.close();
    });
});

describe('full flow', () => {
    it('saves the PDF and a JSON copy, and re-creates a missing PDF', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const settings = { pdfDir: path.join(dir, 'pdfs'), series: 'INV', viesEnabled: false };
        const order = loadOrder('order-pl-consumer.json');

        const { invoice, pdfPath } = await createInvoiceForOrder(order, { store, seller, settings });
        expect(fs.readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF');
        expect(fs.existsSync(pdfPath.replace('.pdf', '.json'))).toBe(true);

        fs.rmSync(pdfPath);
        const again = await createInvoiceForOrder(order, { store, seller, settings });
        expect(again.created).toBe(false);
        expect(again.invoice.number).toBe(invoice.number);
        expect(fs.existsSync(again.pdfPath)).toBe(true);
        store.close();
    });

    it('renders an invoice with special characters to PDF', async () => {
        const pdf = await renderInvoice({ ...invoiceFor('order-pl-consumer.json'), number: 'INV-2026-00001', issueDate: '2026-10-08' });
        expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    });
});

describe('security', () => {
    it('download links only work with the right signature', () => {
        const url = downloadUrl('https://invoices.example.nl', 'INV-2026-00001', 'secret');
        const token = new URL(url).searchParams.get('token');
        expect(isValidToken('INV-2026-00001', token, 'secret')).toBe(true);
        expect(isValidToken('INV-2026-00002', token, 'secret')).toBe(false);
        expect(isValidToken('INV-2026-00001', 'guess', 'secret')).toBe(false);
    });

    it('only accepts webhooks signed by Shopify', () => {
        const body = Buffer.from('{"id":1}');
        const hmac = crypto.createHmac('sha256', 'app-secret').update(body).digest('base64');
        expect(isValidWebhook(body, hmac, 'app-secret')).toBe(true);
        expect(isValidWebhook(body, hmac, 'wrong-secret')).toBe(false);
        expect(isValidWebhook(body, undefined, 'app-secret')).toBe(false);
    });

    it('asks Shopify for an access token once and reuses it', async () => {
        let calls = 0;
        const fakeShopify = async (url, options) => {
            calls++;
            expect(url).toBe('https://shop.myshopify.com/admin/oauth/access_token');
            expect(options.body.get('grant_type')).toBe('client_credentials');
            return { ok: true, json: async () => ({ access_token: 'token-123', expires_in: 86399 }) };
        };
        const settings = { storeDomain: 'shop.myshopify.com', clientId: 'id', clientSecret: 'secret' };

        expect(await getAccessToken(settings, fakeShopify)).toBe('token-123');
        expect(await getAccessToken(settings, fakeShopify)).toBe('token-123');
        expect(calls).toBe(1);
    });

    it('checks that the company details are complete', () => {
        expect(checkSellerDetails(seller)).toEqual([]);
        expect(checkSellerDetails({ ...seller, legalName: 'Test Shop', registeredSeat: 'TODO' })).toHaveLength(2);
    });
});
