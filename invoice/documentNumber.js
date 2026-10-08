// The only allowed shape of an invoice or credit note number: SERIES-YEAR-DIGITS,
// e.g. INV-2026-1, CN-2026-12, TEST-INV-2026-1000 (no fixed length).
// Numbers are also used as file names, so anything else (slashes, dots, spaces...) is refused.
// That makes it impossible to write or read files outside the invoice folder with a crafted number.

const DOCUMENT_NUMBER = /^[A-Z][A-Z0-9]{0,15}(-[A-Z0-9]{1,15}){0,3}-\d{4}-\d{1,12}$/;
const SERIES = /^[A-Z][A-Z0-9]{0,15}(-[A-Z0-9]{1,15}){0,3}$/;

export function isValidDocumentNumber(number) {
    return typeof number === 'string' && DOCUMENT_NUMBER.test(number);
}

export function assertValidDocumentNumber(number) {
    if (!isValidDocumentNumber(number)) throw new Error(`Not a valid document number: ${JSON.stringify(String(number).slice(0, 40))}`);
    return number;
}

// For INVOICE_SERIES / CREDIT_NOTE_SERIES in .env: capitals, digits and dashes only
export function isValidSeries(series) {
    return typeof series === 'string' && SERIES.test(series);
}
