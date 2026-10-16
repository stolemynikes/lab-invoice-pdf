// For the NAS admin panel: can this app read a (new) Shopify store with its own client ID + secret?
// Read-only and without the token cache, so testing another store never touches the running app.
// The same file is used in every app the panel manages.

const API_VERSION = '2026-07';

export function isValidStoreDomain(domain) {
    return /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(String(domain || ''));
}

export async function checkShopifyStore({ storeDomain, clientId, clientSecret }, fetchFn = fetch) {
    if (!isValidStoreDomain(storeDomain)) return { ok: false, message: 'Dit is geen Shopify-adres. Het moet eindigen op .myshopify.com.' };
    if (!clientId || !clientSecret) return { ok: false, message: 'De Shopify-sleutels van deze app zijn niet ingevuld.' };
    try {
        const tokenResponse = await fetchFn(`https://${storeDomain}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
            signal: AbortSignal.timeout(10_000),
        });
        const token = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !token.access_token) {
            return { ok: false, message: 'Shopify geeft deze app geen toegang. Is de Shopify-app op deze webshop geïnstalleerd, en kloppen de sleutels?' };
        }
        const shopResponse = await fetchFn(`https://${storeDomain}/admin/api/${API_VERSION}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token.access_token },
            body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
            signal: AbortSignal.timeout(10_000),
        });
        const body = await shopResponse.json().catch(() => ({}));
        const shop = body?.data?.shop;
        if (!shopResponse.ok || !shop) return { ok: false, message: 'Shopify antwoordt, maar de winkel kon niet gelezen worden.' };
        return { ok: true, name: shop.name, domain: shop.myshopifyDomain, message: `Verbinding gelukt met ${shop.name}.` };
    } catch {
        return { ok: false, message: 'Geen antwoord van dit adres. Klopt het adres van de webshop?' };
    }
}
