import fs from 'node:fs';
import { badRequest } from '../routes/adminRoute.js';
import { authorizeUrl, codeFromInput, exchangeCode, get } from '../exact/exactClient.js';
import { withExactLock } from '../exact/exactLock.js';
import { health } from './health.js';
import { checkShopifyStore, isValidStoreDomain } from './shopifyCheck.js';

// What the NAS admin panel shows and may change for the invoice app.

import { ALLOWED_KEYS } from './allowedKeys.js';
export { ALLOWED_KEYS };

// Each setting is shown as a plain question. "choices" become answer cards; "mode" marks the TEST or LIVE answer,
// "risky" asks for an extra confirmation. "shared" settings are set once for all apps (panel tab Algemeen).
const FIELDS = [
    { key: 'EXACT_TEST_ORDERS_ONLY', group: 'Facturen maken', type: 'bool', label: 'Wie krijgen er een factuur?', fallback: 'true',
        choices: [
            { value: 'true', title: 'Alleen testorders', text: 'Om uit te proberen. Echte klanten krijgen niets.', mode: 'test' },
            { value: 'false', title: 'Alle betaalde orders', text: 'Echte klanten krijgen hun factuur. Alleen doen na akkoord van de boekhouder.', mode: 'live', risky: 'Vanaf nu krijgen echte klanten een factuur. Doe dit alleen als de boekhouder akkoord heeft gegeven.' },
        ] },
    { key: 'EXACT_SEND_EMAIL', group: 'Facturen maken', type: 'bool', label: 'Moet de klant de factuur per e-mail krijgen?', fallback: 'true',
        choices: [
            { value: 'true', title: 'Ja, mailen', text: 'Exact mailt de factuur direct nadat hij gemaakt is.' },
            { value: 'false', title: 'Nee, niet mailen', text: 'De factuur wordt wel gemaakt, maar de klant krijgt hem niet.' },
        ] },
    { key: 'EXACT_SAVE_PDF', group: 'Facturen maken', type: 'bool', label: 'Moet er een kopie van de PDF op de NAS komen?', fallback: 'true',
        choices: [
            { value: 'true', title: 'Ja, kopie bewaren', text: 'In de map facturen, per jaar, bij Facturen of Creditnota\'s.' },
            { value: 'false', title: 'Nee', text: 'De factuur staat dan alleen in Exact.' },
        ] },
    { key: 'EXACT_CREATE_ITEMS', group: 'Facturen maken', type: 'bool', label: 'Wat als een product nog niet in Exact staat?', fallback: 'true',
        choices: [
            { value: 'true', title: 'Zelf aanmaken in Exact', text: 'Met de gegevens uit Shopify (zoals CAS- en UN-nummer). De factuur gaat gewoon door.' },
            { value: 'false', title: 'Niet aanmaken, eerst melden', text: 'De order krijgt nog geen factuur en komt bij "Moet ik iets doen?".' },
        ] },
    { key: 'EXACT_SENDER_EMAIL', group: 'Facturen maken', type: 'email', label: 'Vanaf welk e-mailadres gaat de factuur?', empty: 'het adres van de Exact-gebruiker',
        placeholder: 'facturen@laboratoriumdiscounter.nl', help: 'Leeg = het adres van de Exact-gebruiker. Dit adres moet eerst in Exact staan, bij Administratiemailadressen. Klanten kunnen hier niet op antwoorden.' },
    { key: 'INVOICE_START_DATE', group: 'Facturen maken', type: 'date', label: 'Vanaf welke datum krijgen orders een factuur?', empty: 'de eerste dag dat de app draaide',
        help: 'Orders van vóór deze datum krijgen nooit een factuur. Belangrijk bij de overstap naar de echte webshop, anders krijgen oude orders er ook een.' },
    { key: 'EXACT_POLL_MINUTES', group: 'Voor de beheerder', advanced: true, type: 'number', label: 'Elke hoeveel minuten kijken naar nieuwe orders', fallback: '2', help: 'Lager = sneller een factuur, maar meer vragen aan Shopify en Exact.' },
    { key: 'SHOPIFY_CLIENT_ID', group: 'Voor de beheerder', advanced: true, type: 'text', label: 'Client ID van de Shopify-app "Facturen"', help: 'Te vinden in het Shopify Dev Dashboard → app Facturen → Instellingen.' },
    { key: 'SHOPIFY_CLIENT_SECRET', group: 'Voor de beheerder', advanced: true, type: 'secret', label: 'Client secret van de Shopify-app "Facturen"', help: 'Wordt nooit getoond. Alleen invullen als je een nieuwe hebt gekregen.' },
    { key: 'SHOPIFY_STORE_DOMAIN', shared: 'shopDomain', type: 'text', label: 'Webshop (Shopify)' },
    { key: 'SELLER_EMAIL', shared: 'contactEmail', type: 'email', label: 'Contactadres van de winkel' },
];

