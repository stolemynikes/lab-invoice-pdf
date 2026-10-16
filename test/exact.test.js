import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ensureCustomer, customerFromOrder } from '../exact/exactCustomer.js';
import { write, odataText } from '../exact/exactClient.js';
import { pickVatCode } from '../exact/exactVatCodes.js';
import { invoiceOrderInExact, customerForExact } from '../exact/exactInvoice.js';
import { runExactCatchUp } from '../exact/exactCatchUp.js';
import { withExactLock, ExactBusyError, lockPathFor } from '../exact/exactLock.js';
import { getAccessToken } from '../exact/exactClient.js';
import { flag } from '../config.js';
import { creditRefundsInExact } from '../exact/exactCredit.js';
import { saveExactPdf, exactPdfPath } from '../exact/exactPdf.js';

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const CONTACT = '22222222-2222-2222-2222-222222222222';

// A fake Exact: answers GETs from the lists given, records every write. Nothing leaves the computer.
function fakeExact({ accounts = [], contacts = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-'));
    const tokenPath = path.join(dir, 'token.json');
    fs.writeFileSync(tokenPath, JSON.stringify({ accessToken: 'test', refreshToken: 'x', expiresAt: Date.now() + 600_000 }));
    const calls = [];
    const fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const text = decodeURIComponent(String(url));
        calls.push({ method, url: text, body: options.body ? JSON.parse(options.body) : null });
        const json = (d, status = 200) => ({ ok: true, status, json: async () => ({ d }), text: async () => '' });
        if (method === 'GET' && text.includes('/crm/Accounts')) return json({ results: accounts });
        if (method === 'GET' && text.includes('/crm/Contacts')) return json({ results: contacts });
        if (method === 'POST' && text.includes('/crm/Accounts')) return json({ ID: ACCOUNT }, 201);
        if (method === 'POST' && text.includes('/crm/Contacts')) return json({ ID: CONTACT }, 201);
        if (method === 'PUT') return { ok: true, status: 204, text: async () => '' };
        throw new Error(`unexpected ${method} ${text}`);
    };
    const settings = { baseUrl: 'https://start.exactonline.nl', division: '10002694', writeDivisions: ['10002694'], tokenPath, fetch };
    return { settings, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

const customer = {
    email: 'jan@example.com', company: null, firstName: 'Jan', lastName: 'de Vries',
    addressLine: 'Kerkstraat 1', postcode: '2011 AB', city: 'Haarlem', countryCode: 'NL', vatId: null,
};

describe('Exact customer with contact person', () => {
    it('creates the relation, a contact person with the e-mail address, and makes it the main contact', async () => {
        const exact = fakeExact();
        const result = await ensureCustomer(exact.settings, customer);
        expect(result).toEqual({ accountId: ACCOUNT, contactId: CONTACT, created: { account: true, contact: true } });
        const [account, contact, main] = exact.writes();
        expect(account.body).toMatchObject({ Name: 'Jan de Vries', Status: 'C', Email: 'jan@example.com', Country: 'NL' });
        expect(contact.body).toEqual({ Account: ACCOUNT, FirstName: 'Jan', LastName: 'de Vries', Email: 'jan@example.com' });
        expect(main.method).toBe('PUT');
        expect(main.body).toEqual({ MainContact: CONTACT });
    });

    it('adds only the contact person to an existing relation, and never changes its main contact', async () => {
        const exact = fakeExact({ accounts: [{ ID: ACCOUNT, MainContact: null }] });
        const result = await ensureCustomer(exact.settings, customer);
        expect(result.created).toEqual({ account: false, contact: true });
        expect(exact.writes().map((w) => w.method)).toEqual(['POST']);
    });

    it('changes nothing when relation and contact person are already there', async () => {
        const exact = fakeExact({ accounts: [{ ID: ACCOUNT, MainContact: CONTACT }], contacts: [{ ID: CONTACT }] });
        await ensureCustomer(exact.settings, customer);
        expect(exact.writes()).toEqual([]);
    });

    it('looks up business customers by VAT number, and stores it on the new relation', async () => {
        const exact = fakeExact();
        await ensureCustomer(exact.settings, { ...customer, company: 'Labo Janssens BV', vatId: 'BE0403170701' });
        expect(exact.calls[0].url).toContain("VATNumber eq 'BE0403170701'");
        expect(exact.writes()[0].body).toMatchObject({ Name: 'Labo Janssens BV', VATNumber: 'BE0403170701' });
    });

    it('takes the customer details from the Shopify order', () => {
        const order = JSON.parse(fs.readFileSync('fixtures/order-nl-consumer.json', 'utf8'));
        const result = customerFromOrder(order);
        expect(result.email).toMatch(/@/);
        expect(result.countryCode).toBe('NL');
        expect(result.lastName).not.toBe('');
    });
});

describe('Exact VAT codes', () => {
    const vatCodes = [
        { Code: '741', Description: 'Verkopen hoog incl. OSS - Duitsland', Percentage: 0.19 },
        { Code: '740', Description: 'Verkopen hoog excl. OSS - Duitsland', Percentage: 0.19 },
        { Code: '761', Description: 'Verkopen hoog incl. OSS - Finland', Percentage: 0.24 },
    ];

    it('picks the code that fits country, rate and incl./excl.', () => {
        expect(pickVatCode(vatCodes, { scenario: 'domestic', countryCode: 'NL', rate: 0.21, included: true })).toBe('101');
        expect(pickVatCode(vatCodes, { scenario: 'domestic', countryCode: 'NL', rate: 0.09, included: false })).toBe('102');
        expect(pickVatCode(vatCodes, { scenario: 'eu_b2c', countryCode: 'DE', rate: 0.19, included: true })).toBe('741');
        expect(pickVatCode(vatCodes, { scenario: 'eu_b2c', countryCode: 'DE', rate: 0.19, included: false })).toBe('740');
        expect(pickVatCode(vatCodes, { scenario: 'eu_b2b', countryCode: 'BE', rate: 0, included: true })).toBe('302');
        expect(pickVatCode(vatCodes, { scenario: 'export', countryCode: 'GB', rate: 0, included: true })).toBe('300');
    });

    it('gives no code when nothing fits, so the invoice is not made', () => {
        // Finland is 25.5% now, Exact only has 24%
        expect(pickVatCode(vatCodes, { scenario: 'eu_b2c', countryCode: 'FI', rate: 0.255, included: true })).toBeNull();
        // 0% inside the Netherlands means the Shopify tax settings are wrong; only test orders get "Geen BTW"
        expect(pickVatCode(vatCodes, { scenario: 'domestic', countryCode: 'NL', rate: 0, included: true })).toBeNull();
        expect(pickVatCode(vatCodes, { scenario: 'domestic', countryCode: 'NL', rate: 0, included: true, allowZeroForTest: true })).toBe('0');
    });
});

describe('Exact invoice for a paid order', () => {
    const INVOICE = '33333333-3333-3333-3333-333333333333';
    const ITEMS = { 'BKR-250': 'item-1', 'NB-A4': 'item-2', VERZENDING: 'item-3' };
    const paidOrder = () => ({ ...JSON.parse(fs.readFileSync('fixtures/order-nl-consumer.json', 'utf8')), test: true, financial_status: 'paid' });
    const invoiceSettings = { viesEnabled: false };

    // A fake Exact with articles, VAT codes and sales invoices
    function fakeInvoicing({ invoices = [], items = ITEMS, amount = 234.75 } = {}) {
        const exact = fakeExact();
        const base = exact.settings.fetch;
        exact.settings = { ...exact.settings, journal: '70', paymentCondition: 'WS', shippingItem: 'VERZENDING', sendEmail: true, testOrdersOnly: true };
        exact.settings.fetch = async (url, options = {}) => {
            const text = decodeURIComponent(String(url));
            const method = options.method || 'GET';
            const json = (d) => ({ ok: true, status: 200, json: async () => ({ d }), text: async () => '' });
            if (method === 'GET' && text.includes('/vat/VATCodes')) return json({ results: [] });
            if (method === 'GET' && text.includes('/salesinvoice/Layouts')) {
                return json({ results: [{ ID: 'layout-pdf', Subject: 'Starter', Type: 1 }, { ID: 'layout-mail', Subject: 'Begeleidend schrijven Factuur', Type: 2 }] });
            }
            if (method === 'GET' && text.includes('/logistics/Items')) {
                const code = text.match(/Code eq '([^']*)'/)[1];
                return json({ results: items[code] ? [{ ID: items[code] }] : [] });
            }
            if (method === 'GET' && text.includes('InvoiceID eq guid')) return json({ results: [{ AmountDC: amount, Status: 20, InvoiceNumber: 26700002 }] });
            if (method === 'GET' && text.includes('/SalesInvoices')) return json({ results: invoices });
            if (method === 'POST' && text.includes('/SalesInvoices')) {
                exact.calls.push({ method, url: text, body: JSON.parse(options.body) });
                return json({ InvoiceID: INVOICE });
            }
            if (method === 'POST' && text.includes('/PrintedSalesInvoices')) {
                exact.calls.push({ method, url: text, body: JSON.parse(options.body) });
                return json({});
            }
            return base(url, options);
        };
        return exact;
    }
    const run = (exact, order = paidOrder()) => invoiceOrderInExact(order, { settings: exact.settings, seller: { countryCode: 'NL' }, invoiceSettings });

    it('makes the invoice with contact person, payment date and order number, then lets Exact process and e-mail it', async () => {
        const exact = fakeInvoicing();
        const result = await run(exact);
        expect(result).toMatchObject({ status: 'invoiced', number: 26700002, emailed: true });

        const invoice = exact.calls.find((c) => c.url.endsWith('/salesinvoice/SalesInvoices'));
        expect(invoice.body).toMatchObject({
            Journal: '70', OrderedBy: ACCOUNT, InvoiceTo: ACCOUNT, InvoiceToContactPerson: CONTACT,
            PaymentCondition: 'WS', YourRef: '#1001', InvoiceDate: '2026-10-07',
        });
        // Like the old Lightspeed invoices: name on the first line, variant / carrier on the second
        expect(invoice.body.SalesInvoiceLines).toEqual([
            { Item: 'item-1', Description: 'Glass beaker set', Notes: '250 ml', Quantity: 2, NetPrice: 108.9, VATCode: '101' },
            { Item: 'item-2', Description: 'Lab notebook', Quantity: 1, NetPrice: 10.9, VATCode: '103' },
            { Item: 'item-3', Description: 'Shipping & handling', Notes: 'PostNL', Quantity: 1, NetPrice: 6.05, VATCode: '101' },
        ]);
        expect(invoice.body.Remarks).toBe('Paid in full on 07-10-2026. Order #1001.');
        const processed = exact.calls.find((c) => c.url.endsWith('/PrintedSalesInvoices'));
        // Without the e-mail layout Exact processes the invoice but sends no e-mail
        expect(processed.body).toEqual({ InvoiceID: INVOICE, InvoiceDate: '2026-10-07', SendEmailToCustomer: true, EmailLayout: 'layout-mail' });
    });

    it('makes a missing article from the Shopify product, with CAS and safety data, and then the invoice', async () => {
        const exact = fakeInvoicing({ items: { 'BKR-250': 'item-1', VERZENDING: 'item-3' } });
        const routed = exact.settings.fetch;
        exact.settings.createItems = true;
        exact.settings.fetch = async (url, options = {}) => {
            const text = decodeURIComponent(String(url));
            const json = (d) => ({ ok: true, status: 200, json: async () => ({ d }), text: async () => '' });
            if (!options.method && text.includes('/logistics/ItemGroups')) return json({ results: [{ ID: 'group-chem' }] });
            if (options.method === 'POST' && text.includes('/logistics/Items')) {
                exact.calls.push({ method: 'POST', url: text, body: JSON.parse(options.body) });
                return json({ ID: 'item-new' });
            }
            return routed(url, options);
        };
        const fetchProduct = async () => ({
            product: { title: 'Lab notebook', productType: 'Chemicaliën' },
            variant: { title: 'Default Title', barcode: '8721017405665', inventoryItem: { measurement: { weight: { value: 250, unit: 'GRAMS' } } } },
            fields: { cas: '64-17-5', un_number: 'UN 1170', adr_class: '3', ghs_pictograms: '["GHS02","GHS07"]' },
        });
        const order = { ...paidOrder(), line_items: paidOrder().line_items.map((item) => ({ ...item, product_id: 1, variant_id: 2 })) };
        const result = await invoiceOrderInExact(order, { settings: exact.settings, seller: { countryCode: 'NL' }, invoiceSettings, fetchProduct });
        expect(result.status).toBe('invoiced');

        const item = exact.calls.find((c) => c.url.endsWith('/logistics/Items')).body;
        expect(item).toMatchObject({
            Code: 'NB-A4', Description: 'Lab notebook', IsSalesItem: true, IsStockItem: true, Unit: 'pc', ItemGroup: 'group-chem',
            Barcode: '8721017405665', NetWeight: 0.25, FreeTextField_01: '64-17-5', FreeTextField_03: 'UN 1170', FreeTextField_04: '3',
            FreeTextField_07: 'GHS02, GHS07', FreeTextField_10: 'Chemicaliën',
        });
        expect(item.ExtraDescription).toContain('CAS: 64-17-5');
        const invoice = exact.calls.find((c) => c.url.endsWith('/salesinvoice/SalesInvoices'));
        expect(invoice.body.SalesInvoiceLines[1].Item).toBe('item-new');
        // CAS and UN under the product on the invoice
        expect(invoice.body.SalesInvoiceLines[1].Notes).toBe('CAS 64-17-5 · UN 1170 · ADR 3');
    });

    it('makes no article when the VAT code is missing, so nothing is made half', async () => {
        const exact = fakeInvoicing({ items: { 'BKR-250': 'item-1', VERZENDING: 'item-3' } });
        exact.settings.createItems = true;
        const order = { ...paidOrder(), line_items: paidOrder().line_items.map((item) => ({ ...item, product_id: 1, variant_id: 2, tax_lines: [{ rate: 0.13, price: '1.00' }] })) };
        await expect(invoiceOrderInExact(order, { settings: exact.settings, seller: { countryCode: 'NL' }, invoiceSettings, fetchProduct: async () => ({}) })).rejects.toThrow('no Exact VAT code');
        expect(exact.writes()).toEqual([]);
    });

    it('never makes a second invoice for the same order', async () => {
        const exact = fakeInvoicing({ invoices: [{ InvoiceID: INVOICE, InvoiceNumber: 26700001, Status: 50 }] });
        expect(await run(exact)).toEqual({ status: 'already invoiced', number: 26700001 });
        expect(exact.writes()).toEqual([]);
    });

    it('does nothing for unpaid orders, and only test orders while testing', async () => {
        const exact = fakeInvoicing();
        expect(await run(exact, { ...paidOrder(), financial_status: 'pending' })).toEqual({ status: 'not paid' });
        expect(await run(exact, { ...paidOrder(), test: false })).toEqual({ status: 'skipped (not a test order)' });
        expect(exact.calls).toEqual([]);
    });

    it('makes nothing at all when an article is missing in Exact', async () => {
        const exact = fakeInvoicing({ items: { 'BKR-250': 'item-1', VERZENDING: 'item-3' } });
        await expect(run(exact)).rejects.toThrow('article NB-A4 does not exist in Exact');
        expect(exact.writes()).toEqual([]);
    });

    it('leaves the invoice as a concept when the total in Exact differs from what the customer paid', async () => {
        const exact = fakeInvoicing({ amount: 234.74 });
        await expect(run(exact)).rejects.toThrow('Left as concept');
        expect(exact.calls.some((c) => c.url.endsWith('/PrintedSalesInvoices'))).toBe(false);
    });
});

describe('Exact credit note for a refund', () => {
    const CREDIT = '44444444-4444-4444-4444-444444444444';
    const refund = () => JSON.parse(fs.readFileSync('fixtures/refund-nl-consumer.json', 'utf8'));
    const refundedOrder = () => ({
        ...JSON.parse(fs.readFileSync('fixtures/order-nl-consumer.json', 'utf8')),
        test: true,
        financial_status: 'partially_refunded',
        refunds: [refund()],
    });

    // A fake Exact with a processed invoice for #1001, and optionally an existing credit note
    function fakeCrediting({ invoice = true, credits = [], amount = -114.95 } = {}) {
        const exact = fakeExact();
        const base = exact.settings.fetch;
        exact.settings = { ...exact.settings, journal: '70', paymentCondition: 'WS', shippingItem: 'VERZENDING', sendEmail: true, testOrdersOnly: true };
        exact.settings.fetch = async (url, options = {}) => {
            const text = decodeURIComponent(String(url));
            const method = options.method || 'GET';
            const json = (d) => ({ ok: true, status: 200, json: async () => ({ d }), text: async () => '' });
            if (method === 'GET' && text.includes('/vat/VATCodes')) return json({ results: [] });
            if (method === 'GET' && text.includes('/salesinvoice/Layouts')) return json({ results: [{ ID: 'layout-mail', Type: 2 }] });
            if (method === 'GET' && text.includes('/logistics/Items')) return json({ results: [{ ID: `item-${text.match(/Code eq '([^']*)'/)[1]}` }] });
            if (method === 'GET' && text.includes('InvoiceID eq guid')) return json({ results: [{ AmountDC: amount, InvoiceNumber: 26700020 }] });
            if (method === 'GET' && text.includes("YourRef eq '#1001 R")) return json({ results: credits });
            if (method === 'GET' && text.includes("YourRef eq '#1001'")) {
                return json({ results: invoice ? [{ InvoiceNumber: 26700012, InvoiceDate: '/Date(1791331200000)/', Status: 50 }] : [] });
            }
            if (method === 'POST' && /SalesInvoices$|PrintedSalesInvoices$/.test(text)) {
                exact.calls.push({ method, url: text, body: JSON.parse(options.body) });
                return json({ InvoiceID: CREDIT });
            }
            return base(url, options);
        };
        return exact;
    }
    const run = (exact, order = refundedOrder()) =>
        creditRefundsInExact(order, { settings: exact.settings, seller: { countryCode: 'NL' }, invoiceSettings: { viesEnabled: false } });

    it('makes a credit note with negative lines that refers to the invoice, and lets Exact e-mail it', async () => {
        const exact = fakeCrediting();
        const outcome = await run(exact);
        expect(outcome.done).toBe(true);
        expect(outcome.credits).toMatchObject([{ refundId: '9901', number: 26700020, invoiceNumber: 26700012, date: '2026-10-12', total: -11495, currency: 'EUR' }]);

        const credit = exact.calls.find((c) => c.url.endsWith('/salesinvoice/SalesInvoices')).body;
        expect(credit).toMatchObject({ Type: 8021, YourRef: '#1001 R9901', InvoiceDate: '2026-10-12', InvoiceTo: ACCOUNT, InvoiceToContactPerson: CONTACT });
        expect(credit.Remarks).toBe('Credit note for invoice 26700012 of 07-10-2026 (order #1001). Refunded on 12-10-2026.');
        expect(credit.SalesInvoiceLines.map((l) => [l.Item, l.Quantity, l.NetPrice, l.VATCode])).toEqual([
            ['item-BKR-250', -1, 108.9, '101'],
            ['item-VERZENDING', -1, 6.05, '101'],
        ]);
        expect(exact.calls.some((c) => c.url.endsWith('/PrintedSalesInvoices'))).toBe(true);
    });

    it('uses the separate credit note e-mail text when one is set', async () => {
        const exact = fakeCrediting();
        exact.settings.creditEmailLayout = 'layout-credit-mail';
        await run(exact);
        const processed = exact.calls.find((c) => c.url.endsWith('/PrintedSalesInvoices')).body;
        expect(processed.EmailLayout).toBe('layout-credit-mail');
    });

    it('never credits the same refund twice', async () => {
        const exact = fakeCrediting({ credits: [{ InvoiceID: CREDIT, InvoiceNumber: 26700020, Status: 50 }] });
        expect(await run(exact)).toEqual({ credits: [], done: true });
        expect(exact.writes()).toEqual([]);
    });

    it('waits until the invoice is in Exact', async () => {
        const exact = fakeCrediting({ invoice: false });
        expect(await run(exact)).toEqual({ credits: [], done: false });
        expect(exact.writes()).toEqual([]);
    });

    it('leaves the credit note as a concept when the amount does not match the refund', async () => {
        const exact = fakeCrediting({ amount: 114.95 }); // wrong sign
        await expect(run(exact)).rejects.toThrow('Left as concept');
        expect(exact.calls.some((c) => c.url.endsWith('/PrintedSalesInvoices'))).toBe(false);
    });
});

describe('Exact attacks', () => {
    it('never writes outside the allowed administrations', async () => {
        const exact = fakeExact();
        await expect(write({ ...exact.settings, writeDivisions: [] }, 'POST', '/api/v1/10002694/crm/Accounts', {})).rejects.toThrow('not allowed');
        await expect(write(exact.settings, 'POST', '/api/v1/99999/crm/Accounts', {})).rejects.toThrow('not allowed');
        await expect(write(exact.settings, 'DELETE', '/api/v1/10002694/crm/Accounts', {})).rejects.toThrow('Not an allowed write');
        expect(exact.calls).toEqual([]);
    });

    it('keeps a crafted e-mail address or VAT number inside the filter text', async () => {
        expect(decodeURIComponent(odataText("x' or Name ne 'y"))).toBe("'x'' or Name ne ''y'");
        const exact = fakeExact();
        for (const email of ["a'@b.nl", 'a@b.nl\r\nBcc: x@y.nl', 'not-an-address', '']) {
            await expect(ensureCustomer(exact.settings, { ...customer, email })).rejects.toThrow('Not a usable e-mail address');
        }
        await ensureCustomer(exact.settings, { ...customer, vatId: "BE1' or VATNumber ne '" });
        expect(exact.calls[0].url).toContain("VATNumber eq 'BE1'' or VATNumber ne '''");
    });
});

describe('Exact safety (review fixes)', () => {
    const order = () => ({ ...JSON.parse(fs.readFileSync('fixtures/order-nl-consumer.json', 'utf8')), test: true, financial_status: 'paid' });

    it('only uses a VAT number to find the customer when VIES confirmed it', () => {
        const typed = { ...order(), note_attributes: [{ name: 'VAT number', value: 'NL866495708B01' }] };
        const unconfirmed = { scenario: 'eu_b2c', vatCheck: { status: 'unavailable' }, buyer: { vatId: 'BE0403170701' } };
        expect(customerForExact(typed, unconfirmed).vatId).toBeNull();
        const confirmed = { scenario: 'eu_b2b', vatCheck: { status: 'valid' }, buyer: { vatId: 'BE0403170701' } };
        expect(customerForExact(typed, confirmed).vatId).toBe('BE0403170701');
    });

    it('keeps a safety switch on unless it clearly says no', () => {
        for (const value of ['TRUE', 'true ', '1', 'yes', 'ja', undefined, '', 'tru', 'flase']) expect(flag(value, true)).toBe(true);
        for (const value of ['false', 'FALSE', ' 0', 'no', 'nee', 'off']) expect(flag(value, true)).toBe(false);
    });

    it('makes a missing article only once when two order lines share its SKU', async () => {
        const exact = fakeExact();
        const posted = [];
        exact.settings = { ...exact.settings, journal: '70', paymentCondition: 'WS', shippingItem: 'VERZENDING', sendEmail: false, testOrdersOnly: true, createItems: true };
        const base = exact.settings.fetch;
        exact.settings.fetch = async (url, options = {}) => {
            const text = decodeURIComponent(String(url));
            const json = (d) => ({ ok: true, status: 200, json: async () => ({ d }), text: async () => '' });
            if (!options.method && text.includes('/vat/VATCodes')) return json({ results: [] });
            if (!options.method && text.includes('/logistics/ItemGroups')) return json({ results: [{ ID: 'g' }] });
            if (!options.method && text.includes('/logistics/Items')) return json({ results: /VERZENDING/.test(text) ? [{ ID: 'ship' }] : [] });
            if (!options.method && text.includes('InvoiceID eq guid')) return json({ results: [{ AmountDC: 21.8, InvoiceNumber: 1 }] });
            if (!options.method && text.includes('/SalesInvoices')) return json({ results: [] });
            if (options.method === 'POST' && text.includes('/logistics/Items')) {
                posted.push(JSON.parse(options.body).Code);
                return json({ ID: 'new' });
            }
            if (options.method === 'POST' && text.includes('/salesinvoice/')) return json({ InvoiceID: '33333333-3333-3333-3333-333333333333' });
            return base(url, options);
        };
        const line = { ...order().line_items[1], sku: 'SAME', product_id: 1, variant_id: 2, quantity: 1, price: '10.90', tax_lines: [{ rate: 0.09, price: '0.90' }] };
        const twoLines = { ...order(), line_items: [line, { ...line, id: 99 }], shipping_lines: [], total_price: '21.80' };
        const fetchProduct = async () => ({ product: { title: 'Notebook' }, variant: {}, fields: {} });
        await invoiceOrderInExact(twoLines, { settings: exact.settings, seller: { countryCode: 'NL' }, invoiceSettings: { viesEnabled: false }, fetchProduct });
        expect(posted).toEqual(['SAME']);
    });

    describe('catch-up', () => {
        const fakeStore = (values = {}) => ({
            values,
            getSetting: (key) => values[key] ?? null,
            setSetting: (key, value) => {
                values[key] = value;
            },
        });
        const failingExact = () => {
            const exact = fakeExact();
            exact.settings = { ...exact.settings, testOrdersOnly: true, sendEmail: false };
            exact.settings.fetch = async (url) => {
                exact.calls.push({ method: 'GET', url: String(url) });
                return { ok: false, status: 500, text: async () => 'down' };
            };
            return exact;
        };
        const now = new Date('2026-10-15T12:00:00Z');
        const invoiceSettings = { startDate: '2026-10-01' };

        it('makes no Exact calls for orders that are finished and did not change', async () => {
            const exact = failingExact();
            const paid = { ...order(), id: 7, updated_at: '2026-10-15T11:00:00Z' };
            const store = fakeStore({ 'exact_done:7': '2026-10-15T11:00:00Z' });
            const summary = await runExactCatchUp({ store, settings: exact.settings, seller: {}, invoiceSettings, fetchOrdersSince: async () => [paid], now });
            expect(summary.errors).toEqual([]);
            expect(exact.calls).toEqual([]);
        });

        it('puts a failing order on the retry list with a growing wait, and still moves the look-back on', async () => {
            const exact = failingExact();
            const paid = { ...order(), id: 8, name: 'LD1008', updated_at: '2026-10-15T11:00:00Z' };
            const store = fakeStore();
            const run = (at) => runExactCatchUp({ store, settings: exact.settings, seller: {}, invoiceSettings, fetchOrdersSince: async () => [paid], now: at });

            const first = await run(now);
            expect(first.errors[0]).toMatch(/^LD1008: .*next try in 2 min/);
            expect(store.values.last_exact_catch_up).toBe(now.toISOString());

            // One minute later: still waiting, no Exact calls
            const callsBefore = exact.calls.length;
            expect((await run(new Date(now.getTime() + 60_000))).errors).toEqual([]);
            expect(exact.calls.length).toBe(callsBefore);

            // Three minutes later: tried again, now waits 4 minutes
            expect((await run(new Date(now.getTime() + 180_000))).errors[0]).toMatch(/next try in 4 min/);
        });
    });

    describe('lock', () => {
        const settingsIn = () => ({ tokenPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'token.json') });

        it('lets only one run work with Exact at a time, and is re-entrant inside one run', async () => {
            const settings = settingsIn();
            fs.writeFileSync(lockPathFor(settings), JSON.stringify({ pid: process.pid, at: Date.now() }));
            await expect(withExactLock(settings, async () => 'x')).rejects.toBeInstanceOf(ExactBusyError);
            fs.rmSync(lockPathFor(settings));

            const result = await withExactLock(settings, () => withExactLock(settings, async () => 'nested'));
            expect(result).toBe('nested');
            expect(fs.existsSync(lockPathFor(settings))).toBe(false);
        });

        it('takes over a lock left behind by a process that is gone', async () => {
            const settings = settingsIn();
            fs.writeFileSync(lockPathFor(settings), JSON.stringify({ pid: 999999999, at: Date.now() }));
            expect(await withExactLock(settings, async () => 'ok')).toBe('ok');
        });

        it('does not refresh the login again when another process just did', async () => {
            const settings = settingsIn();
            let refreshed = 0;
            settings.fetch = async () => {
                refreshed++;
                return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 600 }) };
            };
            Object.assign(settings, { baseUrl: 'https://start.exactonline.nl', clientId: 'id', clientSecret: 'secret' });
            fs.writeFileSync(settings.tokenPath, JSON.stringify({ accessToken: 'old', refreshToken: 'r1', expiresAt: 0 }));
            expect(await getAccessToken(settings)).toBe('new');
            expect(await getAccessToken(settings)).toBe('new');
            expect(refreshed).toBe(1);
            expect(JSON.parse(fs.readFileSync(settings.tokenPath, 'utf8')).refreshToken).toBe('r2');
        });
    });
});

