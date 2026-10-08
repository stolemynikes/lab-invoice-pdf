import express from 'express';
import { seller, shopify, invoiceSettings } from '../config.js';
import { isValidWebhook, fetchOrderById } from '../shopify/shopifyClient.js';
import { saveDocumentNumbers } from '../shopify/documentNumbers.js';
import { processOrder } from '../invoice/processOrder.js';
import { rateLimit } from './rateLimit.js';

export function webhooksRoute(store, { mailer = null } = {}) {
    const router = express.Router();
    // Shopify sends at most a few webhooks per order; this only stops floods of fake ones
    router.use(rateLimit({ max: 300 }));

    // Shopify calls this when an order is paid (webhook topic: orders/paid)
    router.post('/orders-paid', readRawBody, (req, res) => {
        const order = readWebhook(req, res);
        if (!order) return;

        handlePaidOrder(order, store, mailer).catch((error) => {
            console.log(`Invoice for order ${order.name} failed:`, error.message);
        });
    });

    // Shopify calls this when (part of) an order is refunded (webhook topic: refunds/create)
    router.post('/refunds-create', readRawBody, (req, res) => {
        const refund = readWebhook(req, res);
        if (!refund) return;

        handleRefund(refund, store, mailer).catch((error) => {
            console.log(`Credit note for refund ${refund.id} failed:`, error.message);
        });
    });

    return router;
}

// The raw message, needed to check Shopify's signature. Big orders can be large, but never more than 5 MB.
const readRawBody = express.raw({ type: 'application/json', limit: '5mb' });

// Checks Shopify's signature, answers Shopify right away (it expects a reply within 5 seconds)
// and returns the data. We need the raw body to check the signature.
function readWebhook(req, res) {
    if (!isValidWebhook(req.body, req.get('X-Shopify-Hmac-Sha256'), shopify.clientSecret)) {
        res.status(401).send({ message: 'Invalid webhook signature' });
        return null;
    }
    try {
        const data = JSON.parse(req.body.toString('utf8'));
        res.status(200).send({ received: true });
        return data;
    } catch {
        res.status(400).send({ message: 'Message is not valid JSON' });
        return null;
    }
}

async function handlePaidOrder(order, store, mailer) {
    report(order, await processOrder(order, { store, seller, settings: invoiceSettings, saveNumbers: numberSaver(store), sendEmail: mailer?.send }));
}

async function handleRefund(refund, store, mailer) {
    // The refund webhook does not contain the whole order, so get it from Shopify (it includes all refunds)
    const order = await fetchOrderById(shopify, refund.order_id);
    report(order, await processOrder(order, { store, seller, settings: invoiceSettings, saveNumbers: numberSaver(store), sendEmail: mailer?.send }));
}

// Saves the invoice numbers on the order in Shopify
function numberSaver(store) {
    return (orderId) => saveDocumentNumbers(shopify, store, orderId);
}

function report(order, result) {
    if (result.invoiceCreated) {
        console.log(`Invoice ${result.invoice.number} created for order ${order.name}`);
        logWarnings(result.invoice.warnings);
    }
    for (const { creditNote, created } of result.creditNotes) {
        if (!created) continue;
        console.log(`Credit note ${creditNote.number} created for order ${order.name}`);
        logWarnings(creditNote.warnings);
    }
    if (result.emailsSent) console.log(`  E-mailed ${result.emailsSent} document(s) to the customer`);
    result.emailErrors.forEach((error) => console.log(`  ${error} – the catch-up will try again`));
    if (result.numbersError) console.log(`  Links for ${order.name} not saved yet, the catch-up will try again: ${result.numbersError}`);
}

function logWarnings(warnings) {
    for (const warning of warnings) {
        console.log(`  ⚠ ${warning}`);
    }
}
