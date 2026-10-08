import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { formatMoney, formatRate } from '../invoice/money.js';

// Turns an invoice into an A4 PDF.
// Clean style like the Shopify order page: black text, grey labels, thin lines, rounded boxes.
// Open Sans (the website font) is embedded so names with special letters (ł, ř, ő, ß...) print correctly.
//
// The look can be changed with design options (see DESIGN_OPTIONS below, set in .env).

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.join(ROOT, 'assets', 'fonts');
const DEFAULT_LOGO = path.join(ROOT, 'assets', 'logo.svg');

// All design choices. The first value of each is the default.
export const DESIGN_OPTIONS = {
    header: ['classic', 'centered', 'panel'],
    table: ['lines', 'striped', 'boxed'],
    total: ['line', 'box', 'bar'],
    accent: ['none', 'navy'],
};

const TEXT = '#1a1a1a';
const GREY = '#707070';
const LINE = '#dedede';
const LIGHT_LINE = '#ededed';
const FILL = '#f5f5f5';
const STRIPE = '#fafafa';
const NAVY = '#1e4475';

const MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const RIGHT = MARGIN + CONTENT_WIDTH;

// Columns of the product table
const COLUMNS = [
    { label: 'Description', width: 190, align: 'left' },
    { label: 'Qty', width: 35, align: 'right' },
    { label: 'Unit price excl. VAT', width: 75, align: 'right' },
    { label: 'Discount excl. VAT', width: 65, align: 'right' },
    { label: 'VAT', width: 45, align: 'right' },
    { label: 'Total excl. VAT', width: 85, align: 'right' },
];

// Returns the PDF as a Buffer
export function renderInvoice(invoice, { logo = DEFAULT_LOGO, color = NAVY, design = {} } = {}) {
    const style = resolveDesign(design);
    const doc = new PDFDocument({
        size: 'A4',
        margin: MARGIN,
        bufferPages: true,
        info: { Title: `Invoice ${invoice.number}`, Author: invoice.seller.legalName },
    });
    doc.registerFont('normal', path.join(FONTS, 'OpenSans-Regular.ttf'));
    doc.registerFont('semibold', path.join(FONTS, 'OpenSans-SemiBold.ttf'));
    doc.registerFont('bold', path.join(FONTS, 'OpenSans-Bold.ttf'));

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });

    const logoPath = logo && path.resolve(ROOT, logo);
    const context = {
        doc,
        invoice,
        style,
        logoPath: logoPath && fs.existsSync(logoPath) ? logoPath : null,
        money: (cents) => formatMoney(cents, invoice.currency),
        // Logo colour for the title and the total when the accent is on, otherwise black
        strong: style.accent === 'navy' ? color : TEXT,
    };

    let y = drawHeader(context);
    y = drawAddresses(context, y + 30);
    y = drawProductTable(context, y + 30);
    y = drawTotals(context, y + 20);
    drawLegalNotes(context, y + 24);
    drawFooter(context);

    doc.end();
    return finished;
}

// Fills in missing or unknown options with the defaults
export function resolveDesign(design = {}) {
    const style = {};
    for (const [part, values] of Object.entries(DESIGN_OPTIONS)) {
        style[part] = values.includes(design[part]) ? design[part] : values[0];
    }
    return style;
}

// ---------- header ----------

function drawHeader(context) {
    if (context.style.header === 'centered') return centeredHeader(context);
    if (context.style.header === 'panel') return panelHeader(context);
    return classicHeader(context);
}

function invoiceDetails(invoice) {
    return [
        ['Invoice number', invoice.number],
        ['Invoice date', invoice.issueDate],
        ['Order', invoice.orderName],
        ['Order date', invoice.orderDate],
    ];
}

function drawLogo({ doc, logoPath, invoice }, x, y, align = 'left') {
    if (!logoPath) {
        doc.font('semibold').fontSize(15).fillColor(TEXT);
        doc.text(invoice.seller.legalName, align === 'center' ? MARGIN : x, y, { width: align === 'center' ? CONTENT_WIDTH : 260, align });
        return doc.y + 4;
    }
    const width = 180;
    const left = align === 'center' ? MARGIN + (CONTENT_WIDTH - width) / 2 : x - 4;

    if (logoPath.toLowerCase().endsWith('.svg')) {
        drawSvg(doc, fs.readFileSync(logoPath, 'utf8'), left, y - 10, width, 56);
        return y + 54;
    }

    // Cut off the bottom edge of the logo image (the website logo has a thin grey line there)
    doc.save().rect(left, y - 10, width, 53).clip();
    doc.image(logoPath, left, y - 10, { fit: [width, 56], align: 'center' });
    doc.restore();
    return y + 54;
}