// Which shared panel setting (tab Algemeen) is which setting in this app
const SHARED_KEYS = { shopDomain: 'SHOPIFY_STORE_DOMAIN', contactEmail: 'SELLER_EMAIL' };

// What counts as TEST: the test store and the copy of the administration in Exact
const TEST_STORE = 'hevjuq-bg.myshopify.com';
const TEST_DIVISION = '10002694';

const TRUE_FALSE = ['true', 'false'];

// ---------- plain Dutch for the logbook ----------

export function translateLine(text) {
    const rules = [
        [/^Exact: invoice (\d+) for ([^\s,]+)(, e-mailed by Exact)?/, (m) => ({ text: `Factuur ${m[1]} voor ${m[2]} gemaakt${m[3] ? ' en gemaild naar de klant' : ''}.`, level: 'ok' })],
        [/^Exact: credit note (\d+) for (\S+) \(invoice (\d+)\)/, (m) => ({ text: `Creditnota ${m[1]} voor ${m[2]} gemaakt (bij factuur ${m[3]}).`, level: 'ok' })],
        [/^Exact: PDF saved: (.+)$/, (m) => ({ text: `PDF opgeslagen: ${m[1].replace(/^\/facturen\//, 'facturen/')}`, level: 'ok' })],
        [/^Exact: new article (\S+) made \((.*)\)/, (m) => ({ text: `Nieuw artikel in Exact gemaakt: ${m[1]} (${m[2]}).`, level: 'ok' })],
        [/^Exact: concept (invoice|credit note) made for (\S+)/, (m) => ({ text: `Concept${m[1] === 'invoice' ? 'factuur' : 'creditnota'} voor ${m[2]} klaargezet in Exact.`, level: 'ok' })],
        [/(\S+): (.*)\(next try in (\d+) min\)/, (m) => ({ text: `${m[1]}: ${reasonInDutch(m[2])} Volgende poging over ${m[3]} minuten.`, level: 'bad' })],
        [/^PDF of (\d+) \((\S+)\) not saved/, (m) => ({ text: `PDF van ${m[1]} (${m[2]}) staat nog niet op de NAS. Wordt opnieuw geprobeerd.`, level: 'warn' })],
        [/^Customer account: session token refused/, () => ({ text: 'Factuurknop in de webshop: toegang geweigerd. Kloppen de Shopify-sleutels?', level: 'warn' })],
        [/^Exact catch-up could not reach Shopify or Exact/, () => ({ text: 'Shopify of Exact was even niet bereikbaar. De volgende ronde probeert het opnieuw.', level: 'warn' })],
        [/^App is listening/, () => ({ text: 'App gestart.', level: 'ok' })],
        [/^Invoices are made by Exact.*TEST ORDERS ONLY/, () => ({ text: 'Facturen via Exact, alleen voor testorders.', level: 'ok' })],
        [/^Invoices are made by Exact/, () => ({ text: 'Facturen via Exact, voor alle betaalde orders.', level: 'ok' })],
        [/^Settings changed in the admin panel/, () => ({ text: 'Instellingen gewijzigd in het paneel. App start opnieuw.', level: 'ok' })],
        [/switched (on|off) in the admin panel/, (m) => ({ text: `Facturen ${m[1] === 'on' ? 'aangezet' : 'uitgezet'} in het paneel.`, level: 'ok' })],
        [/^Exact connected again from the admin panel/, () => ({ text: 'Exact opnieuw gekoppeld via het paneel.', level: 'ok' })],
        [/restarted from the admin panel/, () => ({ text: 'Facturen opnieuw gestart via het paneel.', level: 'ok' })],
        [/^Note: (.*)/, () => null],
    ];
    for (const [pattern, make] of rules) {
        const match = text.match(pattern);
        if (match) return make(match);
    }
    return null;
}

