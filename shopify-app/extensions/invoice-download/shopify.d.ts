import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/OrderInvoice.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/appUrl.js' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
