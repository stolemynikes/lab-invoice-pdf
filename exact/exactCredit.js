import { get, write, odataText } from './exactClient.js';
import { customerFromOrder, ensureCustomer } from './exactCustomer.js';
import { pickVatCode } from './exactVatCodes.js';
import { findEmailLayout, processInExact } from './exactInvoice.js';
import { prepareInvoiceData } from '../invoice/createInvoice.js';
import { buildCreditNote } from '../invoice/buildCreditNote.js';

// A credit invoice in Exact for every refund in Shopify, e-mailed by Exact like the invoice.
//
// - One credit invoice per refund: its "Uw ref." is "<order> R<refund id>", so a refund is never credited twice.
// - Only after the order's invoice is in Exact (the credit note refers to that invoice number).
// - Amounts and VAT come from the Shopify refund; the total in Exact must match it to the cent,
//   otherwise it stays a concept for you to check.

const CONCEPT = 20;
const CREDIT_NOTE = 8021; // Exact's type for a sales credit note (8020 = invoice)

export function refundReference(order, refund) {
    return `${order.name} R${refund.id}`.slice(0, 30);
}

// Credit lines for Exact: negative quantities, prices as the customer saw them
export function exactCreditLines(order, creditData, { itemIds, vatCodes, shippingItem, allowZeroForTest }) {
    const included = Boolean(order.taxes_included);
    const problems = [];
    const lines = creditData.lines.map((line) => {
        const isShipping = !line.sku && /^Shipping/.test(line.description);
        const itemCode = line.sku || (isShipping ? shippingItem : null);
        const item = itemCode ? itemIds.get(itemCode) : null;
        if (!item) problems.push(itemCode ? `article ${itemCode} does not exist in Exact` : `"${line.description}" cannot be credited automatically, make this credit note by hand`);

        const vatCode = pickVatCode(vatCodes, {
            scenario: creditData.scenario,
            countryCode: creditData.destinationCountry,
            rate: line.vatRate,
            included,
            allowZeroForTest,
        });
        if (!vatCode) problems.push(`no Exact VAT code for ${Math.round(line.vatRate * 10000) / 100}% on "${line.description}"`);

        // Negative amounts; a quantity that does not divide the amount evenly becomes "-1 x total"
        const total = included ? line.grossTotal : line.netTotal;
        const quantity = Math.abs(line.quantity) || 1;
        const even = total % quantity === 0;
        const name = isShipping ? 'Shipping & handling' : line.description;
        return {
            Item: item,
            Description: (even ? name : `${quantity} × ${name}`).slice(0, 60),
            Quantity: even ? -quantity : -1,
            NetPrice: Math.abs(even ? total / quantity : total) / 100,
            VATCode: vatCode,
        };
    });
    return { lines, problems };
}

export async function creditRefundsInExact(order, { settings, seller, invoiceSettings, cache = {}, log = () => {} }) {
    const base = `/api/v1/${settings.division}`;
    const results = [];
    if (settings.testOrdersOnly && !order.test) return results;
    const refunds = [...(order.refunds || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (refunds.length === 0) return results;

    // The invoice the credit notes refer to
    const invoices = await get(settings, `${base}/salesinvoice/SalesInvoices?$filter=YourRef eq ${odataText(order.name)}&$select=InvoiceNumber,InvoiceDate,Status`);
    const invoice = invoices.find((i) => i.Status !== CONCEPT);
    if (!invoice) return results; // invoice first; the next round makes the credit notes
    const invoiceDate = exactDate(invoice.InvoiceDate);

    let invoiceData = null;
    for (const refund of refunds) {
        const reference = refundReference(order, refund);
        const existing = await get(settings, `${base}/salesinvoice/SalesInvoices?$filter=YourRef eq ${odataText(reference)}&$select=InvoiceID,InvoiceNumber,Status`);
        if (existing.some((i) => i.Status !== CONCEPT)) continue; // already credited

        invoiceData ||= await prepareInvoiceData(order, { seller, settings: invoiceSettings });
        const creditData = buildCreditNote({
            refund,
            order,
            invoice: { ...invoiceData, number: String(invoice.InvoiceNumber), issueDate: invoiceDate },
            seller,
        });
        if (!creditData || creditData.lines.length === 0) continue; // nothing refunded (e.g. only restocked)

        let credit = existing[0];
        if (!credit) {
            if (settings.sendEmail) await findEmailLayout(settings, cache);
            cache.vatCodes ||= await get(settings, `${base}/vat/VATCodes?$select=Code,Description,Percentage,Type`);
            const itemIds = new Map();
            for (const code of new Set([...creditData.lines.map((line) => line.sku).filter(Boolean), settings.shippingItem])) {
                const [item] = await get(settings, `${base}/logistics/Items?$filter=Code eq ${odataText(code)}&$select=ID`);
                if (item) itemIds.set(code, item.ID);
            }
            const { lines, problems } = exactCreditLines(order, creditData, {
                itemIds,
                vatCodes: cache.vatCodes,
                shippingItem: settings.shippingItem,
                allowZeroForTest: Boolean(order.test),
            });
            if (problems.length) throw new Error(`credit note for refund ${refund.id} not made in Exact: ${problems.join('; ')}`);

            const customer = await ensureCustomer(settings, customerFromOrder(order));
            credit = await write(settings, 'POST', `${base}/salesinvoice/SalesInvoices`, {
                Type: CREDIT_NOTE,
                Journal: settings.journal,
                OrderedBy: customer.accountId,
                OrderedByContactPerson: customer.contactId,
                InvoiceTo: customer.accountId,
                InvoiceToContactPerson: customer.contactId,
                DeliverTo: customer.accountId,
                InvoiceDate: creditData.refundDate,
                OrderDate: invoiceData.orderDate,
                PaymentCondition: settings.paymentCondition,
                YourRef: reference,
                Description: `Shopify ${order.name} refund${order.test ? ' (TEST)' : ''}`,
                // Printed on the credit note: the law asks for a reference to the original invoice
                Remarks: `Credit note for invoice ${invoice.InvoiceNumber} of ${dutch(invoiceDate)} (order ${order.name}). Refunded on ${dutch(creditData.refundDate)}.`,
                SalesInvoiceLines: lines,
            });
            log(`Exact: concept credit note made for ${order.name} (refund ${refund.id})`);
        }

        // Must be exactly the amount paid back, as a negative total
        const [check] = await get(settings, `${base}/salesinvoice/SalesInvoices?$filter=InvoiceID eq guid'${credit.InvoiceID}'&$select=AmountDC`);
        if (Math.round(check.AmountDC * 100) !== creditData.totals.gross) {
            throw new Error(`concept credit note in Exact is €${check.AmountDC}, Shopify refund is €${creditData.totals.gross / 100}. Left as concept, check it in Exact.`);
        }

        const number = await processInExact(settings, credit.InvoiceID, creditData.refundDate, cache, { creditNote: true });
        results.push({ refundId: String(refund.id), number, invoiceNumber: invoice.InvoiceNumber });
    }
    return results;
}

// Exact sends dates as "/Date(1760486400000)/"
function exactDate(value) {
    const ms = Number(String(value).match(/-?\d+/)?.[0]);
    return new Date(ms).toISOString().slice(0, 10);
}

const dutch = (iso) => iso.split('-').reverse().join('-');
