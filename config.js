import fs from 'node:fs';

// Load settings from the .env file (if it exists)
if (fs.existsSync('.env')) {
    process.loadEnvFile('.env');
}

const env = (name, fallback = '') => (process.env[name] || fallback).trim();

export const PORT = Number(env('PORT', '8080'));
export const PUBLIC_URL = env('PUBLIC_URL', `http://localhost:${PORT}`);

// Your company details, printed on every invoice
export const seller = {
    legalName: env('SELLER_LEGAL_NAME'),
    tradeName: env('SELLER_TRADE_NAME'),
    registeredSeat: env('SELLER_REGISTERED_SEAT'),
    addressLines: [env('SELLER_ADDRESS_LINE1'), env('SELLER_ADDRESS_LINE2')].filter(Boolean),
    countryCode: env('SELLER_COUNTRY', 'NL'),
    kvkNumber: env('SELLER_KVK'),
    vatId: env('SELLER_VAT_ID').replace(/\s/g, ''),
    iban: env('SELLER_IBAN'),
    bic: env('SELLER_BIC'),
    email: env('SELLER_EMAIL'),
    phone: env('SELLER_PHONE'),
    website: env('SELLER_WEBSITE'),
};

export const shopify = {
    storeDomain: env('SHOPIFY_STORE_DOMAIN'),
    clientId: env('SHOPIFY_CLIENT_ID'),
    clientSecret: env('SHOPIFY_CLIENT_SECRET'),
};

// Exact Online: the app registered under Import/Export > App-registraties.
// The login (refresh token) is saved in tokenPath after `npm run exact-connect`; keep that file private.
export const exact = {
    clientId: env('EXACT_CLIENT_ID'),
    clientSecret: env('EXACT_CLIENT_SECRET'),
    redirectUri: env('EXACT_REDIRECT_URI', 'https://facturen.laboratoriumdiscounter.nl/exact/callback'),
    baseUrl: env('EXACT_BASE_URL', 'https://start.exactonline.nl'),
    division: env('EXACT_DIVISION'),
    // Administrations the app may create or change things in, comma separated. Empty = read only everywhere.
    writeDivisions: env('EXACT_WRITE_DIVISIONS').split(',').map((code) => code.trim()).filter(Boolean),
    tokenPath: env('EXACT_TOKEN_PATH', './data/exact-token.json'),
    // Invoices made by Exact (INVOICE_MODE=exact)
    journal: env('EXACT_JOURNAL', '70'),
    paymentCondition: env('EXACT_PAYMENT_CONDITION', 'WS'),
    shippingItem: env('EXACT_SHIPPING_ITEM', 'VERZENDING'),
    // Shopify products that are not in Exact yet are made as new articles (with CAS, UN number etc.)
    createItems: env('EXACT_CREATE_ITEMS', 'true') === 'true',
    sendEmail: env('EXACT_SEND_EMAIL', 'true') === 'true',
    // Id of the e-mail text (Lay-outs, "Lay-out e-mailtekst"). Empty = the only one there is.
    emailLayout: env('EXACT_EMAIL_LAYOUT'),
    // Id of the e-mail text for credit notes. Empty = the same text as invoices.
    creditEmailLayout: env('EXACT_CREDIT_EMAIL_LAYOUT'),
    // Id of the invoice PDF layout (Lay-outs, type Verkoopfactuur). Empty = Exact's default.
    invoiceLayout: env('EXACT_INVOICE_LAYOUT'),
    // Sender of the invoice e-mails. Empty = the Exact user who connected the app.
    senderEmail: env('EXACT_SENDER_EMAIL'),
    // Safety while testing: only Shopify test orders go to Exact
    testOrdersOnly: env('EXACT_TEST_ORDERS_ONLY', 'true') === 'true',
    pollMinutes: Number(env('EXACT_POLL_MINUTES', '2')),
};

// "app": the app makes its own PDF invoices (INV-2026-1). "exact": Exact Online makes and e-mails the invoices.
export const INVOICE_MODE = env('INVOICE_MODE', 'app');

export const invoiceSettings = {
    pdfDir: env('INVOICE_PDF_DIR', './data/invoices'),
    databasePath: env('DATABASE_PATH', './data/invoices.db'),
    series: env('INVOICE_SERIES', 'INV'),
    creditSeries: env('CREDIT_NOTE_SERIES', 'CN'),
    linkSecret: env('INVOICE_LINK_SECRET'),
    viesEnabled: env('VIES_ENABLED', 'true') === 'true',
    // Catch-up: orders from before this date never get an invoice (empty = the first day the app was used)
    startDate: env('INVOICE_START_DATE'),
    catchUpMinutes: Number(env('CATCH_UP_MINUTES', '60')),
    // E-mail with every invoice and credit note (SMTP, e.g. Hostnet)
    email: {
        enabled: env('EMAIL_ENABLED', 'false') === 'true',
        host: env('SMTP_HOST'),
        port: Number(env('SMTP_PORT', '587')),
        user: env('SMTP_USER'),
        password: env('SMTP_PASSWORD'),
        from: env('EMAIL_FROM'),
        replyTo: env('EMAIL_REPLY_TO'),
        bcc: env('EMAIL_BCC'),
        language: env('EMAIL_LANGUAGE', 'en'),
    },
    // Look of the PDF (pick a design with: npm run designs)
    brand: {
        logo: env('BRAND_LOGO', './assets/logo.png'),
        // Shop name written next to the logo icon in the website font (leave empty when the logo file already contains the name)
        logoText: env('BRAND_LOGO_TEXT'),
        color: env('BRAND_COLOR', '#1e4475'),
        design: {
            header: env('DESIGN_HEADER', 'classic'),
            table: env('DESIGN_TABLE', 'lines'),
            total: env('DESIGN_TOTAL', 'line'),
            accent: env('DESIGN_ACCENT', 'none'),
        },
    },
};

// Returns a list of problems with the company details (empty list = all good)
export function checkSellerDetails(details = seller) {
    const problems = [];
    const required = {
        legalName: 'SELLER_LEGAL_NAME',
        registeredSeat: 'SELLER_REGISTERED_SEAT',
        kvkNumber: 'SELLER_KVK',
        vatId: 'SELLER_VAT_ID',
    };
    for (const [field, name] of Object.entries(required)) {
        if (!details[field] || details[field].startsWith('TODO')) problems.push(`${name} is not filled in`);
    }
    if (details.addressLines.length === 0 || details.addressLines.some((line) => line.startsWith('TODO'))) {
        problems.push('SELLER_ADDRESS_LINE1 / SELLER_ADDRESS_LINE2 are not filled in');
    }
    if (details.legalName && !/B\.?V\.?$/i.test(details.legalName)) {
        problems.push('SELLER_LEGAL_NAME should be the full legal name including "B.V."');
    }
    return problems;
}
