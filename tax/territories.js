// Works out whether a delivery address is inside the EU VAT area.
// For goods, VAT depends on where the package arrives, so we use the shipping address.

const EU_COUNTRIES = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
    'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

// Places that belong to an EU country but are NOT in the EU VAT area
function excludedArea(country, zip, province) {
    if (country === 'ES') {
        if (['GC', 'TF'].includes(province) || /^3[58]/.test(zip)) return 'Canary Islands';
        if (province === 'CE' || zip.startsWith('51')) return 'Ceuta';
        if (province === 'ML' || zip.startsWith('52')) return 'Melilla';
    }
    if (country === 'FI' && zip.startsWith('22')) return 'Åland Islands';
    if (country === 'FR' && zip.startsWith('97')) return 'French overseas territory';
    if (country === 'DE' && zip === '27498') return 'Heligoland';
    if (country === 'DE' && zip === '78266') return 'Büsingen am Hochrhein';
    if (country === 'IT' && zip === '23041') return 'Livigno';
    if (country === 'IT' && ['22060', '22061'].includes(zip)) return "Campione d'Italia";
    if (country === 'GR' && ['63086', '63087'].includes(zip)) return 'Mount Athos';
    return null;
}

// Returns { inEU, vatCountry, note }
// vatCountry is the country code used for VAT ('XI' for Northern Ireland)
export function findTerritory({ countryCode, zip, provinceCode }) {
    const country = (countryCode || '').toUpperCase();
    const cleanZip = (zip || '').replace(/\s+/g, '').toUpperCase();
    const province = (provinceCode || '').toUpperCase();

    // Northern Ireland follows EU VAT rules for goods
    if (country === 'GB' && cleanZip.startsWith('BT')) {
        return { inEU: true, vatCountry: 'XI', note: 'Northern Ireland – EU VAT rules apply to goods' };
    }
    // Monaco counts as France for VAT
    if (country === 'MC') {
        return { inEU: true, vatCountry: 'FR', note: 'Monaco – treated as France for VAT' };
    }
    // Shopify gives Åland its own country code
    if (country === 'AX') {
        return { inEU: false, vatCountry: 'AX', note: 'Åland Islands – outside the EU VAT area' };
    }

    const excluded = excludedArea(country, cleanZip, province);
    if (excluded) {
        return { inEU: false, vatCountry: country, note: `${excluded} – outside the EU VAT area` };
    }

    return { inEU: EU_COUNTRIES.has(country), vatCountry: country, note: null };
}