export function reasonInDutch(reason) {
    const text = String(reason);
    if (/Exact refused the login/.test(text)) return 'de koppeling met Exact werkt niet meer.';
    let match = text.match(/article (\S+) does not exist in Exact/);
    if (match) return `artikel ${match[1]} bestaat niet in Exact.`;
    match = text.match(/no Exact VAT code for ([\d.]+)% \((\w+), (\w+)\)/);
    if (match) return `Exact kent geen btw-tarief van ${match[1].replace('.', ',')}% voor ${countryName(match[3])}.`;
    if (/Left as concept/.test(text)) return 'het bedrag in Exact klopt niet met Shopify. De factuur staat als concept in Exact.';
    if (/has no SKU/.test(text)) return 'een product in de order heeft geen artikelcode (SKU).';
    if (/cannot be credited automatically/.test(text)) return 'deze terugbetaling kan niet automatisch gecrediteerd worden.';
    if (/Not a usable e-mail address/.test(text)) return 'het e-mailadres van de klant is ongeldig.';
    return `${text.replace(/\s+$/, '')}.`;
}

function howToFix(reason) {
    const text = String(reason);
    if (/Exact refused the login/.test(text)) return { how: 'Koppel Exact opnieuw (knop hieronder). Daarna gaat het vanzelf verder.', action: { id: 'exact-connect', label: 'Koppel Exact opnieuw' } };
    if (/VAT code/.test(text)) return { how: 'Vraag de boekhouder dit btw-tarief in Exact bij te werken. Klik daarna op "Opnieuw proberen".' };
    if (/does not exist in Exact/.test(text)) return { how: 'Maak dit artikel aan in Exact (zelfde code als in Shopify). Klik daarna op "Opnieuw proberen".' };
    if (/Left as concept/.test(text)) return { how: 'Bekijk de conceptfactuur in Exact en verwerk hem zelf, of verwijder hem en klik op "Opnieuw proberen".' };
    if (/has no SKU/.test(text)) return { how: 'Geef het product in Shopify een SKU die ook in Exact bestaat. Klik daarna op "Opnieuw proberen".' };
    return { how: 'Bekijk het logboek voor details, of vraag het aan de beheerder.' };
}

const COUNTRY_NAMES = new Intl.DisplayNames(['nl'], { type: 'region' });
function countryName(code) {
    try {
        return COUNTRY_NAMES.of(code);
    } catch {
        return code;
    }
}

// ---------- the provider for routes/adminRoute.js ----------

