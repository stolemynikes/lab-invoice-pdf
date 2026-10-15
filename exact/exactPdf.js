import fs from 'node:fs';
import path from 'node:path';
import { get, getAccessToken } from './exactClient.js';
import { cleanForFileName } from '../invoice/documentNumber.js';

// A copy of every invoice and credit note PDF from Exact on the NAS, so a customer on the phone can be helped
// without logging in to Exact. Per year a folder for invoices and one for credit notes; the kind of document is
// also in the file name, because Exact uses one number series for both:
//   facturen/2026/Facturen/Invoice 26700005 - LD1008 - Company name.pdf
//   facturen/2026/Creditnotas/Credit note 26700006 - LD1008 - Company name.pdf
//
// Exact keeps the PDF as a "document" of the processed invoice. Needs the right to see documents in Exact.

const NUMBER = /^\d{1,12}$/;

export function exactPdfPath(pdfDir, { kind, number, orderName, customerName, date }) {
    if (!NUMBER.test(String(number))) throw new Error(`Not a valid Exact invoice number: ${JSON.stringify(String(number).slice(0, 20))}`);
    const year = String(date).slice(0, 4);
    if (!/^\d{4}$/.test(year)) throw new Error(`Not a valid date: ${JSON.stringify(String(date).slice(0, 20))}`);
    const name = [
        `${kind === 'credit' ? 'Credit note' : 'Invoice'} ${number}`,
        cleanForFileName(String(orderName ?? '').replace(/^#/, ''), 20),
        cleanForFileName(customerName ?? '', 60),
    ]
        .filter(Boolean)
        .join(' - ');
    return path.join(pdfDir, year, kind === 'credit' ? 'Creditnotas' : 'Facturen', `${name}.pdf`);
}

// Downloads the PDF of a processed invoice or credit note from Exact and saves it. Returns the file path.
export async function saveExactPdf(settings, pdfDir, document) {
    const file = exactPdfPath(pdfDir, document);
    if (fs.existsSync(file)) return file;

    const base = `/api/v1/${settings.division}`;
    const [found] = await get(settings, `${base}/documents/Documents?$filter=SalesInvoiceNumber eq ${Number(document.number)}&$select=ID`);
    if (!found) throw new Error(`no PDF in Exact yet for ${document.number}`);
    const attachments = await get(settings, `${base}/documents/DocumentAttachments?$filter=Document eq guid'${found.ID}'&$select=FileName,Url`);
    const pdf = attachments.find((attachment) => /\.pdf$/i.test(attachment.FileName || ''));
    if (!pdf?.Url) throw new Error(`no PDF attached to the Exact document of ${document.number}`);

    // The Exact login may only ever be sent to Exact itself
    const url = new URL(pdf.Url, settings.baseUrl);
    if (url.origin !== new URL(settings.baseUrl).origin) throw new Error('PDF link does not point to Exact, not downloaded');
    const response = await (settings.fetch || fetch)(url, { headers: { Authorization: `Bearer ${await getAccessToken(settings)}` } });
    if (!response.ok) throw new Error(`Exact answered ${response.status} on the PDF of ${document.number}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error(`what Exact sent for ${document.number} is not a PDF`);

    // Write to a temporary file first, so a half-written PDF never looks like a finished one
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.part`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, file);
    return file;
}
