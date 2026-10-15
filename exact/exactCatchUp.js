import { dutchDate } from '../invoice/money.js';
import { invoiceOrderInExact, isPaid } from './exactInvoice.js';
import { creditRefundsInExact } from './exactCredit.js';

// Asks Shopify every few minutes which orders changed, and makes the Exact invoice for every paid order
// that does not have one yet. Works without a public address (no webhooks needed), so it also runs on a PC.
// Exact itself is the list of what is done: an order with an invoice (Uw ref. = order number) is skipped.

const ONE_HOUR = 60 * 60 * 1000;

export async function runExactCatchUp({ store, settings, seller, invoiceSettings, fetchOrdersSince, fetchProduct = null, now = new Date(), log = () => {} }) {
    const firstDay = invoiceSettings.startDate || store.getSetting('first_used');
    const lastRun = store.getSetting('last_exact_catch_up');

    // Look back one extra hour for safety, but never before the first day
    let since = lastRun ? new Date(new Date(lastRun).getTime() - ONE_HOUR) : new Date(`${firstDay}T00:00:00Z`);
    const earliest = new Date(`${firstDay}T00:00:00Z`);
    if (since < earliest) since = earliest;

    const summary = { invoiced: [], errors: [] };
    const orders = await fetchOrdersSince(since.toISOString());
    const cache = {};

    for (const order of orders) {
        if (!isPaid(order) || dutchDate(new Date(order.created_at)) < firstDay) continue;
        try {
            const result = await invoiceOrderInExact(order, { settings, seller, invoiceSettings, fetchProduct, cache, log });
            if (result.status === 'invoiced') {
                summary.invoiced.push(`${order.name} -> ${result.number}`);
                log(`Exact: invoice ${result.number} for ${order.name}${result.emailed ? ', e-mailed by Exact' : ''}`);
            }
            // Refunds: a credit note per refund, once the invoice is there
            for (const credit of await creditRefundsInExact(order, { settings, seller, invoiceSettings, cache, log })) {
                summary.invoiced.push(`${order.name} refund -> ${credit.number}`);
                log(`Exact: credit note ${credit.number} for ${order.name} (invoice ${credit.invoiceNumber})${settings.sendEmail ? ', e-mailed by Exact' : ''}`);
            }
        } catch (error) {
            summary.errors.push(`${order.name}: ${error.message}`);
        }
    }

    // Only move on when every order worked; otherwise the same orders are tried again next round
    if (summary.errors.length === 0) store.setSetting('last_exact_catch_up', now.toISOString());
    return summary;
}
