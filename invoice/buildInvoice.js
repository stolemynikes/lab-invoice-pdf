import { toCents, sum, dutchDate } from './money.js';

// Turns a Shopify order into invoice data (everything except the invoice number and date).
// The VAT amounts always come from what Shopify actually charged.
// The VAT situation (classification) only decides the legal text and the warnings.

// Checkout field names that may contain the customer's VAT number
const VAT_FIELD_NAME = /^(vat|btw|ust|tva|iva|tax)[\s_-]*(id|number|nummer|nr|no)?$/i;

// Finds a VAT number the customer filled in at checkout (Shopify stores it in note_attributes)
export function findCustomerVatId(order) {
    const field = (order.note_attributes || []).find((a) => VAT_FIELD_NAME.test(a.name.trim()));
    return field?.value?.trim() || null;
}

export function buildInvoice({ order, seller, classification, vatCheck = null }) {
    const warnings = [...classification.warnings];
    const lines = [];

    //products
    for (const item of order.line_items) {
        if (item.quantity <= 0) continue;
        let description = item.variant_title ? `${item.title} – ${item.variant_title}` : item.title;
        if (item.gift_card) description += ' (gift card – outside the scope of VAT)';

        lines.push(
            buildLine({
                description,
                sku: item.sku || null,
                quantity: item.quantity,
                unitPrice: toCents(item.price),
                discount: discountOf(item.discount_allocations, item.total_discount),
                taxLines: item.tax_lines,
                taxesIncluded: order.taxes_included,
                outsideVatScope: Boolean(item.gift_card),
            }),
        );
    }

    //shipping costs
    for (const shipping of order.shipping_lines || []) {
        lines.push(
            buildLine({
                description: `Shipping – ${shipping.title}`,
                sku: null,
                quantity: 1,
                unitPrice: toCents(shipping.price),
                discount: discountOf(shipping.discount_allocations),
                taxLines: shipping.tax_lines,
                taxesIncluded: order.taxes_included,
                outsideVatScope: false,
            }),
        );
    }

    const totals = {
        net: sum(lines.map((line) => line.netTotal)),
        vat: sum(lines.map((line) => line.vatAmount)),
        gross: sum(lines.map((line) => line.grossTotal)),
    };

    //sanity checks
    const shopifyTotal = toCents(order.total_price);
    if (Math.abs(shopifyTotal - totals.gross) > 1) {
        warnings.push(`Invoice total ${totals.gross / 100} differs from the Shopify order total ${shopifyTotal / 100}.`);
    }
    if (order.currency !== 'EUR') {
        warnings.push(`Order is in ${order.currency}. Dutch rules require the VAT amount to also be shown in EUR.`);
    }

    const buyer = toParty(order.billing_address || order.shipping_address, order.email);
    if (classification.scenario === 'eu_b2b' && vatCheck) buyer.vatId = vatCheck.vatId;

    return {
        orderId: String(order.id),
        orderName: order.name,
        orderDate: dutchDate(new Date(order.processed_at || order.created_at)),
        currency: order.currency,
        seller,
        buyer,
        shipTo: order.shipping_address ? toParty(order.shipping_address) : null,
        scenario: classification.scenario,
        destinationCountry: classification.territory.vatCountry,
        lines,
        vatSummary: vatSummaryOf(lines),
        totals,
        legalNotes: legalNotesFor(classification, totals.vat, vatCheck, warnings),
        warnings, // for you only, never printed on the invoice
        vatCheck,
    };
}

// One invoice line with all amounts in cents
function buildLine({ description, sku, quantity, unitPrice, discount, taxLines = [], taxesIncluded, outsideVatScope }) {
    const vatRate = sum(taxLines.map((t) => t.rate));
    const vatAmount = sum(taxLines.map((t) => toCents(t.price)));
    const priceTotal = unitPrice * quantity - discount;
    const base = { description, sku, quantity, vatRate, vatAmount, outsideVatScope };

    if (taxesIncluded) {
        // Shopify prices include VAT, so we work back to the amounts without VAT
        const netTotal = priceTotal - vatAmount;
        const unitPriceNet = Math.round(unitPrice / (1 + vatRate));
        const discountNet = discount === 0 ? 0 : unitPriceNet * quantity - netTotal;
        return { ...base, unitPriceNet, discountNet, netTotal, grossTotal: priceTotal };
    }

    return {
        ...base,
        unitPriceNet: unitPrice,
        discountNet: discount,
        netTotal: priceTotal,
        grossTotal: priceTotal + vatAmount,
    };
}

// Totals per VAT rate (the law requires a breakdown per rate)
function vatSummaryOf(lines) {
    const byRate = new Map();
    for (const line of lines) {
        if (line.outsideVatScope) continue;
        const key = line.vatRate.toFixed(4);
        const row = byRate.get(key) || { rate: line.vatRate, net: 0, vat: 0 };
        row.net += line.netTotal;
        row.vat += line.vatAmount;
        byRate.set(key, row);
    }
    return [...byRate.values()].sort((a, b) => b.rate - a.rate);
}

// The legal text printed at the bottom of the invoice
function legalNotesFor(classification, totalVat, vatCheck, warnings) {
    const { scenario, territory } = classification;

    if (scenario === 'eu_b2b') {
        if (totalVat > 0) {
            warnings.push(
                'Customer has a valid EU VAT number, but VAT was charged. The invoice shows the VAT as charged. Refund it with a credit note if the sale should have been 0%.',
            );
            return [];
        }
        return [
            `Intra-Community supply of goods – VAT exempt under Article 138 of Directive 2006/112/EC (intracommunautaire levering). Customer VAT number: ${vatCheck.vatId}.`,
        ];
    }

    if (scenario === 'export') {
        if (totalVat > 0) {
            warnings.push('Order ships outside the EU but VAT was charged. Check your Shopify tax settings for this country.');
            return [];
        }
        const destination = territory.note ? ` Destination: ${territory.note}.` : '';
        return [`Export of goods outside the EU – 0% VAT (Article 146 of Directive 2006/112/EC).${destination}`];
    }

    // domestic or EU consumer
    if (totalVat === 0) {
        warnings.push('No VAT was charged on a sale within the EU. Check the Shopify tax settings or the customer exemption.');
    }
    return [];
}

function discountOf(allocations, fallback) {
    if (allocations?.length) return sum(allocations.map((a) => toCents(a.amount)));
    return toCents(fallback);
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

// Shopify address -> name + address lines for the invoice
function toParty(address, email) {
    if (!address) return { name: email || 'Customer', company: null, addressLines: [], countryCode: '' };

    const name = address.name || [address.first_name, address.last_name].filter(Boolean).join(' ');
    return {
        name,
        company: address.company || null,
        addressLines: [
            address.address1,
            address.address2,
            [address.zip, address.city].filter(Boolean).join(' '),
            countryNames.of(address.country_code.toUpperCase()),
        ].filter(Boolean),
        countryCode: address.country_code,
    };
}
