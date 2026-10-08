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
import { createInvoiceForOrder, savePdf } from '../invoice/createInvoice.js';
import { webhooksRoute } from '../routes/webhooksRoute.js';
import { processOrder } from '../invoice/processOrder.js';
import { sendQueuedEmails } from '../email/emailQueue.js';
import { buildDocumentEmail } from '../email/emailTemplate.js';
import { inRange, findProblems, installedPackages, nodeSecurityReleases } from '../scripts/securityCheck.js';
import { shopify } from '../config.js';
import { buildCreditNote } from '../invoice/buildCreditNote.js';
import { createCreditNoteForRefund } from '../invoice/createCreditNote.js';
import { runCatchUp } from '../invoice/catchUp.js';
import { downloadUrl, checkDownloadLink } from '../invoice/downloadLinks.js';
import { verifySessionToken } from '../invoice/sessionToken.js';
import express from 'express';
import { apiRoute } from '../routes/apiRoute.js';
import { invoicesRoute } from '../routes/invoicesRoute.js';
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
    it('download links only work for the right customer, document and time', () => {
        const now = Date.parse('2026-10-08T12:00:00Z');
        const url = new URL(downloadUrl('https://invoices.example.nl', 'INV-2026-00000001', '555', 'secret', { now }));
        const query = Object.fromEntries(url.searchParams);

        expect(checkDownloadLink('INV-2026-00000001', query, 'secret', { now })).toBe('555');
        expect(checkDownloadLink('INV-2026-00000002', query, 'secret', { now })).toBeNull(); // other invoice
        expect(checkDownloadLink('INV-2026-00000001', { ...query, customer: '556' }, 'secret', { now })).toBeNull(); // other customer
        expect(checkDownloadLink('INV-2026-00000001', query, 'secret', { now: now + 11 * 60 * 1000 })).toBeNull(); // expired
        expect(checkDownloadLink('INV-2026-00000001', { ...query, token: 'guess' }, 'secret', { now })).toBeNull();
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

describe('test invoices', () => {
    it('can be made again, but real invoices can never be removed', () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const draft = invoiceFor('order-nl-consumer.json');
        store.issue({ ...draft, orderId: 'test-order' }, { series: 'TEST-INV' });
        store.issue({ ...draft, orderId: 'real-order' }, { series: 'INV' });

        expect(store.deleteTestInvoice('test-order')).toEqual([]); // no PDFs were made in this test
        expect(store.findByOrder('test-order')).toBeNull();
        expect(() => store.deleteTestInvoice('real-order')).toThrow('can never be removed');
        expect(store.findByOrder('real-order')).not.toBeNull();
        store.close();
    });
});

describe('credit notes', () => {
    const refund = loadOrder('refund-nl-consumer.json');
    const order = loadOrder('order-nl-consumer.json');
    const invoice = { ...invoiceFor('order-nl-consumer.json'), number: 'INV-2026-00001', issueDate: '2026-10-08' };

    it('mirror the refunded products and shipping with negative amounts', () => {
        const creditNote = buildCreditNote({ refund, order, invoice, seller });
        expect(creditNote.lines[0]).toMatchObject({ quantity: -1, unitPriceNet: 10000, discountNet: -1000, netTotal: -9000, vatAmount: -1890 });
        expect(creditNote.lines[1]).toMatchObject({ description: 'Shipping – refund', netTotal: -500, vatAmount: -105, vatRate: 0.21 });
        expect(creditNote.vatSummary).toEqual([{ rate: 0.21, net: -9500, vat: -1995 }]);
        expect(creditNote.totals).toEqual({ net: -9500, vat: -1995, gross: -11495 });
        expect(creditNote.legalNotes[0]).toContain('INV-2026-00001');
        expect(creditNote.warnings).toEqual([]);
    });

    it('are not made when nothing was paid back', () => {
        const restockOnly = { ...refund, refund_line_items: [], order_adjustments: [], transactions: [] };
        expect(buildCreditNote({ refund: restockOnly, order, invoice, seller })).toBeNull();
    });

    it('warn when they do not match the refunded amount', () => {
        const wrong = { ...refund, transactions: [{ kind: 'refund', status: 'success', amount: '50.00' }] };
        expect(buildCreditNote({ refund: wrong, order, invoice, seller }).warnings.join(' ')).toContain('differs');
    });

    it('get their own number series, one per refund, and a PDF', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const settings = { pdfDir: path.join(dir, 'pdfs'), series: 'INV', creditSeries: 'CN', viesEnabled: false };

        const first = await createCreditNoteForRefund(refund, order, { store, seller, settings });
        const again = await createCreditNoteForRefund(refund, order, { store, seller, settings });
        const second = await createCreditNoteForRefund({ ...refund, id: 9902 }, order, { store, seller, settings });

        expect(store.findByOrder(order.id).number).toMatch(/^INV-\d{4}-00001$/); // invoice made first
        expect(first.creditNote.number).toMatch(/^CN-\d{4}-00001$/);
        expect(first.creditNote.originalInvoice.number).toBe(store.findByOrder(order.id).number);
        expect(again.created).toBe(false);
        expect(second.creditNote.number).toMatch(/^CN-\d{4}-00002$/);
        expect(fs.readFileSync(first.pdfPath).subarray(0, 4).toString()).toBe('%PDF');
        expect(store.getPdfPath(first.creditNote.number)).toBe(first.pdfPath);
        expect(store.creditNotesForOrder(order.id)).toHaveLength(2);
        store.close();
    });
});