// Draws a simple SVG logo (only <path> shapes) as sharp vector shapes, scaled to fit the box
function drawSvg(doc, svg, x, y, maxWidth, maxHeight) {
    const viewBox = svg.match(/viewBox="([\d.\s-]+)"/)?.[1].trim().split(/\s+/).map(Number);
    const [, , svgWidth, svgHeight] = viewBox || [0, 0, Number(svg.match(/width="([\d.]+)/)?.[1]), Number(svg.match(/height="([\d.]+)/)?.[1])];
    const scale = Math.min(maxWidth / svgWidth, maxHeight / svgHeight);

    doc.save().translate(x, y).scale(scale);
    for (const [, attributes] of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
        const d = attributes.match(/\bd="([^"]+)"/)?.[1];
        if (!d) continue;
        const fill = attributes.match(/\bfill="(#[0-9a-fA-F]{3,6})"/)?.[1] || TEXT;
        const rule = /fill-rule="evenodd"/.test(attributes) ? 'even-odd' : 'non-zero';
        doc.path(d).fill(fill, rule);
    }
    doc.restore();
}

function sellerAddress(invoice) {
    return [invoice.seller.legalName, ...invoice.seller.addressLines];
}

function classicHeader(context) {
    const { doc, invoice, strong } = context;
    const addressY = drawLogo(context, MARGIN, MARGIN);
    doc.font('normal').fontSize(8.5).fillColor(GREY).text(sellerAddress(invoice).join('\n'), MARGIN, addressY, { width: 260 });
    const leftBottom = doc.y;

    doc.font('semibold').fontSize(20).fillColor(strong).text('Invoice', MARGIN, MARGIN - 4, { width: CONTENT_WIDTH, align: 'right' });
    let y = MARGIN + 28;
    for (const [label, value] of invoiceDetails(invoice)) {
        doc.font('normal').fontSize(8.5).fillColor(GREY).text(label, MARGIN + 250, y, { width: 120, align: 'right' });
        doc.fillColor(TEXT).text(value, MARGIN + 380, y, { width: CONTENT_WIDTH - 380, align: 'right' });
        y += 14;
    }
    return Math.max(leftBottom, y);
}

function centeredHeader(context) {
    const { doc, invoice, strong } = context;
    let y = drawLogo(context, MARGIN, MARGIN, 'center');
    doc.font('normal').fontSize(8.5).fillColor(GREY);
    doc.text(sellerAddress(invoice).join('  ·  '), MARGIN, y, { width: CONTENT_WIDTH, align: 'center' });

    y = doc.y + 18;
    doc.font('semibold').fontSize(20).fillColor(strong).text('Invoice', MARGIN, y, { width: CONTENT_WIDTH, align: 'center' });
    y = doc.y + 12;

    // The four invoice details side by side, between two thin lines
    doc.moveTo(MARGIN, y).lineTo(RIGHT, y).strokeColor(LINE).lineWidth(0.75).stroke();
    const columnWidth = CONTENT_WIDTH / 4;
    invoiceDetails(invoice).forEach(([label, value], i) => {
        const x = MARGIN + i * columnWidth;
        doc.font('normal').fontSize(8).fillColor(GREY).text(label, x, y + 10, { width: columnWidth, align: 'center' });
        doc.fontSize(9.5).fillColor(TEXT).text(value, x, y + 23, { width: columnWidth, align: 'center' });
    });
    y += 44;
    doc.moveTo(MARGIN, y).lineTo(RIGHT, y).strokeColor(LINE).lineWidth(0.75).stroke();
    return y - 8;
}

function panelHeader(context) {
    const { doc, invoice, strong } = context;
    const addressY = drawLogo(context, MARGIN, MARGIN);
    doc.font('normal').fontSize(8.5).fillColor(GREY).text(sellerAddress(invoice).join('\n'), MARGIN, addressY, { width: 240 });
    const leftBottom = doc.y;

    // Invoice details in a light grey rounded box on the right
    const x = MARGIN + 290;
    const width = RIGHT - x;
    const top = MARGIN - 10;
    const height = 104;
    doc.roundedRect(x, top, width, height, 10).fill(FILL);
    doc.font('semibold').fontSize(16).fillColor(strong).text('Invoice', x + 16, top + 12, { width: width - 32 });
    let y = top + 40;
    for (const [label, value] of invoiceDetails(invoice)) {
        doc.font('normal').fontSize(8.5).fillColor(GREY).text(label, x + 16, y, { width: 100 });
        doc.fillColor(TEXT).text(value, x + 110, y, { width: width - 126, align: 'right' });
        y += 14;
    }
    return Math.max(leftBottom, top + height);
}

