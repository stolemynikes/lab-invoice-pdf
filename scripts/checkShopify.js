import { shopify } from '../config.js';
import { testConnection } from '../shopify/shopifyClient.js';

// Checks that the app can connect to your Shopify store. It only reads the shop name and changes nothing.
//
//   npm run check-shopify

const missing = ['storeDomain', 'clientId', 'clientSecret'].filter((key) => !shopify[key]);
if (missing.length > 0) {
    console.log('Fill in SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env first.');
    process.exit(1);
}

try {
    const shop = await testConnection(shopify);
    console.log(`Connected to "${shop.name}" (${shop.myshopifyDomain})`);
} catch (error) {
    console.log('Connection failed:', error.message);
    process.exit(1);
}
