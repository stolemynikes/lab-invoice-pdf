import fs from 'node:fs';
import path from 'node:path';
import { seller, shopify, invoiceSettings } from '../config.js';
import { InvoiceStore } from '../invoice/invoiceStore.js';
import { prepareInvoiceData, savePdf } from '../invoice/createInvoice.js';
import { buildCreditNote } from '../invoice/buildCreditNote.js';
import { dutchDate } from '../invoice/money.js';
import { fetchDocumentNumbersFromShopify, fetchOrderById } from '../shopify/shopifyClient.js';

// Restores the invoice database and PDFs after data loss (e.g. a broken NAS without a backup).
//
//   npm run restore              shows what would be restored, changes nothing
//   npm run restore -- --apply   restores it
//
// Where the data comes from, best source first:
//   1. The JSON copies next to the PDFs (exact originals), if the PDF folder still exists
//   2. Shopify: every order keeps its invoice number, date and credit note numbers in metafields.
//      The document is rebuilt from the order data in Shopify with that same number.
//
// It never overwrites anything that is still there, and the numbering continues after the highest
// restored number, so no number is ever used twice.

const apply = process.argv.includes('--apply');
const store = new InvoiceStore(invoiceSettings.databasePath);
const plan = [];

//1. JSON copies in the PDF folder
const backups = new Map();
for (const file of findJsonFiles(invoiceSettings.pdfDir)) {
    try {
        const document = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (document.number && document.orderId) backups.set(document.number, document);
    } catch {
        console.log(`  ⚠ Could not read ${file}, skipped`);
    }
}
console.log(`Found ${backups.size} JSON copies in ${invoiceSettings.pdfDir}`);

console.log('Reading invoice numbers from Shopify...');
const fromShopify = await fetchDocumentNumbersFromShopify(shopify);
console.log(`Found ${fromShopify.length} orders with an invoice number in Shopify`);
const shopifyNumbers = new Set(fromShopify.flatMap((saved) => [saved.invoiceNumber, ...saved.creditNotes.map((link) => link.number)]));

// Only one invoice per order and one credit note per refund. If there are several copies
// (e.g. old test invoices that were made again), take the one Shopify knows, otherwise the newest.
const best = new Map();
for (const document of backups.values()) {
    const key = document.kind === 'credit_note' ? `refund:${document.refundId}` : `order:${document.orderId}`;
    const current = best.get(key);
    const better =
        !current ||
        (shopifyNumbers.has(document.number) && !shopifyNumbers.has(current.number)) ||
        (shopifyNumbers.has(document.number) === shopifyNumbers.has(current.number) && sequenceOf(document.number) > sequenceOf(current.number));
    if (better) best.set(key, document);
}

// Invoices first, so credit notes can refer to them
const sorted = [...best.values()].sort((a, b) => (a.kind === 'credit_note') - (b.kind === 'credit_note'));
for (const document of sorted) {
    if (!isInStore(document)) plan.push({ source: 'JSON copy', document });
}

//2. Numbers saved on the orders in Shopify

for (const saved of fromShopify) {
    const known = (number) => backups.has(number) || plan.some((step) => step.document.number === number);
    const missingInvoice = !store.findByOrder(saved.orderId) && !known(saved.invoiceNumber);
    const missingCreditNotes = saved.creditNotes.filter((link) => !creditNoteInStore(link.number) && !known(link.number));
    if (!missingInvoice && missingCreditNotes.length === 0) continue;

    const order = await fetchOrderById(shopify, saved.orderId);
    let invoice = store.findByOrder(saved.orderId) || backups.get(saved.invoiceNumber);
    if (missingInvoice) {
        invoice = {
            ...(await prepareInvoiceData(order, { seller, settings: invoiceSettings })),
            number: saved.invoiceNumber,
            issueDate: saved.issueDate || dutchDate(new Date(order.processed_at || order.created_at)),
            restored: true,
        };
        invoice.warnings.push('Rebuilt from Shopify after data loss. Check it against your bookkeeping.');
        plan.push({ source: 'Shopify', document: invoice });
    }

    // Credit notes: matched to the refunds by refund id, or else in the order they were made
    const refunds = [...(order.refunds || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    saved.creditNotes.forEach((link, index) => {
        if (!missingCreditNotes.includes(link)) return;
        const refund = refunds.find((r) => String(r.id) === String(link.refundId)) || refunds[index];
        const data = refund && buildCreditNote({ refund, order, invoice, seller });
        if (!data) {
            console.log(`  ⚠ ${link.number}: no matching refund found on order ${saved.orderName}, skipped`);
            return;
        }
        const creditNote = {
            ...data,
            number: link.number,
            issueDate: link.issueDate || dutchDate(new Date(refund.processed_at || refund.created_at)),
            restored: true,
        };
        creditNote.warnings.push('Rebuilt from Shopify after data loss. Check it against your bookkeeping.');
        plan.push({ source: 'Shopify', document: creditNote });
    });
}

//3. Show or do it
if (plan.length === 0) {
    console.log('Nothing to restore: everything is still there.');
} else {
    console.log(`\n${apply ? 'Restoring' : 'Would restore'} ${plan.length} document(s):`);
    for (const { source, document } of plan) {
        const line = `  ${document.number.padEnd(28)} order ${String(document.orderName).padEnd(10)} from ${source}`;
        if (!apply) {
            console.log(line);
            continue;
        }
        if (!store.restoreDocument(document)) {
            console.log(`${line} – skipped, already there`);
            continue;
        }
        const existingPdf = path.join(invoiceSettings.pdfDir, document.issueDate.slice(0, 4), `${document.number}.pdf`);
        const pdfPath = fs.existsSync(existingPdf) ? existingPdf : await savePdf(document, invoiceSettings.pdfDir, invoiceSettings.brand);
        store.setPdfPath(document.number, pdfPath);
        console.log(line);
    }
    if (!apply) console.log('\nNothing was changed. Run again with --apply to restore.');
    else console.log('\nDone. New invoices continue after the highest restored number.');
}
store.close();

function isInStore(document) {
    return document.kind === 'credit_note'
        ? Boolean(store.findCreditNoteByRefund(document.refundId)) || store.hasDocument(document.number)
        : Boolean(store.findByOrder(document.orderId)) || store.hasDocument(document.number);
}

function creditNoteInStore(number) {
    return store.hasDocument(number);
}

// "INV-2026-12" -> 12 (numbers have no fixed length, so compare them as numbers)
function sequenceOf(number) {
    return Number(String(number).split('-').pop());
}

function findJsonFiles(folder) {
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder, { recursive: true })
        .filter((name) => String(name).endsWith('.json'))
        .map((name) => path.join(folder, String(name)));
}
