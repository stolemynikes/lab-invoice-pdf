import { exact } from '../config.js';
import { authorizeUrl, codeFromInput, exchangeCode, get } from '../exact/exactClient.js';

// One-time login to Exact Online. Only reads, never changes anything in Exact.
//
//   npm run exact-connect                    -> shows the address to log in
//   npm run exact-connect -- "<address>"     -> finishes the login with the address from the address bar

const input = process.argv[2];

if (!exact.clientId || !exact.clientSecret) {
    console.log('Fill in EXACT_CLIENT_ID and EXACT_CLIENT_SECRET in .env first.');
    process.exit(1);
}

if (!input) {
    console.log('1. Open this address in your browser and log in to Exact:\n');
    console.log(`   ${authorizeUrl(exact)}\n`);
    console.log('2. Exact then opens a page that does not load ("site cannot be reached"). That is fine.');
    console.log('3. Copy the whole address from the address bar and run, within a few minutes:\n');
    console.log('   npm run exact-connect -- "<the address>"');
    process.exit(0);
}

const code = codeFromInput(input);
if (!code) {
    console.log('No code found in that address. Copy the whole address from the address bar.');
    process.exit(1);
}

await exchangeCode(exact, code);
console.log(`Connected. The login is saved in ${exact.tokenPath} (keep this file private).\n`);

const [me] = await get(exact, '/api/v1/current/Me?$select=FullName,CurrentDivision');
console.log(`Logged in as: ${me.FullName}`);

const divisions = await get(exact, `/api/v1/${me.CurrentDivision}/system/Divisions?$select=Code,Description`);
console.log('\nAdministrations you can reach (EXACT_DIVISION = the code):');
for (const division of divisions) {
    const current = division.Code === me.CurrentDivision ? '  <- opened last' : '';
    console.log(`  ${String(division.Code).padEnd(10)} ${division.Description}${current}`);
}
