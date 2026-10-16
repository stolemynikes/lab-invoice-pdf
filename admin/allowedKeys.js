// The settings the NAS admin panel may change for this app (saved in data/settings.json, before .env)
export const ALLOWED_KEYS = [
    'INVOICE_ENABLED',
    'EXACT_TEST_ORDERS_ONLY',
    'EXACT_SEND_EMAIL',
    'EXACT_SAVE_PDF',
    'EXACT_CREATE_ITEMS',
    'EXACT_SENDER_EMAIL',
    'EXACT_POLL_MINUTES',
    'INVOICE_START_DATE',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    // Shared with the other apps, set in the panel tab Algemeen
    'SHOPIFY_STORE_DOMAIN',
    'SELLER_EMAIL',
];