describe('number length', () => {
    it('can be set with the number of digits', () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const draft = invoiceFor('order-nl-consumer.json');
        const { invoice } = store.issue(draft, { digits: 8, now: new Date('2026-10-08T12:00:00Z') });
        expect(invoice.number).toBe('INV-2026-00000001');
        store.close();
    });
});

describe('catch-up', () => {
    const settings = (dir) => ({ pdfDir: path.join(dir, 'pdfs'), series: 'INV', creditSeries: 'CN', numberDigits: 8, viesEnabled: false });
    const paidOrder = (overrides = {}) => ({ ...loadOrder('order-nl-consumer.json'), financial_status: 'paid', created_at: '2026-10-08T10:00:00+02:00', ...overrides });

    it('makes missing invoices and credit notes, and skips orders from before the start date', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const refund = loadOrder('refund-nl-consumer.json');
        const orders = [
            paidOrder({ id: 1, name: '#1', refunds: [refund] }),
            paidOrder({ id: 2, name: '#2', financial_status: 'pending' }), // not paid: no invoice
            paidOrder({ id: 3, name: '#3', created_at: '2026-09-01T10:00:00+02:00' }), // before the start date
        ];
        const saved = [];
        const summary = await runCatchUp({
            store, seller, settings: settings(dir), startDate: '2026-10-01',
            fetchOrdersSince: async () => orders,
            saveNumbers: async (orderId) => saved.push(String(orderId)),
        });

        expect(summary).toMatchObject({ invoices: 1, creditNotes: 1, skippedOld: 1, errors: [] });
        expect(store.findByOrder(1).number).toMatch(/^INV-\d{4}-00000001$/);
        expect(store.findByOrder(2)).toBeNull();
        expect(store.findByOrder(3)).toBeNull();
        expect(saved).toEqual(['1']);

        // A second run finds nothing new
        const again = await runCatchUp({ store, seller, settings: settings(dir), startDate: '2026-10-01', fetchOrdersSince: async () => orders, saveNumbers: async () => {} });
        expect(again).toMatchObject({ invoices: 0, creditNotes: 0 });
        store.close();
    });

    it('keeps trying to save links until Shopify can be reached', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const orders = [paidOrder({ id: 7, name: '#7' })];
        const offline = async () => { throw new Error('no internet'); };

        const first = await runCatchUp({ store, seller, settings: settings(dir), startDate: '2026-10-01', fetchOrdersSince: async () => orders, saveNumbers: offline });
        expect(first.invoices).toBe(1);
        expect(store.ordersWithPendingNumbers()).toEqual(['7']);

        const second = await runCatchUp({ store, seller, settings: settings(dir), startDate: '2026-10-01', fetchOrdersSince: async () => [], saveNumbers: async () => {} });
        expect(second.numbersSaved).toBe(1);
        expect(store.ordersWithPendingNumbers()).toEqual([]);
        store.close();
    });

    it('checks the same period again when an order failed', async () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const broken = paidOrder({ id: 8, name: '#8', line_items: null }); // makes building the invoice fail
        const summary = await runCatchUp({ store, seller, settings: settings(tempDir()), startDate: '2026-10-01', fetchOrdersSince: async () => [broken], saveNumbers: async () => {} });
        expect(summary.errors).toHaveLength(1);
        expect(store.getSetting('last_catch_up')).toBeNull();
        store.close();
    });
});

