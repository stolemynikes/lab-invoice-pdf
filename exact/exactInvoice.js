import { get, write, odataText } from './exactClient.js';
import { customerFromOrder, ensureCustomer } from './exactCustomer.js';
import { pickVatCode } from './exactVatCodes.js';
import { createItemFromShopify, invoiceLineNote } from './exactItem.js';
import { prepareInvoiceData } from '../invoice/createInvoice.js';
import { formatMoney } from '../invoice/money.js';

// Makes the invoice for a paid Shopify order in Exact Online, and lets Exact process and e-mail it.
//
// Order of work, so nothing is ever made half:
//   1. Is there already an invoice in Exact with this order number (Uw ref.)? Then nothing new is made.
//   2. Work out every line: article (by SKU) and VAT code. Anything missing -> stop with a clear reason.
//   3. Customer + contact person (Exact e-mails the invoice to the contact person).
//   4. Concept invoice; its total must be exactly what the customer paid in Shopify, otherwise it stays a concept.
//   5. Process: Exact gives the number, books it and e-mails the PDF.

const PAID = ['paid', 'partially_refunded', 'refunded'];
export const CONCEPT = 20; // Exact status of an invoice that is not processed yet

// The e-mail text for invoices: EXACT_EMAIL_LAYOUT (its id), or else the only e-mail layout (type 2) Exact has
export async function findEmailLayout(settings, cache) {
    if (settings.emailLayout) return settings.emailLayout;
    if (cache.emailLayout === undefined) {
        const layouts = await get(settings, `/api/v1/${settings.division}/salesinvoice/Layouts?$select=ID,Subject,Type`);
        const emailLayouts = layouts.filter((layout) => layout.Type === 2);
        if (emailLayouts.length !== 1) {
            throw new Error(`set EXACT_EMAIL_LAYOUT: Exact has ${emailLayouts.length} e-mail layouts for invoices (${emailLayouts.map((l) => `${l.Subject} = ${l.ID}`).join(', ')})`);
        }
        cache.emailLayout = emailLayouts[0].ID;
    }
    return cache.emailLayout;
}

// "Paid in full on 15-10-2026 via iDEAL. Order LD1007." (Shopify's own test gateway is shown as "test")
export function paymentRemark(order, paidDate) {
    const [year, month, day] = paidDate.split('-');
    const method = (order.payment_gateway_names || []).filter(Boolean).map(gatewayName).join(', ');
    return `Paid in full on ${day}-${month}-${year}${method ? ` via ${method}` : ''}. Order ${order.name}.`;
}

// Shopify's internal gateway names -> what a customer recognises
const GATEWAYS = { shopify_payments: 'Shopify Payments', bogus: 'test payment', paypal: 'PayPal', manual: 'bank transfer' };
function gatewayName(name) {
    return GATEWAYS[name] || name.replace(/_/g, ' ');
}

export function isPaid(order) {
    return PAID.includes(order.financial_status);
}

// The invoice lines for Exact, from the same invoice data the PDF invoices use (amounts and VAT from Shopify)
export function exactLines(order, invoiceData, { itemIds, vatCodes, shippingItem, allowZeroForTest }) {
    const products = order.line_items.filter((item) => item.quantity > 0);
    const productCount = products.length;
    const included = Boolean(order.taxes_included);
    const problems = [];

    const lines = invoiceData.lines.map((line, index) => {
        const isShipping = index >= productCount;
        // Like the old Lightspeed invoices: product name on the first line, variant (and CAS etc.) on the second.
        // Shipping: "Shipping & handling" with the carrier underneath.
        const product = products[index];
        const shipping = order.shipping_lines?.[index - productCount];
        const name = isShipping ? 'Shipping & handling' : product?.title || line.description;
        const note = isShipping ? shipping?.title || '' : product?.variant_title || '';
        const itemCode = isShipping ? shippingItem : line.sku;
        const item = itemCode ? itemIds.get(itemCode) : null;
        if (!item) problems.push(itemCode ? `article ${itemCode} does not exist in Exact` : `"${line.description}" has no SKU`);
        const vatCode = vatCodeForLine(vatCodes, invoiceData, line, { included, allowZeroForTest }, problems);
        return toExactLine(line, { item, name, note, vatCode, included });
    });

    return { lines, problems };
}

