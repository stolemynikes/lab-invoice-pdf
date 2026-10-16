import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { adminRoute } from '../routes/adminRoute.js';
import { createLogBook } from '../admin/logBook.js';
import { readSettings } from '../admin/settingsFile.js';
import { createFacturenAdmin, translateLine, reasonInDutch } from '../admin/facturenAdmin.js';

const KEY = 'k'.repeat(40);
let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-'));
    process.env.SETTINGS_PATH = path.join(dir, 'settings.json');
});

// A tiny store with only the settings table
const fakeStore = (values = {}) => ({ getSetting: (key) => values[key] ?? null, setSetting: (key, value) => { values[key] = value; }, values });

function startApp({ provider, adminKey = KEY } = {}) {
    let restarted = 0;
    const logBook = createLogBook({ dir: path.join(dir, 'logs'), translate: translateLine });
    const app = express();
    app.use('/internal/admin', adminRoute({ adminKey, provider, logBook, restart: () => restarted++ }));
    const server = app.listen(0);
    const ask = (method, url, { body, headers = {} } = {}) =>
        new Promise((resolve, reject) => {
            const request = http.request({ port: server.address().port, method, path: url, headers: { 'content-type': 'application/json', ...headers } }, (response) => {
                let text = '';
                response.on('data', (chunk) => (text += chunk));
                response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
            });
            request.on('error', reject);
            if (body) request.write(JSON.stringify(body));
            request.end();
        });
    return { server, ask, logBook, restarted: () => restarted };
}

const auth = { authorization: `Bearer ${KEY}` };
const exactSettings = { tokenPath: path.join(os.tmpdir(), 'no-token.json'), division: '10002694', pollMinutes: 2, testOrdersOnly: true, baseUrl: 'https://start.exactonline.nl', clientId: 'id', redirectUri: 'https://x/cb' };
const provider = (store = fakeStore()) => createFacturenAdmin({ store, exact: exactSettings, invoiceSettings: { pdfDir: dir }, env: {} });

