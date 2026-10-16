import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/InvoicesPage.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.page.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/appUrl.js' {
  const shopify: import('@shopify/ui-extensions/customer-account.page.render').Api;
  const globalThis: { shopify: typeof shopify };
}
