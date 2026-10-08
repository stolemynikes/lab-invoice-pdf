import express from 'express';

import { PORT, PUBLIC_URL, seller, shopify, invoiceSettings, checkSellerDetails } from './config.js';
import { InvoiceStore } from './invoice/invoiceStore.js';
import { runCatchUp } from './invoice/catchUp.js';
import { fetchOrdersUpdatedSince } from './shopify/shopifyClient.js';
import { saveDocumentNumbers } from './shopify/documentNumbers.js';
import { createMailer } from './email/mailer.js';

//routes import
import { webhooksRoute } from './routes/webhooksRoute.js';
import { invoicesRoute } from './routes/invoicesRoute.js';
import { apiRoute } from './routes/apiRoute.js';
import { isValidSeries } from './invoice/documentNumber.js';

//check the settings before starting
const problems = checkSellerDetails(seller);
if (invoiceSettings.linkSecret.length < 32) problems.push('INVOICE_LINK_SECRET must be a long random text (at least 32 characters)');
if (!shopify.clientSecret) problems.push('SHOPIFY_CLIENT_SECRET is not filled in');
if (!shopify.clientId || !shopify.storeDomain) problems.push('SHOPIFY_CLIENT_ID and SHOPIFY_STORE_DOMAIN must be filled in');
if (!isValidSeries(invoiceSettings.series) || !isValidSeries(invoiceSettings.creditSeries)) {
    problems.push('INVOICE_SERIES and CREDIT_NOTE_SERIES may only contain capitals, digits and dashes (e.g. INV, CN)');
}
if (invoiceSettings.email.enabled) {
    const email = invoiceSettings.email;
    if (!email.host || !email.user || !email.password || !email.from) {
        problems.push('EMAIL_ENABLED=true, but SMTP_HOST, SMTP_USER, SMTP_PASSWORD or EMAIL_FROM is missing');
    }
}
if (!PUBLIC_URL.startsWith('https://') && !PUBLIC_URL.startsWith('http://localhost')) {
    problems.push('PUBLIC_URL must start with https:// (download links must always be encrypted)');
}
if (problems.length > 0) {
    console.log('Please fix these settings in your .env file first:');
    problems.forEach((problem) => console.log(`  - ${problem}`));
    process.exit(1);
}

const store = new InvoiceStore(invoiceSettings.databasePath);
const mailer = createMailer(invoiceSettings.email);
const app = express();
// Behind Cloudflare Tunnel or another proxy: use the visitor's real IP address for the rate limit
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Protection headers on every answer: no framing, no guessing file types, no passing on of links,
// only HTTPS, and nothing is loaded from anywhere (the app only sends JSON and PDFs)
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Strict-Transport-Security': 'max-age=31536000',
        'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    next();
});

//HTTPS ROUTES

app.get('/', (req, res) => {
    return res.status(200).send('Invoice generator is running');
});

app.use('/webhooks', webhooksRoute(store, { mailer }));
app.use('/invoices', invoicesRoute(store));
app.use('/api', apiRoute(store));

// Unknown addresses: a plain "not found", nothing more
app.use((req, res) => res.status(404).send({ message: 'Not found' }));

// Errors: log the details for us, but never show them to the visitor
app.use((error, req, res, next) => {
    console.log(`Error on ${req.method} ${req.path}:`, error.message);
    if (res.headersSent) return next(error);
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    return res.status(status).send({ message: status === 500 ? 'Something went wrong' : 'Request not accepted' });
});

app.listen(PORT, () => {
    console.log(`App is listening to port ${PORT}`);
    console.log(`Invoices are saved in ${invoiceSettings.pdfDir}`);
    startCatchUp();
});

//catch-up: right after starting, and then every hour (CATCH_UP_MINUTES)
function startCatchUp() {
    let running = false;
    const run = async () => {
        if (running) return; // the previous round is still busy
        running = true;
        try {
            const summary = await runCatchUp({
                store,
                seller,
                settings: invoiceSettings,
                startDate: invoiceSettings.startDate,
                fetchOrdersSince: (since) => fetchOrdersUpdatedSince(shopify, since),
                saveNumbers: (orderId) => saveDocumentNumbers(shopify, store, orderId),
                sendEmail: mailer?.send,
                log: console.log,
            });
            if (summary.invoices || summary.creditNotes || summary.emailsSent || summary.errors.length) {
                console.log(`Catch-up done: ${summary.invoices} invoice(s), ${summary.creditNotes} credit note(s) made, ${summary.emailsSent} e-mail(s) sent`);
                summary.errors.forEach((error) => console.log(`  ⚠ ${error}`));
            }
        } catch (error) {
            console.log('Catch-up could not reach Shopify, will try again next round:', error.message);
        } finally {
            running = false;
        }
    };
    run();
    setInterval(run, invoiceSettings.catchUpMinutes * 60 * 1000);
}