describe('admin panel access', () => {
    it('only answers with the right key, never through a tunnel, and always the same 404', async () => {
        const { server, ask } = startApp({ provider: provider() });
        try {
            expect((await ask('GET', '/internal/admin/status')).status).toBe(404);
            expect((await ask('GET', '/internal/admin/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(404);
            for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'ngrok-trace-id']) {
                expect((await ask('GET', '/internal/admin/status', { headers: { ...auth, [header]: '1.2.3.4' } })).status).toBe(404);
            }
            expect((await ask('GET', '/internal/admin/status', { headers: auth })).status).toBe(200);
        } finally {
            server.close();
        }
    });

    it('does not exist with a short or missing key', async () => {
        const { server, ask } = startApp({ provider: provider(), adminKey: 'short' });
        try {
            expect((await ask('GET', '/internal/admin/status', { headers: { authorization: 'Bearer short' } })).status).toBe(404);
        } finally {
            server.close();
        }
    });
});

describe('admin panel settings', () => {
    it('saves allowed settings in data/settings.json and restarts the app; refuses bad values', async () => {
        const { server, ask, restarted } = startApp({ provider: provider() });
        try {
            const ok = await ask('PUT', '/internal/admin/settings', { headers: auth, body: { values: { EXACT_SEND_EMAIL: 'false', EXACT_POLL_MINUTES: '5' } } });
            expect(ok.status).toBe(200);
            expect(readSettings()).toEqual({ EXACT_SEND_EMAIL: 'false', EXACT_POLL_MINUTES: '5' });
            expect(restarted()).toBe(1);

            for (const values of [{ EXACT_POLL_MINUTES: '0' }, { EXACT_SEND_EMAIL: 'maybe' }, { EXACT_DIVISION: '1' }, { EXACT_SENDER_EMAIL: 'x@y.nl\nBcc: z@z.nl' }]) {
                expect((await ask('PUT', '/internal/admin/settings', { headers: auth, body: { values } })).status).toBe(400);
            }
            expect(restarted()).toBe(1);
        } finally {
            server.close();
        }
    });

    it('never sends a secret back, only whether it is set', async () => {
        const store = fakeStore();
        const admin = createFacturenAdmin({ store, exact: exactSettings, invoiceSettings: { pdfDir: dir }, env: { SHOPIFY_CLIENT_SECRET: 'shpss_secret_value_123' } });
        const field = admin.fields().find((f) => f.key === 'SHOPIFY_CLIENT_SECRET');
        expect(field.value).toBeNull();
        expect(field.isSet).toBe(true);
        expect(JSON.stringify(admin.fields())).not.toContain('shpss_secret');
    });

    it('switches the app on and off', async () => {
        const { server, ask, restarted } = startApp({ provider: provider() });
        try {
            expect((await ask('POST', '/internal/admin/enabled', { headers: auth, body: { enabled: false } })).status).toBe(200);
            expect(readSettings().INVOICE_ENABLED).toBe('false');
            expect((await ask('POST', '/internal/admin/enabled', { headers: auth, body: { enabled: 'nee' } })).status).toBe(400);
            expect(restarted()).toBe(1);
        } finally {
            server.close();
        }
    });
});

describe('admin panel restart, TEST/LIVE and shared settings', () => {
    it('restarts only with the key', async () => {
        const { server, ask, restarted } = startApp({ provider: provider() });
        try {
            expect((await ask('POST', '/internal/admin/restart')).status).toBe(404);
            expect(restarted()).toBe(0);
            expect((await ask('POST', '/internal/admin/restart', { headers: auth })).status).toBe(200);
            expect(restarted()).toBe(1);
        } finally {
            server.close();
        }
    });

    it('reports TEST for test orders, the test store and the Exact copy, and LIVE otherwise', async () => {
        const test = await createFacturenAdmin({ store: fakeStore(), exact: exactSettings, invoiceSettings: { pdfDir: dir }, env: { SHOPIFY_STORE_DOMAIN: 'hevjuq-bg.myshopify.com' } }).status();
        expect(test.mode).toBe('test');
        expect(test.testLive.map((p) => p.mode)).toEqual(['test', 'test', 'test']);
        expect(test.sharedKeys).toEqual({ shopDomain: 'SHOPIFY_STORE_DOMAIN', contactEmail: 'SELLER_EMAIL' });

        const live = await createFacturenAdmin({ store: fakeStore(), exact: { ...exactSettings, testOrdersOnly: false, division: '999' }, invoiceSettings: { pdfDir: dir }, env: { SHOPIFY_STORE_DOMAIN: 'laboratoriumdiscounter.myshopify.com' } }).status();
        expect(live.testLive.map((p) => p.mode)).toEqual(['live', 'live', 'live']);
    });

    it('attacks: the shared store address must be a .myshopify.com address', async () => {
        const admin = provider();
        expect(admin.validate({ SHOPIFY_STORE_DOMAIN: 'laboratoriumdiscounter.myshopify.com' })).toEqual([]);
        for (const bad of ['evil.com', 'x.myshopify.com.evil.com', 'x.myshopify.com/admin', '', 'X.MYSHOPIFY.COM ']) {
            expect(admin.validate({ SHOPIFY_STORE_DOMAIN: bad }).length, bad).toBe(1);
        }
        expect(admin.validate({ INVOICE_START_DATE: '1-1-2026' }).length).toBe(1);
        expect(admin.validate({ INVOICE_START_DATE: '2026-11-01' })).toEqual([]);
    });

    it('tests another Shopify store read-only, never calling a host that is not .myshopify.com', async () => {
        const calls = [];
        const fetchFn = async (url) => {
            calls.push(url);
            if (url.endsWith('/admin/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
            return new Response(JSON.stringify({ data: { shop: { name: 'Laboratoriumdiscounter', myshopifyDomain: 'lab.myshopify.com' } } }), { status: 200 });
        };
        const admin = createFacturenAdmin({ store: fakeStore(), exact: exactSettings, invoiceSettings: { pdfDir: dir }, env: { SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'secret' }, fetchFn });
        const ok = await admin.actions['shopify-test']({ domain: 'lab.myshopify.com' });
        expect(ok).toMatchObject({ ok: true, name: 'Laboratoriumdiscounter' });
        expect(calls.every((url) => url.startsWith('https://lab.myshopify.com/'))).toBe(true);

        const bad = await admin.actions['shopify-test']({ domain: 'evil.com/x?' });
        expect(bad.ok).toBe(false);
        expect(calls.length).toBe(2);
    });
});

describe('admin panel status and actions', () => {
    it('lists failing orders in plain Dutch with what to do, and retries one now', async () => {
        const store = fakeStore({ exact_retry: JSON.stringify({ 77: { name: 'LD1012', attempts: 3, nextTry: Date.now() + 600000, updatedAt: 'x', error: 'not made in Exact: no Exact VAT code for 25.5% (eu_b2c, FI)' } }) });
        let ran = 0;
        const admin = createFacturenAdmin({ store, exact: exactSettings, invoiceSettings: { pdfDir: dir }, env: {}, runNow: () => ran++ });
        const status = await admin.status();
        expect(status.todo[0]).toMatchObject({ title: 'Order LD1012 heeft (nog) geen factuur', why: 'Waarom: Exact kent geen btw-tarief van 25,5% voor Finland.' });
        expect(status.todo[0].action).toEqual({ id: 'retry', label: 'Opnieuw proberen', body: { orderId: '77' } });

        await admin.actions.retry({ orderId: '77' });
        expect(JSON.parse(store.values.exact_retry)[77].nextTry).toBe(0);
        expect(ran).toBe(1);
        await expect(admin.actions.retry({ orderId: '../1' })).rejects.toThrow('Onbekende order');
    });

    it('offers to connect Exact again when the login was refused', async () => {
        const store = fakeStore({ exact_retry: JSON.stringify({ 9: { name: 'LD1009', attempts: 1, error: 'Exact refused the login (401). ' } }) });
        const status = await createFacturenAdmin({ store, exact: exactSettings, invoiceSettings: { pdfDir: dir }, env: {} }).status();
        expect(status.todo[0].action.id).toBe('exact-connect');
        expect(status.checks.find((c) => c.id === 'exact').level).toBe('bad');
    });

    it('turns log lines into plain Dutch, and keeps them in the logbook', () => {
        expect(translateLine('Exact: invoice 26700010 for LD1011, e-mailed by Exact')).toEqual({ text: 'Factuur 26700010 voor LD1011 gemaakt en gemaild naar de klant.', level: 'ok' });
        expect(translateLine('  ⚠ LD1009: Exact refused the login (401).  (next try in 4 min)').text).toBe('LD1009: de koppeling met Exact werkt niet meer. Volgende poging over 4 minuten.');
        expect(reasonInDutch('not made in Exact: article LD-X does not exist in Exact')).toBe('artikel LD-X bestaat niet in Exact.');

        const logBook = createLogBook({ dir: path.join(dir, 'logs'), translate: translateLine });
        logBook.add('Exact: invoice 26700010 for LD1011, e-mailed by Exact');
        logBook.add('  ⚠ LD1012: not made in Exact: no Exact VAT code for 25.5% (eu_b2c, FI) (next try in 8 min)');
        expect(logBook.read({ level: 'problems' })).toHaveLength(1);
        expect(logBook.read({ query: 'ld1011' })[0].plain).toContain('26700010');
    });
});