export function createFacturenAdmin({ store, exact, invoiceSettings, runNow = () => {}, env = process.env, fetchFn = fetch }) {
    const enabled = () => env.INVOICE_ENABLED !== 'false';

    function retries() {
        try {
            return JSON.parse(store.getSetting('exact_retry') || '{}');
        } catch {
            return {};
        }
    }

    function pdfPending() {
        try {
            return JSON.parse(store.getSetting('exact_pdf_pending') || '[]');
        } catch {
            return [];
        }
    }

    function checks() {
        const list = [];
        const s = health.shopify;
        list.push(s.ok === false
            ? { id: 'shopify', level: 'bad', label: 'Webshop (Shopify) — geen verbinding', detail: `Laatste fout: ${s.error}` }
            : { id: 'shopify', level: 'ok', label: 'Webshop (Shopify) — verbonden', detail: s.at ? `Laatst gekeken: ${time(s.at)}.` : 'Nieuwe betaalde orders worden gezien.' });

        const loginBroken = /Exact refused the login/.test(health.exact.error || '') || !fs.existsSync(exact.tokenPath);
        list.push(loginBroken
            ? { id: 'exact', level: 'bad', label: 'Boekhouding (Exact) — niet gekoppeld', detail: 'Koppel Exact opnieuw.' }
            : { id: 'exact', level: health.exact.ok === false ? 'warn' : 'ok', label: 'Boekhouding (Exact) — verbonden', detail: `Administratie ${exact.division}.` });

        let folderOk = true;
        try {
            fs.mkdirSync(invoiceSettings.pdfDir, { recursive: true });
            fs.accessSync(invoiceSettings.pdfDir, fs.constants.W_OK);
        } catch {
            folderOk = false;
        }
        list.push(folderOk
            ? { id: 'folder', level: 'ok', label: 'Map met facturen — in orde', detail: `Nieuwe PDF's komen in de map ${invoiceSettings.pdfDir === '/facturen' ? 'facturen' : invoiceSettings.pdfDir}.` }
            : { id: 'folder', level: 'bad', label: 'Map met facturen — kan niet schrijven', detail: 'Geef de app schrijfrechten op de map facturen (zie de handleiding).' });

        const tunnel = String(env.COMPOSE_PROFILES || '').split(',').map((p) => p.trim());
        if (tunnel.includes('ngrok') || tunnel.includes('cloudflare')) {
            list.push({ id: 'reach', level: 'ok', label: 'Factuurknop in de webshop — vast adres', detail: env.NGROK_DOMAIN ? `Bereikbaar via ${env.NGROK_DOMAIN}.` : 'Via een vaste tunnel.' });
        } else if (tunnel.includes('quick')) {
            list.push({ id: 'reach', level: 'warn', label: 'Factuurknop in de webshop — werkt, maar tijdelijk', detail: 'Het internetadres verandert als de NAS herstart. Dan werkt de knop niet tot het adres in de extensies is aangepast.' });
        } else {
            list.push({ id: 'reach', level: 'warn', label: 'Factuurknop in de webshop — niet bereikbaar', detail: 'Er is geen tunnel gekozen. Facturen worden wel gemaakt.' });
        }
        return list;
    }

    function todo() {
        const items = [];
        for (const [orderId, retry] of Object.entries(retries())) {
            const fix = howToFix(retry.error);
            items.push({
                id: `retry-${orderId}`,
                level: 'bad',
                title: `Order ${retry.name} heeft (nog) geen factuur`,
                why: `Waarom: ${reasonInDutch(retry.error)}`,
                how: fix.how,
                action: fix.action || { id: 'retry', label: 'Opnieuw proberen', body: { orderId } },
                attempts: retry.attempts,
            });
        }
        for (const job of pdfPending().filter((j) => j.attempts >= 3)) {
            items.push({
                id: `pdf-${job.number}`,
                level: 'warn',
                title: `PDF van ${job.number} (${job.orderName}) staat nog niet op de NAS`,
                why: 'Exact heeft de PDF nog niet klaar, of de map is niet bereikbaar.',
                how: 'De app probeert het vanzelf opnieuw. Blijft het hangen, kijk dan in het logboek.',
            });
        }
        return items;
    }

    // TEST or LIVE, per part, for the panel (tab header, tab Algemeen)
    function testLive() {
        const store = env.SHOPIFY_STORE_DOMAIN || '';
        return [
            exact.testOrdersOnly
                ? { id: 'facturen', label: 'Facturen', mode: 'test', text: 'Alleen testorders krijgen een factuur.', settings: true }
                : { id: 'facturen', label: 'Facturen', mode: 'live', text: 'Alle betaalde orders krijgen een factuur.', settings: true },
            { id: 'webshop', label: 'Webshop', mode: store === TEST_STORE ? 'test' : 'live', text: store === TEST_STORE ? `De testwinkel ${store}.` : store || 'Nog niet ingesteld.' },
            { id: 'exact', label: 'Boekhouding (Exact)', mode: String(exact.division) === TEST_DIVISION ? 'test' : 'live', text: String(exact.division) === TEST_DIVISION ? `De testkopie van de administratie (${exact.division}).` : `Administratie ${exact.division}.`, settings: true },
        ];
    }

    // The connections shown under Instellingen
    function connections(list) {
        const exactCheck = list.find((c) => c.id === 'exact');
        const exactMode = String(exact.division) === TEST_DIVISION ? 'test' : 'live';
        return [
            {
                id: 'exact',
                title: 'Boekhouding (Exact Online)',
                mode: exactMode,
                level: exactCheck.level,
                state: exactCheck.level === 'bad' ? 'niet gekoppeld' : 'verbonden',
                text: `Administratie ${exact.division}${exactMode === 'test' ? ', een kopie om te testen; de echte boekhouding wordt niet aangeraakt' : ''}.`,
                note: 'Opnieuw koppelen is alleen nodig als het Overzicht zegt dat Exact niet meer gekoppeld is, of als iemand anders voortaan de facturen in Exact maakt.',
                action: { id: 'exact-connect', label: 'Exact opnieuw koppelen' },
            },
            { id: 'webshop', title: 'Webshop (Shopify)', mode: (env.SHOPIFY_STORE_DOMAIN || '') === TEST_STORE ? 'test' : 'live', level: list.find((c) => c.id === 'shopify').level, state: 'verbonden', text: `Winkel ${env.SHOPIFY_STORE_DOMAIN || '(niet ingesteld)'}. De webshop is voor alle apps dezelfde en stel je in bij Algemeen.`, general: true },
        ];
    }

    return {
        name: 'Facturen',
        enabledKey: 'INVOICE_ENABLED',
        allowedKeys: ALLOWED_KEYS,

        async status() {
            const list = checks();
            const items = todo();
            const parts = testLive();
            const worst = [...list, ...items].some((x) => x.level === 'bad') ? 'bad' : [...list, ...items].some((x) => x.level === 'warn') ? 'warn' : 'ok';
            const summary = !enabled()
                ? 'Facturen maken staat uit.'
                : items.length
                  ? `Facturen worden gemaakt. ${items.length} ${items.length === 1 ? 'punt heeft' : 'punten hebben'} aandacht nodig.`
                  : worst === 'ok' ? 'Alles loopt. Betaalde orders krijgen hun factuur.' : 'Facturen worden gemaakt, maar let op de punten hieronder.';
            return {
                app: 'facturen',
                name: 'Facturen',
                enabled: enabled(),
                level: enabled() ? worst : 'warn',
                summary,
                detail: `${health.lastRound ? `Laatst gecontroleerd: ${time(health.lastRound)}. ` : ''}De app kijkt elke ${exact.pollMinutes} minuten of er betaalde orders zijn.`,
                mode: exact.testOrdersOnly ? 'alleen testorders' : 'alle betaalde orders',
                onoff: { label: 'Facturen maken', on: exact.testOrdersOnly ? 'Aan · alleen voor testorders' : 'Aan · voor alle betaalde orders', off: 'Uit · er worden geen facturen gemaakt', confirmOff: 'Er worden dan geen facturen meer gemaakt en gemaild. Orders die intussen betaald worden, krijgen hun factuur zodra je het weer aanzet.' },
                checks: list,
                todo: items,
                mode: parts[0].mode,
                modeText: parts[0].mode === 'test'
                    ? 'Facturen werkt nu als test. Alleen testorders krijgen een factuur. Echte klanten merken niets.'
                    : 'Facturen werkt live. Elke betaalde order krijgt een factuur.',
                testLive: parts,
                connections: connections(list),
                sharedKeys: SHARED_KEYS,
                shared: { shopDomain: env.SHOPIFY_STORE_DOMAIN || '', contactEmail: env.SELLER_EMAIL || '' },
                container: 'factuur-app',
            };
        },

        fields() {
            return FIELDS.map((field) => {
                const raw = env[field.key];
                const value = raw === undefined || raw === '' ? field.fallback ?? '' : raw;
                return field.type === 'secret'
                    ? { ...field, value: null, isSet: Boolean(raw) }
                    : { ...field, value };
            });
        },

        validate(values) {
            const problems = [];
            for (const [key, value] of Object.entries(values)) {
                const field = FIELDS.find((f) => f.key === key) || (key === 'INVOICE_ENABLED' ? { type: 'bool', label: key } : null);
                if (!field) {
                    problems.push(`${key} kan hier niet worden aangepast.`);
                    continue;
                }
                const text = String(value);
                if (field.type === 'bool' && !TRUE_FALSE.includes(text)) problems.push(`${field.label}: kies aan of uit.`);
                if (field.type === 'number' && !(Number(text) >= 1)) problems.push(`${field.label}: vul een getal van minstens 1 in.`);
                if (field.type === 'email' && text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) problems.push(`${field.label}: dit is geen geldig e-mailadres.`);
                if (field.type === 'date' && text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) problems.push(`${field.label}: kies een datum.`);
                if (key === 'SHOPIFY_STORE_DOMAIN' && !isValidStoreDomain(text)) problems.push('Webshop: het adres moet eindigen op .myshopify.com.');
                if (key === 'SHOPIFY_CLIENT_ID' && text && !/^[a-f0-9]{32}$/i.test(text)) problems.push('Client ID: dat lijkt geen Shopify client ID (32 tekens).');
                if (field.type === 'secret' && text && text.length < 16) problems.push(`${field.label}: te kort.`);
            }
            return problems;
        },

        actions: {
            // Can this app read that Shopify store? Read-only, nothing is saved.
            async 'shopify-test'({ domain }) {
                return checkShopifyStore({ storeDomain: String(domain || '').trim().toLowerCase(), clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET }, fetchFn);
            },

            // Try a failing order again in the next round (now)
            async retry({ orderId }) {
                if (!/^\d{1,20}$/.test(String(orderId || ''))) throw badRequest('Onbekende order');
                const all = retries();
                if (!all[orderId]) throw badRequest('Deze order staat niet (meer) op de lijst');
                all[orderId].nextTry = 0;
                all[orderId].updatedAt = null;
                store.setSetting('exact_retry', JSON.stringify(all));
                runNow();
                return { ok: true, message: 'Wordt nu opnieuw geprobeerd.' };
            },

            // Step 1 of connecting Exact again: the address to log in
            async 'exact-connect'() {
                return {
                    ok: true,
                    url: authorizeUrl(exact),
                    message: 'Open dit adres, log in bij Exact en klik op Toestaan. Je komt daarna op een pagina die niet laadt: kopieer dat hele adres en plak het hieronder.',
                };
            },

            // Step 2: the address from the browser after logging in
            async 'exact-code'({ url }) {
                const code = codeFromInput(String(url || '').slice(0, 4000));
                if (!code) throw badRequest('In dit adres staat geen code. Kopieer het hele adres uit de adresbalk.');
                await withExactLock(exact, () => exchangeCode(exact, code), { waitMs: 60_000 });
                const [me] = await get(exact, '/api/v1/current/Me?$select=FullName');
                console.log('Exact connected again from the admin panel');
                runNow();
                return { ok: true, message: `Gekoppeld als ${me?.FullName || 'onbekend'}.` };
            },
        },
    };
}

function time(iso) {
    return new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
