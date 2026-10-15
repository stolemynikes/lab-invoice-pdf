import { dutchDate } from '../invoice/money.js';
import { invoiceOrderInExact, isPaid } from './exactInvoice.js';
import { creditRefundsInExact } from './exactCredit.js';
import { saveExactPdf } from './exactPdf.js';

// Asks Shopify every few minutes which orders changed, and makes the Exact invoice (and credit notes) for every
// paid order that still needs one. Works without a public address (no webhooks needed), so it also runs on a PC.
//
// Kept light on purpose, because Exact allows only a limited number of API calls per minute and per day:
// - An order that is finished (invoice and all credit notes in Exact) is remembered with its Shopify
//   "updated_at". It is only looked at again when it changes in Shopify (e.g. a new refund).
// - An order that fails (missing article, VAT code...) goes on a retry list and is tried again later and later
//   (2, 4, 8... up to 60 minutes), or right away when the order changes in Shopify.
// - The look-back moves on every round; failing orders are kept on the retry list, not by looking back further.

const LOOK_BACK_MS = 10 * 60 * 1000;
const MAX_WAIT_MINUTES = 60;

export async function runExactCatchUp({ store, settings, seller, invoiceSettings, fetchOrdersSince, fetchOrderById = null, fetchProduct = null, now = new Date(), log = () => {} }) {
    const firstDay = invoiceSettings.startDate || store.getSetting('first_used');
    const lastRun = store.getSetting('last_exact_catch_up');

    let since = lastRun ? new Date(new Date(lastRun).getTime() - LOOK_BACK_MS) : new Date(`${firstDay}T00:00:00Z`);
    const earliest = new Date(`${firstDay}T00:00:00Z`);
    if (since < earliest) since = earliest;

    const summary = { invoiced: [], errors: [] };
    const orders = await fetchOrdersSince(since.toISOString());
    const retries = readRetries(store);
    const pdfs = readJson(store, 'exact_pdf_pending', []);

    // Failing orders whose next try is due, also when they did not change in Shopify
    for (const [orderId, retry] of Object.entries(retries)) {
        if (retry.nextTry > now.getTime() || orders.some((order) => String(order.id) === orderId) || !fetchOrderById) continue;
        const order = await fetchOrderById(orderId);
        if (order) orders.push(order);
        else delete retries[orderId];
    }

    const cache = {};
    for (const order of orders) {
        if (!isPaid(order) || dutchDate(new Date(order.created_at)) < firstDay) continue;
        if (settings.testOrdersOnly && !order.test) continue; // costs no Exact calls; never marked as done

        const orderId = String(order.id);
        const doneKey = `exact_done:${orderId}`;
        if (store.getSetting(doneKey) === order.updated_at) continue; // finished and not changed since

        const retry = retries[orderId];
        if (retry && retry.nextTry > now.getTime() && retry.updatedAt === order.updated_at) continue; // still waiting

        try {
            const result = await invoiceOrderInExact(order, { settings, seller, invoiceSettings, fetchProduct, cache, log });
            if (result.status === 'invoiced') {
                summary.invoiced.push(`${order.name} -> ${result.number}`);
                log(`Exact: invoice ${result.number} for ${order.name}${result.emailed ? ', e-mailed by Exact' : ''}`);
                pdfs.push(pdfJob(order, 'invoice', result, now));
            }
            // Refunds: a credit note per refund, once the invoice is there
            const { credits, done } = await creditRefundsInExact(order, { settings, seller, invoiceSettings, cache, log });
            for (const credit of credits) {
                summary.invoiced.push(`${order.name} refund -> ${credit.number}`);
                log(`Exact: credit note ${credit.number} for ${order.name} (invoice ${credit.invoiceNumber})${settings.sendEmail ? ', e-mailed by Exact' : ''}`);
                pdfs.push(pdfJob(order, 'credit', credit, now));
            }
            if (done && ['invoiced', 'already invoiced'].includes(result.status)) store.setSetting(doneKey, order.updated_at);
            delete retries[orderId];
        } catch (error) {
            const attempts = (retry?.attempts || 0) + 1;
            const waitMinutes = Math.min(MAX_WAIT_MINUTES, 2 ** attempts);
            retries[orderId] = { name: order.name, attempts, nextTry: now.getTime() + waitMinutes * 60 * 1000, updatedAt: order.updated_at, error: error.message };
            summary.errors.push(`${order.name}: ${error.message} (next try in ${waitMinutes} min)`);
        }
    }

    // PDF copies on the NAS. Exact sometimes needs a moment before the PDF is there, so failures wait and retry.
    if (settings.savePdf) {
        for (const job of [...pdfs]) {
            if (job.nextTry > now.getTime()) continue;
            try {
                const file = await saveExactPdf(settings, invoiceSettings.pdfDir, job);
                pdfs.splice(pdfs.indexOf(job), 1);
                log(`Exact: PDF saved: ${file}`);
            } catch (error) {
                job.attempts += 1;
                job.nextTry = now.getTime() + Math.min(MAX_WAIT_MINUTES, 2 ** job.attempts) * 60 * 1000;
                if (job.attempts >= MAX_PDF_ATTEMPTS) {
                    pdfs.splice(pdfs.indexOf(job), 1);
                    summary.errors.push(`PDF of ${job.number} (${job.orderName}) not saved on the NAS, gave up: ${error.message}`);
                } else if (job.attempts === 1 || job.attempts % 5 === 0) {
                    summary.errors.push(`PDF of ${job.number} (${job.orderName}) not saved yet: ${error.message}`);
                }
            }
        }
    }

    store.setSetting('exact_pdf_pending', JSON.stringify(settings.savePdf ? pdfs : []));
    store.setSetting('exact_retry', JSON.stringify(retries));
    store.setSetting('last_exact_catch_up', now.toISOString());
    return summary;
}

const MAX_PDF_ATTEMPTS = 30;

// A PDF to fetch from Exact: invoice or credit note, with what the file name needs
function pdfJob(order, kind, document, now) {
    const address = order.billing_address || order.shipping_address || {};
    const customerName = address.company || [address.first_name, address.last_name].filter(Boolean).join(' ') || address.name || '';
    return { kind, number: document.number, orderName: order.name, customerName, date: document.date, attempts: 0, nextTry: now.getTime() };
}

function readJson(store, key, fallback) {
    try {
        return JSON.parse(store.getSetting(key) || 'null') ?? fallback;
    } catch {
        return fallback;
    }
}

const readRetries = (store) => readJson(store, 'exact_retry', {});
