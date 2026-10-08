import { toCents, sum, dutchDate } from './money.js';
import { vatSummaryOf } from './buildInvoice.js';

// Turns a Shopify refund into credit note data (everything except the credit note number and date).
// A credit note mirrors the original invoice with negative amounts and must refer to that invoice.
// Returns null when nothing was refunded (e.g. a refund that only restocked items).

export function buildCreditNote({ refund, order, invoice, seller }) {
    const warnings = [];
    const lines = [];

    //refunded products
    for (const refundLine of refund.refund_line_items || []) {
        const item = refundLine.line_item;
        if (!item || refundLine.quantity <= 0) continue;
        lines.push(
            creditLine({
                description: item.variant_title ? `${item.title} – ${item.variant_title}` : item.title,
                sku: item.sku || null,
                quantity: refundLine.quantity,
                unitPrice: toCents(item.price),
                rate: sum((item.tax_lines || []).map((t) => t.rate)),
                subtotal: toCents(refundLine.subtotal),
                tax: toCents(refundLine.total_tax),
                taxesIncluded: order.taxes_included,
            }),
        );
    }

    //refunded shipping costs (newer Shopify refunds use refund_shipping_lines, older ones an order adjustment)
    const shippingLines = refund.refund_shipping_lines || [];
    for (const shipping of shippingLines) {
        const subtotal = toCents(shipping.subtotal_amount_set?.shop_money?.amount ?? shipping.subtotal);
        const tax = toCents(shipping.total_tax_amount_set?.shop_money?.amount ?? shipping.total_tax);
        if (subtotal === 0 && tax === 0) continue;
        lines.push(
            creditLine({
                description: `Shipping – ${shipping.shipping_line?.title || 'refund'}`,
                sku: null,
                quantity: 1,
                unitPrice: subtotal,
                rate: sum((shipping.shipping_line?.tax_lines || []).map((t) => t.rate)),
                subtotal,
                tax,
                taxesIncluded: order.taxes_included,
            }),
        );
    }

    //other amounts (Shopify stores these as negative numbers, without VAT included)
    for (const adjustment of refund.order_adjustments || []) {
        if (adjustment.kind === 'shipping_refund' && shippingLines.length > 0) continue;
        const net = toCents(adjustment.amount);
        const vat = toCents(adjustment.tax_amount);
        if (net === 0 && vat === 0) continue;

        const description = adjustment.kind === 'shipping_refund' ? 'Shipping – refund' : 'Refund adjustment';
        const rate = net !== 0 ? Math.round((vat / net) * 10000) / 10000 : 0;
        lines.push({
            description,
            sku: null,
            quantity: -1,
            unitPriceNet: Math.abs(net),
            discountNet: 0,
            netTotal: net,
            vatRate: rate,
            vatAmount: vat,
            grossTotal: net + vat,
        });
        if (adjustment.kind !== 'shipping_refund') {
            warnings.push(
                `Refund contains an amount that is not linked to products (${(net + vat) / 100}, reason: ${adjustment.reason || 'none'}). Check the VAT on this credit note.`,
            );
        }
    }

    const refunded = sum(
        (refund.transactions || [])
            .filter((t) => t.kind === 'refund' && t.status === 'success')
            .map((t) => toCents(t.amount)),
    );
    if (lines.length === 0 && refunded === 0) return null;

    const totals = {
        net: sum(lines.map((line) => line.netTotal)),
        vat: sum(lines.map((line) => line.vatAmount)),
        gross: sum(lines.map((line) => line.grossTotal)),
    };

    //sanity check: the credit note must match the money that was paid back
    if (Math.abs(refunded + totals.gross) > 1) {
        warnings.push(`Credit note total ${-totals.gross / 100} differs from the amount refunded in Shopify (${refunded / 100}).`);
    }

    return {
        kind: 'credit_note',
        refundId: String(refund.id),
        refundDate: dutchDate(new Date(refund.processed_at || refund.created_at)),
        refundedAmount: refunded,
        originalInvoice: { number: invoice.number, issueDate: invoice.issueDate },
        orderId: String(order.id),
        customerId: invoice.customerId ?? null, // same customer as the invoice
        customerEmail: invoice.customerEmail ?? null,
        orderName: order.name,
        orderDate: invoice.orderDate,
        currency: order.currency,
        seller,
        buyer: invoice.buyer,
        shipTo: invoice.shipTo,
        scenario: invoice.scenario,
        destinationCountry: invoice.destinationCountry,
        lines,
        vatSummary: vatSummaryOf(lines),
        totals,
        legalNotes: [
            `This credit note corrects invoice ${invoice.number} of ${invoice.issueDate}.`,
            ...invoice.legalNotes, // the same VAT exemption applies to the refund
        ],
        warnings, // for you only, never printed
        vatCheck: invoice.vatCheck,
    };
}

// One credit note line: quantity and amounts are negative
function creditLine({ description, sku, quantity, unitPrice, rate, subtotal, tax, taxesIncluded }) {
    const gross = taxesIncluded ? subtotal : subtotal + tax;
    const net = gross - tax;
    const unitPriceNet = taxesIncluded ? Math.round(unitPrice / (1 + rate)) : unitPrice;
    const discountNet = Math.abs(unitPriceNet * quantity - net) > 1 ? unitPriceNet * quantity - net : 0;

    return {
        description,
        sku,
        quantity: -quantity,
        unitPriceNet,
        discountNet: -discountNet,
        netTotal: -net,
        vatRate: rate,
        vatAmount: -tax,
        grossTotal: -gross,
    };
}
