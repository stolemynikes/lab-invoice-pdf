// All amounts are stored as whole cents (1234 = €12.34) to avoid rounding mistakes.

// Shopify sends money as text, e.g. "12.34" -> 1234
export function toCents(value) {
    if (value === null || value === undefined || value === '') return 0;
    const text = String(value).trim();
    const negative = text.startsWith('-');
    const [whole = '0', fraction = ''] = text.replace(/^[-+]/, '').split('.');
    const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
    if (!Number.isFinite(cents)) throw new Error(`Invalid amount: ${value}`);
    return negative ? -cents : cents;
}

// 1234 -> "€12.34"
export function formatMoney(cents, currency = 'EUR') {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100);
}

// 0.21 -> "21%"
export function formatRate(rate) {
    return `${Number((rate * 100).toFixed(2))}%`;
}

export function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

// Date as YYYY-MM-DD in Dutch time
export function dutchDate(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(date);
}
