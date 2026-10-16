// The only allowed shape of an invoice or credit note number: SERIES-YEAR-DIGITS,
// e.g. INV-2026-1, CN-2026-12, TEST-INV-2026-1000 (no fixed length).
// Numbers are also used as file names, so anything else (slashes, dots, spaces...) is refused.
// That makes it impossible to write or read files outside the invoice folder with a crafted number.

const DOCUMENT_NUMBER = /^[A-Z][A-Z0-9]{0,15}(-[A-Z0-9]{1,15}){0,3}-\d{4}-\d{1,12}$/;
const SERIES = /^[A-Z][A-Z0-9]{0,15}(-[A-Z0-9]{1,15}){0,3}$/;

export function isValidDocumentNumber(number) {
    return typeof number === 'string' && DOCUMENT_NUMBER.test(number);
}

// An invoice number from Exact Online (INVOICE_MODE=exact): digits only, e.g. 26700005
export function isValidExactNumber(number) {
    return typeof number === 'string' && /^\d{1,12}$/.test(number);
}

export function assertValidDocumentNumber(number) {
    if (!isValidDocumentNumber(number)) throw new Error(`Not a valid document number: ${JSON.stringify(String(number).slice(0, 40))}`);
    return number;
}

// File name on the NAS, without extension: "INV-2026-12 - LD1234 - Company BV".
// The order number and the company (or person) name make the file easy to find with the search bar
// while a customer is on the phone. Both come from Shopify, so they are cleaned: only letters, digits,
// spaces and a few safe signs are kept. Never slashes, dots at the end or other path tricks.
export function documentFileName(document) {
    const number = assertValidDocumentNumber(document.number);
    const order = cleanForFileName(String(document.orderName ?? '').replace(/^#/, ''), 20);
    const name = cleanForFileName(document.buyer?.company || document.buyer?.name || '', 60);
    return [number, order, name].filter(Boolean).join(' - ');
}

export function cleanForFileName(text, maxLength) {
    return String(text)
        .normalize('NFC')
        .replace(/[^\p{L}\p{N} .&'()+,-]/gu, ' ')
        .replace(/\.{2,}/g, '.')
        .replace(/\s+/g, ' ')
        .slice(0, maxLength)
        .replace(/^[\s.]+|[\s.]+$/g, '');
}

// For INVOICE_SERIES / CREDIT_NOTE_SERIES in .env: capitals, digits and dashes only
export function isValidSeries(series) {
    return typeof series === 'string' && SERIES.test(series);
}
