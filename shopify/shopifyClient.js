import crypto from 'node:crypto';

const API_VERSION = '2026-07';

// Checks that a webhook really comes from Shopify (signed with your app's client secret)
export function isValidWebhook(rawBody, hmacHeader, clientSecret) {
    if (!hmacHeader || !clientSecret || !Buffer.isBuffer(rawBody)) return false; // e.g. a message that is not JSON
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

// Saves the invoice and credit note numbers on the Shopify order (metafields invoice.number,
// invoice.issue_date and invoice.credit_notes). There are no download links in it on purpose:
// links are only handed out to the logged-in customer (routes/apiRoute.js).
// The numbers are a safety net: the restore script uses them if the local data is ever lost.
// An old permanent download link (invoice.download_url) is removed.
export async function saveDocumentNumbersOnOrder(settings, orderId, { invoiceNumber, issueDate, creditNotes }) {
    const ownerId = `gid://shopify/Order/${orderId}`;
    const data = await adminGraphql(
        settings,
        `mutation SaveInvoiceNumbers($metafields: [MetafieldsSetInput!]!, $old: [MetafieldIdentifierInput!]!) {
            metafieldsSet(metafields: $metafields) { userErrors { field message } }
            metafieldsDelete(metafields: $old) { userErrors { field message } }
        }`,
        {
            metafields: [
                { ownerId, namespace: 'invoice', key: 'number', type: 'single_line_text_field', value: invoiceNumber },
                { ownerId, namespace: 'invoice', key: 'issue_date', type: 'date', value: issueDate },
                { ownerId, namespace: 'invoice', key: 'credit_notes', type: 'json', value: JSON.stringify(creditNotes) },
            ],
            old: [{ ownerId, namespace: 'invoice', key: 'download_url' }],
        },
    );
    const errors = [...data.metafieldsSet.userErrors, ...(data.metafieldsDelete?.userErrors ?? [])];
    if (errors.length > 0) {
        throw new Error(`Could not save invoice numbers on order ${orderId}: ${JSON.stringify(errors)}`);
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

// Gets one order by its id, in the same format as the webhook sends it
export async function fetchOrderById(settings, orderId) {
    const body = await adminRest(settings, `orders/${orderId}.json`);
    return body.order;
}

// Gets all orders that changed since a moment (new orders, payments, refunds), page by page
export async function fetchOrdersUpdatedSince(settings, sinceIso) {
    const token = await getAccessToken(settings);
    const orders = [];
    let url = `https://${settings.storeDomain}/admin/api/${API_VERSION}/orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(sinceIso)}`;
    while (url) {
        const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        const body = await response.json();
        if (!response.ok) {
            throw new Error(`Shopify API error (${response.status}): ${JSON.stringify(body.errors || body)}`);
        }
        orders.push(...body.orders);
        // Shopify puts the address of the next page in the "Link" header
        url = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return orders;
}

// Gets the invoice and credit note numbers that are saved on the orders in Shopify (for the restore script)
export async function fetchDocumentNumbersFromShopify(settings) {
    const query = `
        query OrdersWithInvoices($cursor: String) {
            orders(first: 100, after: $cursor, sortKey: CREATED_AT) {
                pageInfo { hasNextPage endCursor }
                nodes {
                    legacyResourceId
                    name
                    invoiceNumber: metafield(namespace: "invoice", key: "number") { value }
                    issueDate: metafield(namespace: "invoice", key: "issue_date") { value }
                    creditNotes: metafield(namespace: "invoice", key: "credit_notes") { value }
                }
            }
        }`;
    const orders = [];
    let cursor = null;
    do {
        const data = await adminGraphql(settings, query, { cursor });
        for (const node of data.orders.nodes) {
            if (!node.invoiceNumber?.value) continue;
            orders.push({
                orderId: node.legacyResourceId,
                orderName: node.name,
                invoiceNumber: node.invoiceNumber.value,
                issueDate: node.issueDate?.value ?? null,
                creditNotes: parseJsonList(node.creditNotes?.value),
            });
        }
        cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    } while (cursor);
    return orders;
}

function parseJsonList(value) {
    try {
        const list = JSON.parse(value || '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

async function adminRest(settings, endpoint) {
    const token = await getAccessToken(settings);
    const response = await fetch(`https://${settings.storeDomain}/admin/api/${API_VERSION}/${endpoint}`, {
        headers: { 'X-Shopify-Access-Token': token },
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(`Shopify API error (${response.status}): ${JSON.stringify(body.errors || body)}`);
    }
    return body;
}

// Read-only check that the connection works: returns the shop name
export async function testConnection(settings) {
    const data = await adminGraphql(settings, '{ shop { name myshopifyDomain } }');
    return data.shop;
}
