// The public address of the invoice app (the same as PUBLIC_URL in its .env), without a slash at the end.
// CHANGE THIS before running `shopify app deploy`.
export const APP_URL = 'https://facturen.example.nl';

// Asks the invoice app for the documents of the logged-in customer.
// The session token proves to the app who is logged in; the app only sends back that customer's own documents,
// with download links that work for a few minutes.
export async function fetchDocuments(orderId) {
    const token = await shopify.sessionToken.get();
    const query = orderId ? `?order=${encodeURIComponent(orderId)}` : '';
    const response = await fetch(`${APP_URL}/api/documents${query}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    // 401 = nobody is logged in (e.g. a guest on the order page): the caller then shows nothing
    if (!response.ok) throw Object.assign(new Error(`Invoice app answered ${response.status}`), { status: response.status });
    return response.json();
}