// ---------- customer ----------

function drawAddresses(context, y) {
    const { doc, invoice } = context;
    addressBlock(context, 'Bill to', invoice.buyer, MARGIN, y);
    let bottom = doc.y;
    if (invoice.shipTo) {
        addressBlock(context, 'Ship to', invoice.shipTo, MARGIN + 260, y);
        bottom = Math.max(bottom, doc.y);
    }
    return bottom;
}

function addressBlock({ doc }, title, party, x, y) {
    doc.font('normal').fontSize(8.5).fillColor(GREY).text(title, x, y, { width: 235 });
    const lines = [party.company, party.name, ...party.addressLines].filter(Boolean);
    if (party.vatId) lines.push(`VAT number: ${party.vatId}`);
    doc.fontSize(9).fillColor(TEXT).text(lines.join('\n'), x, doc.y + 3, { width: 235, lineGap: 1 });
}

// ---------- product table ----------

function drawProductTable(context, y) {
    const { doc, invoice, style, money } = context;
    const rows = invoice.lines.map((line) => [
        line.sku ? `${line.description}\nSKU ${line.sku}` : line.description,
        String(line.quantity),
        money(line.unitPriceNet),
        line.discountNet ? `−${money(line.discountNet)}` : '',
        line.outsideVatScope ? 'n/a' : formatRate(line.vatRate),
        money(line.netTotal),
    ]);

    let boxTop = y;
    y = tableHeader(context, y);
    rows.forEach((cells, i) => {
        if (y > 690) {
            closeTableBox(context, boxTop, y);
            doc.addPage();
            boxTop = MARGIN;
            y = tableHeader(context, MARGIN);
        }
        y = tableRow(context, y, cells, i, i === rows.length - 1);
    });
    closeTableBox(context, boxTop, y);
    return y;
}

function tableHeader({ doc, style }, y) {
    doc.font('normal').fontSize(7.5);
    const labelHeight = Math.max(...COLUMNS.map((c) => doc.heightOfString(c.label, { width: c.width - 10 })));
    const padding = style.table === 'lines' ? 0 : 9;
    const height = labelHeight + padding * 2;

    if (style.table === 'striped') doc.roundedRect(MARGIN, y, CONTENT_WIDTH, height, 6).fill(FILL);

    doc.fillColor(GREY);
    let x = MARGIN;
    for (const column of COLUMNS) {
        const options = { width: column.width - 10, align: column.align };
        // Labels sit on the same bottom line, also when one wraps to two lines
        doc.text(column.label, x + 5, y + padding + labelHeight - doc.heightOfString(column.label, options), options);
        x += column.width;
    }

    const bottom = y + height + (style.table === 'lines' ? 8 : 0);
    if (style.table !== 'striped') {
        doc.moveTo(MARGIN, bottom).lineTo(RIGHT, bottom).strokeColor(LINE).lineWidth(0.75).stroke();
    }
    return bottom;
}

function tableRow({ doc, style }, y, cells, index, isLast) {
    doc.font('normal').fontSize(8.5);
    const height = Math.max(...COLUMNS.map((c, i) => doc.heightOfString(cells[i], { width: c.width - 10 }))) + 18;

    if (style.table === 'striped' && index % 2 === 1) doc.roundedRect(MARGIN, y, CONTENT_WIDTH, height, 6).fill(STRIPE);

    doc.fillColor(TEXT);
    let x = MARGIN;
    COLUMNS.forEach((column, i) => {
        doc.text(cells[i], x + 5, y + 9, { width: column.width - 10, align: column.align });
        x += column.width;
    });

    const bottom = y + height;
    const drawLine = style.table === 'lines' || (style.table === 'boxed' && !isLast);
    if (drawLine) doc.moveTo(MARGIN, bottom).lineTo(RIGHT, bottom).strokeColor(LIGHT_LINE).lineWidth(0.75).stroke();
    return bottom;
}

function closeTableBox({ doc, style }, top, bottom) {
    if (style.table !== 'boxed') return;
    doc.roundedRect(MARGIN, top, CONTENT_WIDTH, bottom - top, 10).strokeColor(LINE).lineWidth(0.75).stroke();
}

// ---------- totals ----------