// The Exact VAT code for one line; a missing code is added to problems (and then nothing is made)
export function vatCodeForLine(vatCodes, documentData, line, { included, allowZeroForTest }, problems) {
    const vatCode = pickVatCode(vatCodes, {
        scenario: documentData.scenario,
        countryCode: documentData.destinationCountry,
        rate: line.vatRate,
        included,
        allowZeroForTest,
    });
    if (!vatCode) {
        problems.push(`no Exact VAT code for ${Math.round(line.vatRate * 10000) / 100}% (${documentData.scenario}, ${documentData.destinationCountry}) on "${line.description}"`);
    }
    return vatCode;
}

// One Exact line from an invoice or credit note line (cents; negative on a credit note).
// Prices as the customer saw them: incl. VAT when the shop shows prices incl. VAT.
// A quantity that does not divide the amount evenly becomes "1 x total" with "3 × name" as description.
export function toExactLine(line, { item, name, note, vatCode, included }) {
    const total = included ? line.grossTotal : line.netTotal;
    const quantity = Math.abs(line.quantity) || 1;
    const sign = total < 0 ? -1 : 1;
    const even = total % quantity === 0;
    return {
        Item: item,
        Description: (even ? name : `${quantity} × ${name}`).slice(0, 60),
        Quantity: sign * (even ? quantity : 1),
        NetPrice: Math.abs(even ? total / quantity : total) / 100,
        VATCode: vatCode,
        ...(note ? { Notes: note } : {}),
    };
}

// Article code -> Exact article id, for the codes that exist in Exact
export async function lookupItemIds(settings, codes) {
    const itemIds = new Map();
    for (const code of new Set(codes.filter(Boolean))) {
        const [item] = await get(settings, `/api/v1/${settings.division}/logistics/Items?$filter=Code eq ${odataText(code)}&$select=ID`);
        if (item) itemIds.set(code, item.ID);
    }
    return itemIds;
}

// The VAT number may only be used to find the customer in Exact when VIES confirmed it (EU business sale).
// A number typed at checkout but not confirmed is ignored, so nobody can attach themselves to another company.
export function customerForExact(order, invoiceData) {
    const verifiedVatId = invoiceData.scenario === 'eu_b2b' && invoiceData.vatCheck?.status === 'valid' ? invoiceData.buyer?.vatId || null : null;
    return { ...customerFromOrder(order), vatId: verifiedVatId };
}

