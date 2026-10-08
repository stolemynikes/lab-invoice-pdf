import express from 'express';

import { PORT, seller, shopify, invoiceSettings, checkSellerDetails } from './config.js';
import { InvoiceStore } from './invoice/invoiceStore.js';

//routes import
import { webhooksRoute } from './routes/webhooksRoute.js';
import { invoicesRoute } from './routes/invoicesRoute.js';

//check the settings before starting
const problems = checkSellerDetails(seller);
if (!invoiceSettings.linkSecret) problems.push('INVOICE_LINK_SECRET is not filled in');
if (!shopify.clientSecret) problems.push('SHOPIFY_CLIENT_SECRET is not filled in');
if (problems.length > 0) {
    console.log('Please fix these settings in your .env file first:');
    problems.forEach((problem) => console.log(`  - ${problem}`));
    process.exit(1);
}

const store = new InvoiceStore(invoiceSettings.databasePath);
const app = express();

//HTTPS ROUTES

app.get('/', (req, res) => {
    return res.status(200).send('Invoice generator is running');
});

app.use('/webhooks', webhooksRoute(store));
app.use('/invoices', invoicesRoute(store));

app.listen(PORT, () => {
    console.log(`App is listening to port ${PORT}`);
    console.log(`Invoices are saved in ${invoiceSettings.pdfDir}`);
});