describe('restoring numbers', () => {
    it('puts documents back with their own number and continues the numbering after them', () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const draft = invoiceFor('order-nl-consumer.json');
        const now = new Date('2026-10-08T12:00:00Z');

        expect(store.restoreDocument({ ...draft, orderId: 'a', number: 'INV-2026-00000041', issueDate: '2026-10-01' })).toBe(true);
        expect(store.restoreDocument({ ...draft, orderId: 'a', number: 'INV-2026-00000041', issueDate: '2026-10-01' })).toBe(false); // never twice
        const next = store.issue({ ...draft, orderId: 'b' }, { digits: 8, now });
        expect(next.invoice.number).toBe('INV-2026-00000042');
        store.close();
    });
});

describe('customer account access', () => {
    const shopifySettings = { clientId: 'app-id', clientSecret: 'app-secret', storeDomain: 'shop.myshopify.com' };
    const now = Date.now();

    // Makes a session token like Shopify does
    function sessionToken(claims, secret = shopifySettings.clientSecret) {
        const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
            aud: 'app-id', dest: 'https://shop.myshopify.com', sub: 'gid://shopify/Customer/555',
            exp: Math.floor(now / 1000) + 60, nbf: Math.floor(now / 1000) - 5, ...claims,
        })}`;
        return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
    }

    it('accepts only real session tokens of a logged-in customer', () => {
        expect(verifySessionToken(sessionToken({}), { ...shopifySettings, now })).toEqual({ customerId: '555' });
        const fails = (token) => () => verifySessionToken(token, { ...shopifySettings, now });
        expect(fails(sessionToken({}, 'wrong-secret'))).toThrow('signature');
        expect(fails(sessionToken({ exp: Math.floor(now / 1000) - 120 }))).toThrow('expired');
        expect(fails(sessionToken({ aud: 'other-app' }))).toThrow('another app');
        expect(fails(sessionToken({ dest: 'https://other.myshopify.com' }))).toThrow('another shop');
        expect(fails(sessionToken({ sub: undefined }))).toThrow('No customer');
        expect(fails('not-a-token')).toThrow();
    });

    it('only shows and downloads the documents of the logged-in customer', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const settings = { pdfDir: path.join(dir, 'pdfs'), series: 'INV', creditSeries: 'CN', numberDigits: 8, viesEnabled: false };
        const order = (id, customerId) => ({ ...loadOrder('order-nl-consumer.json'), id, name: `#${id}`, financial_status: 'paid', customer: { id: customerId } });
        const mine = await createInvoiceForOrder(order(1, 555), { store, seller, settings });
        const theirs = await createInvoiceForOrder(order(2, 777), { store, seller, settings });

        const app = express();
        app.use('/api', apiRoute(store, { shopifySettings, linkSecret: 'link-secret', publicUrl: 'http://placeholder' }));
        app.use('/invoices', invoicesRoute(store, { linkSecret: 'link-secret' }));
        const server = app.listen(0);
        const base = `http://127.0.0.1:${server.address().port}`;

        try {
            // Without a token: nothing
            expect((await fetch(`${base}/api/documents`)).status).toBe(401);

            // With the token of customer 555: only their own invoice
            const response = await fetch(`${base}/api/documents`, { headers: { Authorization: `Bearer ${sessionToken({})}` } });
            const { documents } = await response.json();
            expect(documents.map((d) => d.invoice.number)).toEqual([mine.invoice.number]);

            // Their link works...
            const link = documents[0].invoice.url.replace('http://placeholder', base);
            const download = await fetch(link);
            expect(download.status).toBe(200);
            expect(Buffer.from(await download.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');

            // ...but not for the other customer's invoice, even with a valid-looking link
            const stolen = link.replace(encodeURIComponent(mine.invoice.number), encodeURIComponent(theirs.invoice.number));
            expect((await fetch(stolen)).status).toBe(403);
        } finally {
            server.close();
            store.close();
        }
    });
});