// fetchProduct(productId, variantId): Shopify product details, for the CAS etc. line under each product
// and to make missing articles (EXACT_CREATE_ITEMS)
export async function invoiceOrderInExact(order, { settings, seller, invoiceSettings, fetchProduct = null, cache = {}, log = () => {} }) {
    const base = `/api/v1/${settings.division}`;
    if (!isPaid(order)) return { status: 'not paid' };
    if (settings.testOrdersOnly && !order.test) return { status: 'skipped (not a test order)' };

    // 1. Already in Exact?
    const existing = await get(settings, `${base}/salesinvoice/SalesInvoices?$filter=YourRef eq ${odataText(order.name)}&$select=InvoiceID,InvoiceNumber,Status,AmountDC`);
    const processed = existing.find((invoice) => invoice.Status !== CONCEPT);
    if (processed) return { status: 'already invoiced', number: processed.InvoiceNumber };
    // Checked before anything is made, so a missing e-mail text never leaves a concept behind
    if (settings.sendEmail) await findEmailLayout(settings, cache);

    const invoiceData = await prepareInvoiceData(order, { seller, settings: invoiceSettings });
    const expectedTotal = invoiceData.totals.gross;

    let invoice = existing[0];
    if (!invoice) {
        // 2. Articles and VAT codes
        cache.vatCodes ||= await get(settings, `${base}/vat/VATCodes?$select=Code,Description,Percentage,Type`);
        const itemIds = await lookupItemIds(settings, [...order.line_items.map((item) => item.sku), settings.shippingItem]);
        // Products that are only in Shopify yet: made as new Exact articles, but only after every other check passed.
        // One per SKU, also when two order lines share a SKU.
        const toCreate = [];
        if (settings.createItems && fetchProduct) {
            for (const item of order.line_items) {
                if (item.quantity <= 0 || !item.sku || itemIds.has(item.sku) || !item.product_id || !item.variant_id) continue;
                toCreate.push(item);
                itemIds.set(item.sku, `new:${item.sku}`);
            }
        }

        const { lines, problems } = exactLines(order, invoiceData, {
            itemIds,
            vatCodes: cache.vatCodes,
            shippingItem: settings.shippingItem,
            allowZeroForTest: Boolean(order.test),
        });
        if (problems.length) throw new Error(`not made in Exact: ${problems.join('; ')}`);

        // CAS, EG, UN, ADR class and packing group under each product (from the Shopify metafields)
        const productDetails = new Map();
        if (fetchProduct) {
            const products = order.line_items.filter((item) => item.quantity > 0);
            for (const [index, item] of products.entries()) {
                if (!item.product_id || !item.variant_id) continue;
                if (!productDetails.has(item.variant_id)) productDetails.set(item.variant_id, await fetchProduct(item.product_id, item.variant_id));
                const note = invoiceLineNote(productDetails.get(item.variant_id));
                if (note) lines[index].Notes = note;
            }
        }

        for (const item of toCreate) {
            const line = invoiceData.lines.find((invoiceLine) => invoiceLine.sku === item.sku);
            const details = productDetails.get(item.variant_id) || (await fetchProduct(item.product_id, item.variant_id));
            const id = await createItemFromShopify(settings, details, line, cache);
            for (const exactLine of lines) if (exactLine.Item === `new:${item.sku}`) exactLine.Item = id;
            log(`Exact: new article ${item.sku} made (${details.product?.title ?? ''})`);
        }

        // 3. Customer with contact person
        const customer = await ensureCustomer(settings, customerForExact(order, invoiceData));

        // 4. Concept invoice
        invoice = await write(settings, 'POST', `${base}/salesinvoice/SalesInvoices`, {
            Journal: settings.journal,
            OrderedBy: customer.accountId,
            OrderedByContactPerson: customer.contactId,
            InvoiceTo: customer.accountId,
            InvoiceToContactPerson: customer.contactId,
            DeliverTo: customer.accountId,
            InvoiceDate: invoiceData.paidDate,
            OrderDate: invoiceData.orderDate,
            PaymentCondition: settings.paymentCondition,
            YourRef: order.name,
            Description: `Shopify ${order.name}${order.test ? ' (TEST)' : ''}`,
            // Printed on the invoice (layout field "Opmerkingen"): it is already paid, and how
            Remarks: paymentRemark(order, invoiceData.paidDate),
            SalesInvoiceLines: lines,
        });
        log(`Exact: concept invoice made for ${order.name}`);
    }

    // The total in Exact must be exactly what the customer paid, to the cent
    const [check] = await get(settings, `${base}/salesinvoice/SalesInvoices?$filter=InvoiceID eq guid'${invoice.InvoiceID}'&$select=AmountDC,Status`);
    if (Math.round(check.AmountDC * 100) !== expectedTotal) {
        throw new Error(`concept invoice in Exact is ${formatMoney(Math.round(check.AmountDC * 100))}, Shopify says ${formatMoney(expectedTotal)}. Left as concept, check it in Exact.`);
    }

    // 5. Process: number, booking and e-mail
    const number = await processInExact(settings, invoice.InvoiceID, invoiceData.paidDate, cache);
    return { status: 'invoiced', number, date: invoiceData.paidDate, orderDate: invoiceData.orderDate, total: expectedTotal, currency: invoiceData.currency, emailed: settings.sendEmail, warnings: invoiceData.warnings };
}

// Lets Exact process a concept invoice or credit note: it gets its number, is booked and e-mailed.
// Without an e-mail layout Exact processes the document but sends nothing.
export async function processInExact(settings, invoiceId, invoiceDate, cache = {}, { creditNote = false } = {}) {
    const base = `/api/v1/${settings.division}`;
    // A credit note gets its own e-mail text when EXACT_CREDIT_EMAIL_LAYOUT is set
    const emailLayout = !settings.sendEmail ? null : creditNote && settings.creditEmailLayout ? settings.creditEmailLayout : await findEmailLayout(settings, cache);
    await write(settings, 'POST', `${base}/salesinvoice/PrintedSalesInvoices`, {
        InvoiceID: invoiceId,
        InvoiceDate: invoiceDate,
        SendEmailToCustomer: settings.sendEmail,
        ...(emailLayout ? { EmailLayout: emailLayout } : {}),
        // The look of the PDF (Lay-outs, type Verkoopfactuur). Empty = Exact's default layout.
        ...(settings.invoiceLayout ? { DocumentLayout: settings.invoiceLayout } : {}),
        // e.g. facturen@: must first be added in Exact under Stamgegevens > Administratiemailadressen
        ...(settings.sendEmail && settings.senderEmail ? { SenderEmailAddress: settings.senderEmail } : {}),
    });
    const [done] = await get(settings, `${base}/salesinvoice/SalesInvoices?$filter=InvoiceID eq guid'${invoiceId}'&$select=InvoiceNumber,Status`);
    return done.InvoiceNumber;
}
