import { findTerritory } from './territories.js';

// Decides which VAT situation an order is in:
//   'domestic'  - delivered in the Netherlands -> Dutch btw
//   'eu_b2c'    - consumer elsewhere in the EU -> VAT of that country (via OSS)
//   'eu_b2b'    - business in another EU country with a valid VAT number -> 0% intra-Community supply
//   'export'    - delivered outside the EU -> 0% export
export function classifyOrder({ sellerCountry, shipTo, vatCheck }) {
    const territory = findTerritory(shipTo);
    const warnings = [];

    if (!territory.inEU) {
        warnings.push(...exportWarnings(territory.vatCountry));
        return { scenario: 'export', territory, warnings };
    }

    if (territory.vatCountry === sellerCountry) {
        return { scenario: 'domestic', territory, warnings };
    }

    if (vatCheck) {
        if (vatCheck.status === 'valid' && vatCheck.prefix !== sellerCountry) {
            if (vatCheck.prefix !== territory.vatCountry) {
                warnings.push(
                    `Customer VAT number ${vatCheck.vatId} is from a different country than the delivery address (${territory.vatCountry}). Check that this is correct.`,
                );
            }
            return { scenario: 'eu_b2b', territory, warnings };
        }
        warnings.push(
            `Customer gave VAT number ${vatCheck.vatId}, but it could not be confirmed (${vatCheck.status}). Treated as a consumer sale.`,
        );
    }

    return { scenario: 'eu_b2c', territory, warnings };
}

function exportWarnings(country) {
    if (country === 'GB') {
        return ['UK order: for orders of £135 or less, UK VAT is due from the seller (UK VAT registration). Check with your accountant.'];
    }
    if (country === 'NO') {
        return ['Norway order: low-value goods (under NOK 3,000) fall under the VOEC scheme. Check with your accountant.'];
    }
    return [];
}