describe('attacks', () => {
    const shopifySettings = { clientId: 'app-id', clientSecret: 'app-secret', storeDomain: 'shop.myshopify.com' };

    async function startApp(store) {
        const app = express();
        app.use('/api', apiRoute(store, { shopifySettings, linkSecret: 'link-secret', publicUrl: 'http://placeholder' }));
        app.use('/invoices', invoicesRoute(store, { linkSecret: 'link-secret' }));
        app.use('/webhooks', webhooksRoute(store));
        const server = app.listen(0);
        return { server, base: `http://127.0.0.1:${server.address().port}` };
    }

    it('refuses crafted numbers, SQL and path tricks in download links', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const settings = { pdfDir: path.join(dir, 'pdfs'), series: 'INV', creditSeries: 'CN', numberDigits: 8, viesEnabled: false };
        await createInvoiceForOrder({ ...loadOrder('order-nl-consumer.json'), customer: { id: 555 } }, { store, seller, settings });
        const { server, base } = await startApp(store);

        try {
            const attempts = [
                '..%2F..%2F.env',
                '..%2F..%2Fdata%2Finvoices.db',
                encodeURIComponent("INV-2026-00000001' OR '1'='1"),
                encodeURIComponent('INV-2026-00000001; DROP TABLE invoices; --'),
                encodeURIComponent('INV-2026-00000001\r\nSet-Cookie: x=1'),
            ];
            for (const number of attempts) {
                const response = await fetch(`${base}/invoices/${number}/download?customer=555&expires=9999999999&token=x`);
                expect(response.status).toBe(403);
            }
            // SQL in the customer field of a link
            const sql = encodeURIComponent("555' OR '1'='1");
            expect((await fetch(`${base}/invoices/INV-2026-00000001/download?customer=${sql}&expires=9999999999&token=x`)).status).toBe(403);
            // The database is still fine
            expect(store.findByOrder(loadOrder('order-nl-consumer.json').id)).not.toBeNull();
        } finally {
            server.close();
            store.close();
        }
    });

    it('refuses fake session tokens and SQL in the API', async () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const { server, base } = await startApp(store);
        try {
            const fake = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"gid://shopify/Customer/555","aud":"app-id","dest":"shop.myshopify.com","exp":9999999999}').toString('base64url')}.`;
            for (const token of ["' OR 1=1 --", fake, 'a.b.c', '']) {
                const response = await fetch(`${base}/api/documents?order=${encodeURIComponent("1 OR 1=1")}`, { headers: { Authorization: `Bearer ${token}` } });
                expect(response.status).toBe(401);
            }
        } finally {
            server.close();
            store.close();
        }
    });

    it('refuses fake webhooks, broken messages and huge messages', async () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const { server, base } = await startApp(store);
        const post = (body, hmac) =>
            fetch(`${base}/webhooks/orders-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac }, body });
        try {
            expect((await post('{"id":1}', 'fake-signature')).status).toBe(401);
            const broken = '{not json';
            const signed = crypto.createHmac('sha256', shopify.clientSecret).update(broken).digest('base64');
            expect((await post(broken, signed)).status).toBe(400);
            expect((await post('x'.repeat(6 * 1024 * 1024), 'fake')).status).toBe(413);
            expect(store.findByOrder(1)).toBeNull();
        } finally {
            server.close();
            store.close();
        }
    });

    it('never writes files outside the invoice folder, whatever the number says', async () => {
        const dir = tempDir();
        const draft = invoiceFor('order-nl-consumer.json');
        for (const number of ['../../evil', 'INV-2026-1/../../evil', 'C:\evil', '']) {
            await expect(savePdf({ ...draft, number, issueDate: '2026-10-08' }, dir, {})).rejects.toThrow('Not a valid document number');
        }
        await expect(savePdf({ ...draft, number: 'INV-2026-00000001', issueDate: '../../x' }, dir, {})).rejects.toThrow('Not a valid issue date');

        const store = new InvoiceStore(path.join(dir, 'test.db'));
        expect(() => store.restoreDocument({ ...draft, orderId: 'x', number: '../../evil-2026-1', issueDate: '2026-10-08' })).toThrow();
        expect(store.findByOrder('x')).toBeNull();
        store.close();
    });
});

describe('security check', () => {
    it('reads version ranges the way npm writes them', () => {
        expect(inRange('4.17.1', '<4.20.0')).toBe(true);
        expect(inRange('4.21.0', '<4.20.0')).toBe(false);
        expect(inRange('2.1.0', '>=2.0.0 <2.3.1')).toBe(true);
        expect(inRange('3.0.5', '>=2.0.0 <2.3.1 || >=3.0.0 <3.0.4')).toBe(false);
        expect(inRange('3.0.2', '>=2.0.0 <2.3.1 || >=3.0.0 <3.0.4')).toBe(true);
        expect(inRange('1.0.0', '*')).toBe(true);
        expect(inRange('1.0.0', 'nonsense')).toBeNull(); // unreadable: reported to be safe
    });

    it('finds problems in old versions and stays quiet for fixed ones', () => {
        const advisories = {
            express: [
                { title: 'express vulnerable to XSS via response.redirect()', severity: 'low', vulnerable_versions: '<4.20.0', url: 'https://github.com/advisories/GHSA-qw6h-vgh9-j6wx' },
            ],
        };
        expect(findProblems({ express: ['4.17.1'] }, advisories)).toHaveLength(1);
        expect(findProblems({ express: ['5.2.1'] }, advisories)).toHaveLength(0);
    });

    it('only counts the packages that run in the app, including nested ones', () => {
        const lock = {
            packages: {
                '': { name: 'invoice-generator' },
                'node_modules/express': { version: '5.2.1' },
                'node_modules/vitest': { version: '5.0.3', dev: true },
                'node_modules/pdfkit/node_modules/fontkit': { version: '2.0.4' },
            },
        };
        expect(installedPackages(lock)).toEqual({ express: ['5.2.1'], fontkit: ['2.0.4'] });
    });

    it('notices a Node.js security release', () => {
        const releases = [{ version: 'v24.22.0', security: true }, { version: 'v24.21.0', security: false }, { version: 'v26.1.0', security: true }];
        expect(nodeSecurityReleases(releases, 'v24.21.0')).toEqual(['v24.22.0']);
        expect(nodeSecurityReleases(releases, 'v24.22.0')).toEqual([]);
    });
});

describe('e-mail', () => {
    const emailSettings = (dir) => ({
        pdfDir: path.join(dir, 'pdfs'), series: 'INV', creditSeries: 'CN', numberDigits: 8, viesEnabled: false,
        email: { enabled: true, language: 'en' },
    });
    const paidOrder = (overrides = {}) => ({ ...loadOrder('order-nl-consumer.json'), financial_status: 'paid', email: 'sanne@example.nl', ...overrides });

    it('sends the invoice and every credit note to the customer, once, with the PDF attached', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const sent = [];
        const sendEmail = async (message) => sent.push(message);
        const order = paidOrder({ refunds: [loadOrder('refund-nl-consumer.json')] });

        await processOrder(order, { store, seller, settings: emailSettings(dir), sendEmail });
        await processOrder(order, { store, seller, settings: emailSettings(dir), sendEmail }); // Shopify sends it again

        expect(sent).toHaveLength(2);
        expect(sent.map((m) => m.subject)).toEqual([
            expect.stringMatching(/^Credit note CN-\d{4}-00000001 – order #1001$/),
            expect.stringMatching(/^Invoice INV-\d{4}-00000001 – order #1001$/),
        ]);
        expect(sent.every((m) => m.to === 'sanne@example.nl')).toBe(true);
        expect(fs.readFileSync(sent[1].attachments[0].path).subarray(0, 4).toString()).toBe('%PDF');
        expect(sent[1].text).toContain('Dear Sanne de Vries');
        store.close();
    });

    it('tries again later when the mail server is down, and gives up after 10 times', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const down = async () => { throw new Error('connection refused'); };
        const result = await processOrder(paidOrder(), { store, seller, settings: emailSettings(dir), sendEmail: down });
        expect(result.emailErrors).toHaveLength(1);
        const number = result.invoice.number;
        expect(store.emailStatus(number)).toMatchObject({ status: 'pending', attempts: 1 });

        const sent = [];
        await sendQueuedEmails({ store, seller, settings: emailSettings(dir), send: async (m) => sent.push(m) });
        expect(sent).toHaveLength(1);
        expect(store.emailStatus(number).status).toBe('sent');

        // Another document that keeps failing
        store.queueEmail('INV-2026-00000099', 'x', 'a@example.nl');
        for (let i = 0; i < 12; i++) await sendQueuedEmails({ store, seller, settings: emailSettings(dir), send: down });
        expect(store.emailStatus('INV-2026-00000099')).toMatchObject({ status: 'failed', attempts: 10 });
        store.close();
    });

    it('does not e-mail when e-mail is off, or when the address is not valid', async () => {
        const dir = tempDir();
        const store = new InvoiceStore(path.join(dir, 'test.db'));
        const sent = [];
        const off = { ...emailSettings(dir), email: { enabled: false } };
        await processOrder(paidOrder({ id: 1 }), { store, seller, settings: off, sendEmail: async (m) => sent.push(m) });
        for (const [id, email] of [[2, 'not-an-address'], [3, 'a@example.nl\r\nBcc: everyone@example.nl'], [4, 'a@example.nl, b@example.nl'], [5, null]]) {
            await processOrder(paidOrder({ id, email }), { store, seller, settings: emailSettings(dir), sendEmail: async (m) => sent.push(m) });
        }
        expect(sent).toHaveLength(0);
        store.close();
    });

    it('makes names from Shopify harmless in the e-mail', () => {
        const invoice = {
            ...invoiceFor('order-nl-consumer.json'),
            number: 'INV-2026-00000001',
            issueDate: '2026-10-08',
            orderName: '#1001\r\nBcc: x@example.nl',
            buyer: { name: '<script>alert(1)</script>', countryCode: 'NL', addressLines: [] },
        };
        const email = buildDocumentEmail(invoice, seller);
        expect(email.html).not.toContain('<script>');
        expect(email.html).toContain('&lt;script&gt;');
        expect(email.subject).not.toMatch(/[\r\n]/);
        expect(buildDocumentEmail(invoice, seller, { language: 'auto' }).subject).toMatch(/^Factuur/);
    });
});

describe('webhook edge cases', () => {
    it('refuses a webhook that is not JSON instead of crashing', async () => {
        const store = new InvoiceStore(path.join(tempDir(), 'test.db'));
        const app = express();
        app.use('/webhooks', webhooksRoute(store));
        const server = app.listen(0);
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/orders-paid`, {
                method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Shopify-Hmac-Sha256': 'x' }, body: 'hello',
            });
            expect(response.status).toBe(401);
        } finally {
            server.close();
            store.close();
        }
    });
});
