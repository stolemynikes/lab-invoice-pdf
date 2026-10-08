import express from 'express';
import { seller, shopify, invoiceSettings, PUBLIC_URL } from '../config.js';
import { isValidWebhook, saveInvoiceLinkOnOrder } from '../shopify/shopifyClient.js';
import { createInvoiceForOrder } from '../invoice/createInvoice.js';
import { downloadUrl } from '../invoice/downloadLinks.js';

export function webhooksRoute(store) {
    const router = express.Router();

    // Shopify calls this when an order is paid (webhook topic: orders/paid)
    // We need the raw body to check Shopify's signature
    router.post('/orders-paid', express.raw({ type: 'application/json' }), (req, res) => {
        if (!isValidWebhook(req.body, req.get('X-Shopify-Hmac-Sha256'), shopify.clientSecret)) {
            return res.status(401).send({ message: 'Invalid webhook signature' });
        }

        // Answer Shopify right away (it expects a reply within 5 seconds), then make the invoice
        res.status(200).send({ received: true });

        const order = JSON.parse(req.body.toString('utf8'));
        handlePaidOrder(order, store).catch((error) => {
            console.log(`Invoice for order ${order.name} failed:`, error.message);
        });
    });

    return router;
}

async function handlePaidOrder(order, store) {
    const { invoice, created } = await createInvoiceForOrder(order, { store, seller, settings: invoiceSettings });
    if (!created) return;

    console.log(`Invoice ${invoice.number} created for order ${order.name}`);
    for (const warning of invoice.warnings) {
        console.log(`  ⚠ ${warning}`);
    }

    // Put the download link on the order in Shopify
    if (shopify.storeDomain && shopify.clientId && shopify.clientSecret) {
        const url = downloadUrl(PUBLIC_URL, invoice.number, invoiceSettings.linkSecret);
        await saveInvoiceLinkOnOrder(shopify, order.id, url, invoice.number);
    }
}