function drawTotals(context, y) {
    const { doc, invoice, style, money, strong } = context;
    if (y > 600) {
        doc.addPage();
        y = MARGIN;
    }

    const boxed = style.total === 'box';
    const left = MARGIN + 235;
    const pad = boxed ? 16 : 0;
    const x = left + pad;
    const width = RIGHT - pad - x;
    const three = [90, 80, width - 170];
    const two = [170, width - 170];

    // In the "box" style everything sits in a light grey rounded box, so measure it first
    if (boxed) {
        const rows = invoice.vatSummary.length;
        const height = 16 + 16 + rows * 17 + 14 + 34 + 14 + 20 + 16;
        doc.roundedRect(left, y, RIGHT - left, height, 10).fill(FILL);
        y += 16;
    }

    y = summaryRow(doc, x, y, three, ['VAT rate', 'Net amount', 'VAT'], { color: GREY, size: 8 });
    for (const row of invoice.vatSummary) {
        y = summaryRow(doc, x, y, three, [formatRate(row.rate), money(row.net), money(row.vat)]);
    }
    y += 6;
    doc.moveTo(x, y).lineTo(x + width, y).strokeColor(boxed ? LINE : LIGHT_LINE).lineWidth(0.75).stroke();
    y += 8;
    y = summaryRow(doc, x, y, two, ['Total excl. VAT', money(invoice.totals.net)]);
    y = summaryRow(doc, x, y, two, ['Total VAT', money(invoice.totals.vat)]);
    y += 4;

    if (style.total === 'bar') {
        // The amount to pay in a full-width light grey bar
        y += 8;
        doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 40, 10).fill(FILL);
        doc.font('semibold').fontSize(12).fillColor(strong);
        doc.text('Total incl. VAT', MARGIN + 16, y + 12, { width: 200 });
        doc.fontSize(14).text(money(invoice.totals.gross), MARGIN + 200, y + 10, { width: CONTENT_WIDTH - 216, align: 'right' });
        return y + 40;
    }

    doc.moveTo(x, y).lineTo(x + width, y).strokeColor(boxed ? strong : TEXT).lineWidth(0.75).stroke();
    y += 10;
    y = summaryRow(doc, x, y, two, ['Total incl. VAT', money(invoice.totals.gross)], { font: 'semibold', size: 12, color: strong });
    return y + (boxed ? 16 : 0);
}

function summaryRow(doc, x, y, widths, cells, { font = 'normal', size = 9, color = TEXT } = {}) {
    doc.font(font).fontSize(size).fillColor(color);
    widths.forEach((width, i) => {
        doc.text(cells[i], x, y, { width, align: i === 0 ? 'left' : 'right' });
        x += width;
    });
    return y + size + 8;
}

// ---------- legal notes + footer ----------

// Legal text (EU business / export) in a thin rounded box
function drawLegalNotes({ doc, invoice }, y) {
    for (const note of invoice.legalNotes) {
        doc.font('normal').fontSize(8.5);
        const height = doc.heightOfString(note, { width: CONTENT_WIDTH - 28 });
        doc.roundedRect(MARGIN, y, CONTENT_WIDTH, height + 20, 8).strokeColor(LINE).lineWidth(0.75).stroke();
        doc.fillColor(TEXT).text(note, MARGIN + 14, y + 10, { width: CONTENT_WIDTH - 28 });
        y += height + 32;
    }
    doc.font('normal').fontSize(8.5).fillColor(GREY);
    doc.text('Paid in full via our online store. Thank you for your order.', MARGIN, y, { width: CONTENT_WIDTH });
}

// Company details at the bottom of every page (KvK, VAT number, bank...)
function drawFooter({ doc, invoice }) {
    const seller = invoice.seller;
    const parts = [
        `${seller.legalName}, statutair gevestigd te ${seller.registeredSeat}`,
        `KvK ${seller.kvkNumber}`,
        `VAT ${seller.vatId}`,
        seller.iban && `IBAN ${seller.iban}${seller.bic ? ` (BIC ${seller.bic})` : ''}`,
        seller.phone,
        seller.email,
        seller.website,
    ].filter(Boolean);

    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);
        // Allow writing inside the bottom margin without PDFKit starting a new page
        const bottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.moveTo(MARGIN, 772).lineTo(RIGHT, 772).strokeColor(LINE).lineWidth(0.75).stroke();
        doc.font('normal').fontSize(7.5).fillColor(GREY);
        doc.text(parts.join('  ·  '), MARGIN, 780, { width: CONTENT_WIDTH, align: 'center', lineGap: 1 });
        doc.page.margins.bottom = bottomMargin;
    }
}
