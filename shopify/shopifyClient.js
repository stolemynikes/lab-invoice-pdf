import crypto from 'node:crypto';

const API_VERSION = '2026-07';

// Checks that a webhook really comes from Shopify (signed with your app's client secret)
export function isValidWebhook(rawBody, hmacHeader, clientSecret) {
    if (!hmacHeader || !clientSecret) return false;
    const expected = crypto.createHmac('sha256', clientSecret).update(rawBody).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(hmacHeader);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Access token for the Admin API.
// Dev Dashboard apps don't have a fixed token: we ask Shopify for one with the client ID + secret.
// The token works for about 24 hours, so we keep it and only ask for a new one when it runs out.
let cachedToken = null;

export async function getAccessToken({ storeDomain, clientId, clientSecret }, fetchFn = fetch) {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
        return cachedToken.value;
    }

    const response = await fetchFn(`https://${storeDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
        throw new Error(`Could not get a Shopify access token (${response.status}): ${body.error_description || body.error || 'unknown error'}`);
    }

    cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 86_399) * 1000 };
    return cachedToken.value;
}

// Sends a GraphQL request to the Shopify Admin API
async function adminGraphql(settings, query, variables) {
    const token = await getAccessToken(settings);
    const response = await fetch(`https://${settings.storeDomain}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (!response.ok || body.errors) {
        throw new Error(`Shopify API error (${response.status}): ${JSON.stringify(body.errors || body)}`);
    }
    return body.data;
}

// Saves the invoice download link on the Shopify order (metafield invoice.download_url),
// so it can be shown on the order page in the customer account and used in emails.
export async function saveInvoiceLinkOnOrder(settings, orderId, url, invoiceNumber) {
    const query = `
        mutation SetInvoiceLink($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors { field message }
            }
        }`;
    const ownerId = `gid://shopify/Order/${orderId}`;
    const data = await adminGraphql(settings, query, {
        metafields: [
            { ownerId, namespace: 'invoice', key: 'download_url', type: 'url', value: url },
            { ownerId, namespace: 'invoice', key: 'number', type: 'single_line_text_field', value: invoiceNumber },
        ],
    });
    const errors = data.metafieldsSet.userErrors;
    if (errors.length > 0) {
        throw new Error(`Could not save invoice link on order ${orderId}: ${JSON.stringify(errors)}`);
    }
}

// Gets one order by its name (e.g. "LD1004"), in the same format as the webhook sends it
export async function fetchOrderByName(settings, orderName) {
    const token = await getAccessToken(settings);
    const url = `https://${settings.storeDomain}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(orderName)}`;
    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(`Shopify API error (${response.status}): ${JSON.stringify(body.errors || body)}`);
    }
    return body.orders.find((order) => order.name === orderName) || null;
}

// Read-only check that the connection works: returns the shop name
export async function testConnection(settings) {
    const data = await adminGraphql(settings, '{ shop { name myshopifyDomain } }');
    return data.shop;
}
