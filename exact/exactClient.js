import fs from 'node:fs';
import path from 'node:path';

// Talks to the Exact Online REST API.
// Login works with OAuth: you log in once in the browser (with 2FA), after that the app keeps itself
// logged in with a refresh token. Exact gives a NEW refresh token every time it is used and the old one
// stops working, so the newest one is always saved straight away.

const TOKEN_URL = '/api/oauth2/token';

// The address to open in the browser for the one-time login
export function authorizeUrl(settings) {
    const url = new URL('/api/oauth2/auth', settings.baseUrl);
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', settings.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('force_login', '0');
    return url.toString();
}

// After the login Exact sends the browser to the redirect address with ?code=... behind it.
// Accepts the whole address from the address bar, or only the code.
export function codeFromInput(input) {
    const text = String(input || '').trim();
    if (text.startsWith('http')) return new URL(text).searchParams.get('code');
    return text ? decodeURIComponent(text) : null;
}

// Turns the one-time code into tokens and saves them
export async function exchangeCode(settings, code) {
    const token = await requestToken(settings, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: settings.redirectUri,
    });
    saveToken(settings, token);
}

// A valid access token; refreshes it (and saves the new refresh token) when it has expired.
// Exact limits how often a token may be refreshed, so a token that still works is always reused.
export async function getAccessToken(settings) {
    const saved = readToken(settings);
    if (!saved) throw new Error('Not connected to Exact yet. Run: npm run exact-connect');
    if (saved.accessToken && Date.now() < saved.expiresAt - 30_000) return saved.accessToken;

    const token = await requestToken(settings, { grant_type: 'refresh_token', refresh_token: saved.refreshToken });
    return saveToken(settings, token).accessToken;
}

// GET a REST endpoint, e.g. get(settings, '/api/v1/current/Me'). Follows the pages Exact splits long lists into.
export async function get(settings, endpoint) {
    const results = [];
    let url = new URL(endpoint, settings.baseUrl).toString();
    while (url) {
        const response = await (settings.fetch || fetch)(url, {
            headers: { Authorization: `Bearer ${await getAccessToken(settings)}`, Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`Exact answered ${response.status} on ${endpoint}: ${(await response.text()).slice(0, 300)}`);
        const { d } = await response.json();
        if (!Array.isArray(d?.results)) return d;
        results.push(...d.results);
        url = d.__next || null;
    }
    return results;
}

// POST (create) or PUT (change) in Exact. Only allowed in the administrations listed in
// EXACT_WRITE_DIVISIONS (empty = nowhere), so a mistake can never write in the real bookkeeping
// before the owner has said so.
export async function write(settings, method, endpoint, body) {
    if (!['POST', 'PUT'].includes(method)) throw new Error(`Not an allowed write: ${method}`);
    const division = endpoint.match(/^\/api\/v1\/(\d+)\//)?.[1];
    if (!division || !settings.writeDivisions?.includes(division)) {
        throw new Error(`Writing to Exact administration ${division ?? '?'} is not allowed (EXACT_WRITE_DIVISIONS)`);
    }
    const response = await (settings.fetch || fetch)(new URL(endpoint, settings.baseUrl), {
        method,
        headers: { Authorization: `Bearer ${await getAccessToken(settings)}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Exact refused ${method} ${endpoint.split('?')[0]} (${response.status}): ${(await response.text()).slice(0, 300)}`);
    // POST answers with the new record, PUT with nothing
    return response.status === 204 ? null : (await response.json()).d;
}

// A text value inside an OData filter, e.g. $filter=Email eq '<value>'.
// A quote is doubled, so a customer's input can never end the text and add its own filter.
export function odataText(value) {
    return encodeURIComponent(`'${String(value).replace(/'/g, "''")}'`);
}

async function requestToken(settings, fields) {
    if (!settings.clientId || !settings.clientSecret) throw new Error('EXACT_CLIENT_ID and EXACT_CLIENT_SECRET are not filled in in .env');
    const response = await fetch(new URL(TOKEN_URL, settings.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ ...fields, client_id: settings.clientId, client_secret: settings.clientSecret }),
    });
    // Never print the answer itself: on success it holds the tokens
    if (!response.ok) {
        const reason = await response.text().catch(() => '');
        throw new Error(`Exact refused the login (${response.status}). ${reason.includes('invalid_grant') ? 'The code or login has expired: run npm run exact-connect again.' : ''}`);
    }
    return response.json();
}

function readToken(settings) {
    if (!fs.existsSync(settings.tokenPath)) return null;
    return JSON.parse(fs.readFileSync(settings.tokenPath, 'utf8'));
}

function saveToken(settings, token) {
    const saved = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Number(token.expires_in || 600) * 1000,
        savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(settings.tokenPath), { recursive: true });
    // Write to a temporary file first, so a crash halfway never leaves a broken login behind.
    // Only readable for the owner of the file (on Linux / the NAS).
    const temp = `${settings.tokenPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    fs.renameSync(temp, settings.tokenPath);
    return saved;
}
