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

export const invoiceSettings = {
    pdfDir: env('INVOICE_PDF_DIR', './data/invoices'),
    databasePath: env('DATABASE_PATH', './data/invoices.db'),
    series: env('INVOICE_SERIES', 'INV'),
    linkSecret: env('INVOICE_LINK_SECRET'),
    viesEnabled: env('VIES_ENABLED', 'true') === 'true',
    // Look of the PDF (pick a design with: npm run designs)
    brand: {
        logo: env('BRAND_LOGO', './assets/logo.svg'),
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