describe('Exact PDF copy on the NAS', () => {
    const job = { kind: 'invoice', number: 26700005, orderName: 'LD1008', customerName: 'Labo Janssens BV', date: '2026-10-15' };

    // A fake Exact with one document and its PDF; pdfUrl and pdfBody can be changed per test
    function fakePdfExact({ pdfUrl = 'https://start.exactonline.nl/docs/SysAttachment.aspx?ID=1', pdfBody = '%PDF-1.4 test', documents = [{ ID: '55555555-5555-5555-5555-555555555555' }] } = {}) {
        const exact = fakeExact();
        const downloads = [];
        exact.settings.fetch = async (url, options = {}) => {
            const text = decodeURIComponent(String(url));
            const json = (d) => ({ ok: true, status: 200, json: async () => ({ d }), text: async () => '' });
            if (text.includes('/documents/Documents')) return json({ results: documents });
            if (text.includes('/documents/DocumentAttachments')) return json({ results: [{ FileName: 'inv26700005.pdf', Url: pdfUrl }] });
            downloads.push({ url: text, auth: options.headers?.Authorization });
            return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(pdfBody).buffer };
        };
        return { exact, downloads };
    }

    it('saves invoices and credit notes in their own folder per year, with order number and name', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-'));
        const { exact } = fakePdfExact();
        const file = await saveExactPdf(exact.settings, dir, job);
        expect(file).toBe(path.join(dir, '2026', 'Facturen', 'Invoice 26700005 - LD1008 - Labo Janssens BV.pdf'));
        expect(fs.readFileSync(file, 'utf8')).toBe('%PDF-1.4 test');
        expect(exactPdfPath(dir, { ...job, kind: 'credit', number: 26700006 })).toBe(path.join(dir, '2026', 'Creditnotas', 'Credit note 26700006 - LD1008 - Labo Janssens BV.pdf'));
    });

    it('never sends the Exact login to another website, and only saves real PDFs', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-'));
        const evil = fakePdfExact({ pdfUrl: 'https://evil.example.com/steal' });
        await expect(saveExactPdf(evil.exact.settings, dir, job)).rejects.toThrow('does not point to Exact');
        expect(evil.downloads).toEqual([]);

        const notPdf = fakePdfExact({ pdfBody: '<html>login</html>' });
        await expect(saveExactPdf(notPdf.exact.settings, dir, job)).rejects.toThrow('not a PDF');
        expect(fs.existsSync(exactPdfPath(dir, job))).toBe(false);

        const missing = fakePdfExact({ documents: [] });
        await expect(saveExactPdf(missing.exact.settings, dir, job)).rejects.toThrow('no PDF in Exact yet');
    });

    it('never writes outside the PDF folder, whatever the order or customer is called', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-'));
        for (const name of ['../../evil', '..\\..\\evil', 'C:\\Windows\\x', 'a/b:c*d?"<>|', 'line\r\nbreak']) {
            const file = exactPdfPath(dir, { ...job, orderName: name, customerName: name });
            expect(path.dirname(file)).toBe(path.join(dir, '2026', 'Facturen'));
        }
        expect(() => exactPdfPath(dir, { ...job, number: '../1' })).toThrow('Not a valid Exact invoice number');
        expect(() => exactPdfPath(dir, { ...job, date: '../../x' })).toThrow('Not a valid date');
    });
});
