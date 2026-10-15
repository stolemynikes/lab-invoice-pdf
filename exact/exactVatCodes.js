// Which Exact VAT code belongs to an invoice line. A PROPOSAL until the accountant has confirmed it.
//
// - Netherlands: the "Te betalen btw" codes (101/103 when Shopify prices include VAT, 100/102 when not)
// - EU consumers (OSS): the Exact code "... OSS - <country>" with exactly the rate Shopify charged
// - EU business with a valid VAT number (ICP): 302, export outside the EU: 300
//
// When nothing fits, the answer is null and the invoice is NOT made: a wrong VAT code in the bookkeeping
// is much worse than an invoice that waits until someone has looked at it.

const DOMESTIC = {
    21: { included: '101', excluded: '100' },
    9: { included: '103', excluded: '102' },
};

// Country names as Exact writes them in the OSS code descriptions
const EXACT_COUNTRY_NAMES = {
    AT: 'Oostenrijk', BE: 'België', BG: 'Bulgarije', CY: 'Cyprus', CZ: 'Tsjechie', DE: 'Duitsland', DK: 'Denemarken',
    EE: 'Estland', ES: 'Spanje', FI: 'Finland', FR: 'Frankrijk', GR: 'Griekenland', HR: 'Kroatie', HU: 'Hongarije',
    IE: 'Ierland', IT: 'Italie', LT: 'Litouwen', LU: 'Luxemburg', LV: 'Letland', MT: 'Malta', PL: 'Polen', PT: 'Portugal',
    RO: 'Roemenie', SE: 'Zweden', SI: 'Slovenie', SK: 'Slowakije',
};

// vatCodes: the list from Exact (Code, Description, Percentage, Type), read once per run
export function pickVatCode(vatCodes, { scenario, countryCode, rate, included, allowZeroForTest = false }) {
    const percent = Math.round(rate * 10000) / 100;

    if (percent === 0) {
        if (scenario === 'eu_b2b') return '302';
        if (scenario === 'export') return '300';
        // 0% inside the Netherlands or to an EU consumer means the Shopify tax settings are wrong.
        // Only for Shopify test orders this is booked as "Geen BTW", so the flow can be tested.
        return allowZeroForTest ? '0' : null;
    }

    if (scenario === 'domestic') return DOMESTIC[percent]?.[included ? 'included' : 'excluded'] ?? null;

    if (scenario === 'eu_b2c') {
        const country = EXACT_COUNTRY_NAMES[countryCode];
        if (!country) return null;
        const match = vatCodes.find(
            (code) =>
                String(code.Description).trim().endsWith(`OSS - ${country}`) &&
                (included ? /incl\./.test(code.Description) : /excl\./.test(code.Description)) &&
                Math.round(Number(code.Percentage) * 10000) / 100 === percent,
        );
        return match ? String(match.Code).trim() : null;
    }

    return null;
}
