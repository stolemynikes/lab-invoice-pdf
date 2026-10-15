import { exact } from '../config.js';
import { get } from '../exact/exactClient.js';

// Read-only check of the Exact connection: which administration, and which VAT codes exist there.
// The VAT code list is what the accountant uses to fill in which code belongs to which situation.

if (!exact.division) {
    console.log('Fill in EXACT_DIVISION in .env (run npm run exact-connect to see the codes).');
    process.exit(1);
}

const [division] = await get(exact, `/api/v1/${exact.division}/system/Divisions?$select=Code,Description&$filter=Code eq ${Number(exact.division)}`);
console.log(`Administration: ${exact.division} ${division?.Description ?? '(not found)'}\n`);

const vatCodes = await get(exact, `/api/v1/${exact.division}/vat/VATCodes?$select=Code,Description,Percentage`);
console.log(`VAT codes (${vatCodes.length}):`);
vatCodes.sort((a, b) => String(a.Code).trim().localeCompare(String(b.Code).trim(), 'nl', { numeric: true }));
for (const vat of vatCodes) {
    const percentage = `${Math.round(Number(vat.Percentage) * 1000) / 10}%`;
    console.log(`  ${String(vat.Code).trim().padEnd(5)} ${percentage.padStart(6)}  ${vat.Description}`);
}
