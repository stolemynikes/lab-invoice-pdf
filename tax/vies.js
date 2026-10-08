// Checks a customer's EU VAT number with the official EU service (VIES).
// We keep the VIES consultation number as proof that we checked it.

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

// Country prefixes used in VAT numbers (Greece = EL, Northern Ireland = XI)
const VAT_PREFIXES = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'EL', 'HU', 'IE',
    'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'XI',
]);

// "de 123.456.789" -> { prefix: 'DE', number: '123456789' }
function splitVatId(raw) {
    const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prefix = cleaned.slice(0, 2);
    const number = cleaned.slice(2);
    if (!VAT_PREFIXES.has(prefix) || number.length < 2) return null;
    return { prefix, number };
}

// status is one of: 'valid', 'invalid', 'unavailable' (VIES down), 'malformed', 'skipped'
export async function checkVatId(raw, { online = true, requesterVatId, fetchFn = fetch } = {}) {
    const checkedAt = new Date().toISOString();
    const parts = splitVatId(raw);
    if (!parts) {
        return { input: raw, vatId: raw, prefix: '', status: 'malformed', checkedAt };
    }

    const result = { input: raw, vatId: parts.prefix + parts.number, prefix: parts.prefix, checkedAt };
    if (!online) return { ...result, status: 'skipped' };

    const requester = requesterVatId ? splitVatId(requesterVatId) : null;

    try {
        const response = await fetchFn(VIES_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                countryCode: parts.prefix,
                vatNumber: parts.number,
                ...(requester && { requesterMemberStateCode: requester.prefix, requesterNumber: requester.number }),
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return { ...result, status: 'unavailable' };

        const body = await response.json();
        if (body.errorWrappers?.length || typeof body.valid !== 'boolean') {
            return { ...result, status: 'unavailable' };
        }

        return {
            ...result,
            status: body.valid ? 'valid' : 'invalid',
            registeredName: cleanField(body.name),
            registeredAddress: cleanField(body.address),
            consultationNumber: body.requestIdentifier || null,
        };
    } catch {
        return { ...result, status: 'unavailable' };
    }
}

// VIES uses "---" when a field is hidden
function cleanField(value) {
    return value && value !== '---' ? value.trim() : null;
}
