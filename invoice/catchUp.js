import { dutchDate } from './money.js';
import { processOrder } from './processOrder.js';
import { sendQueuedEmails } from '../email/emailQueue.js';

// The catch-up: asks Shopify which orders changed recently and makes every invoice and credit note that is
// still missing. Runs when the app starts and then every hour, so after a power cut, an internet problem
// or a broken computer everything fixes itself.
//
// - It never goes back further than the first day the app was used (or INVOICE_START_DATE), so old orders
//   from before the app never get an invoice by accident.
// - It looks back one extra day for safety. Orders that already have an invoice are skipped.
// - It also retries e-mails and invoice numbers that could not be sent or saved before.

const ONE_DAY = 24 * 60 * 60 * 1000;

export async function runCatchUp({ store, seller, settings, fetchOrdersSince, saveNumbers, sendEmail, startDate, now = new Date(), log = () => {} }) {
    const firstDay = startDate || store.getSetting('first_used');
    const lastRun = store.getSetting('last_catch_up');

    let since = lastRun ? new Date(new Date(lastRun).getTime() - ONE_DAY) : new Date(`${firstDay}T00:00:00Z`);
    const earliest = new Date(`${firstDay}T00:00:00Z`);
    if (since < earliest) since = earliest;

    const summary = { checked: 0, invoices: 0, creditNotes: 0, numbersSaved: 0, emailsSent: 0, skippedOld: 0, errors: [] };
    const orders = await fetchOrdersSince(since.toISOString());

    for (const order of orders) {
        // Orders placed before the app was used are none of its business
        if (dutchDate(new Date(order.created_at)) < firstDay) {
            summary.skippedOld++;
            continue;
        }
        summary.checked++;
        try {
            const result = await processOrder(order, { store, seller, settings, saveNumbers, sendEmail });
            if (result.invoiceCreated) {
                summary.invoices++;
                log(`Catch-up: invoice ${result.invoice.number} made for order ${order.name}`);
            }
            for (const creditNote of result.creditNotes.filter((c) => c.created)) {
                summary.creditNotes++;
                log(`Catch-up: credit note ${creditNote.creditNote.number} made for order ${order.name}`);
            }
            if (result.numbersSaved) summary.numbersSaved++;
            summary.emailsSent += result.emailsSent;
            summary.errors.push(...result.emailErrors);
            if (result.numbersError) summary.errors.push(`${order.name}: numbers not saved in Shopify yet (${result.numbersError})`);
        } catch (error) {
            summary.errors.push(`${order.name}: ${error.message}`);
            summary.orderFailed = true;
        }
    }

    // E-mails that could not be sent earlier (e.g. the mail server was down)
    if (settings.email?.enabled) {
        const emails = await sendQueuedEmails({ store, seller, settings, send: sendEmail });
        summary.emailsSent += emails.sent;
        summary.errors.push(...emails.errors);
    }

    // Invoice numbers that could not be saved in Shopify earlier (e.g. Shopify was unreachable)
    for (const orderId of store.ordersWithPendingNumbers()) {
        try {
            await saveNumbers(orderId);
            store.clearNumbersPending(orderId);
            summary.numbersSaved++;
        } catch (error) {
            summary.errors.push(`order ${orderId}: numbers not saved in Shopify yet (${error.message})`);
        }
    }

    // Only remember this run when every order worked. Otherwise the next run checks the same period again.
    // (If Shopify could not be read at all, fetchOrdersSince throws and nothing is remembered either.)
    if (!summary.orderFailed) store.setSetting('last_catch_up', now.toISOString());
    return summary;
}
