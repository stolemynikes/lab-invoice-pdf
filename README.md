# Invoice Generator

Creates a legal invoice (PDF) automatically for every paid order in our Shopify store.
Built for a Dutch B.V. that sells to consumers and businesses across Europe.

## How it works

1. A customer pays for an order in Shopify.
2. Shopify sends the order to this app (a "webhook").
3. The app checks the order:
   - **Where is it delivered?** Netherlands, another EU country, or outside the EU.
   - **Is it a business?** If the customer entered a VAT number, it is checked with the official EU service (VIES).
4. The app gives the invoice the next number (`INV-2026-00001`, `INV-2026-00002`, ...).
5. The PDF is saved in the invoice folder (this can be the NAS).
6. A download link is saved on the order in Shopify, so the customer can download it.

## VAT situations

| Situation | Example | What the invoice shows |
|---|---|---|
| `domestic` | Customer in the Netherlands | Dutch btw (21% / 9%) |
| `eu_b2c` | Consumer in Germany | German VAT (19%), paid via OSS |
| `eu_b2b` | Company in Belgium with a valid VAT number | 0% + "Intra-Community supply" text + their VAT number |
| `export` | UK, Switzerland, Norway, Canary Islands | 0% + "Export outside the EU" text |

The VAT **amounts** always come from Shopify (what the customer actually paid).
If something looks wrong, for example VAT charged on an export, the invoice is still made, but the app prints a **warning** in the log so you can check it.

Special places are handled automatically: Northern Ireland counts as EU, while the Canary Islands, Ceuta, Melilla, Åland, Heligoland, Büsingen, Livigno, Campione and the French overseas territories count as outside the EU.

## What is on every invoice (Dutch law)

- Invoice number (sequential, no gaps) and invoice date
- Order number and order date
- Our full company name, statutory seat (statutaire zetel), address, KvK number and VAT number
- Customer name and address (plus their VAT number for business sales)
- Every product: quantity, description, price excl. VAT, discount, VAT rate
- VAT summary per rate, total excl. VAT, total VAT, total incl. VAT
- Legal text for 0% sales (intra-Community supply / export)

## Setup

You need [Node.js](https://nodejs.org) version 24 or newer.

```
npm install
```

Then fill in your details in the `.env` file. Use `.env.example` as a guide.

| Setting | What to put there |
|---|---|
| `SELLER_...` | Company details printed on the invoice. Use the exact name from the KvK, including "B.V." |
| `SHOPIFY_STORE_DOMAIN` | e.g. `your-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Shopify Dev Dashboard → your app → **Settings** → Client ID |
| `SHOPIFY_CLIENT_SECRET` | Same page: **Client secret** (starts with `shpss_`). Also used to check that webhooks really come from Shopify. |
| `INVOICE_PDF_DIR` | Folder for the PDFs, e.g. `\\NAS\invoices` |
| `DATABASE_PATH` | The invoice-number database. Keep it on a **local disk**, not on the NAS (see below). |

The app asks Shopify for its own access token with the client ID and secret (it works for 24 hours and is renewed automatically). There is no `shpat_` token to copy.

The Shopify app needs these permissions (scopes): `read_orders` and `write_orders` (for saving the download link on the order). After changing scopes, release a new app version and approve it in the store.

Check the connection (read-only, changes nothing):

```
npm run check-shopify
```

**Never share `.env` or upload it to GitHub.** It is already listed in `.gitignore`.

## Commands

```
npm test                                              # run all checks
npm run generate -- fixtures/order-nl-consumer.json   # make a test invoice from a sample order
npm run generate -- fixtures/*.json                   # make test invoices from all samples
npm run designs                                       # make all invoice designs + a page to pick one
npm start                                             # start the app (for the Shopify webhooks)
```

Test invoices use the `DEMO` number series and are saved in `./output`, so they never use up real invoice numbers.
Orders that Shopify marks as test orders get the `TEST-INV` series.

## Saving invoices on the NAS

Set `INVOICE_PDF_DIR` to the NAS share. Invoices are saved per year:

```
\\NAS\invoices\2026\INV-2026-00001.pdf
\\NAS\invoices\2026\INV-2026-00001.json   <- backup of the invoice data
```

- Keep the **database** (`DATABASE_PATH`) on the computer that runs the app, not on the NAS. The database does not work reliably over a network share. Back it up regularly.
- If the NAS is offline when an invoice is made, the invoice number is still saved. The PDF is created again the next time the order comes in.
- Dutch law requires keeping invoices for **7 years**, unchanged.

## Webhook and download links

- Webhook address for Shopify (topic **Order payment**): `https://<your app address>/webhooks/orders-paid`
- Download links look like `https://<your app address>/invoices/INV-2026-00001/download?token=...`.
  The token is a signature, so nobody can open someone else's invoice by changing the number.
- The link is saved on the Shopify order as the metafield `invoice.download_url`. You can show it on the order status page or in the shipping confirmation email.

Shopify must be able to reach the app over the internet (HTTPS). If the app runs on a computer in the office next to the NAS, you need a tunnel (for example Cloudflare Tunnel) or port forwarding.

## Folder structure

```
index.js                  start of the app (Express server)
config.js                 reads the settings from .env
routes/
  webhooksRoute.js        receives paid orders from Shopify
  invoicesRoute.js        customer downloads the PDF
invoice/
  createInvoice.js        the full flow for one order
  buildInvoice.js         Shopify order -> invoice lines, VAT totals, legal text
  invoiceStore.js         invoice numbers + database
  downloadLinks.js        signed download links
  money.js                amounts in cents, formatting
tax/
  classifyOrder.js        which VAT situation the order is in
  territories.js          which addresses are inside the EU VAT area
  vies.js                 checks EU VAT numbers with VIES
pdf/
  renderInvoice.js        draws the PDF
shopify/
  shopifyClient.js        access token, checks webhooks, saves the link on the order
scripts/
  generateFromFile.js     make a test invoice from a JSON file
  checkShopify.js         test the connection to the store
fixtures/                 sample Shopify orders
test/                     automatic checks
```

## Not built yet

- **Credit notes** for refunds. A sent invoice must never be changed, so refunds need their own credit note with its own number.
- A **"Download invoice" button** in the customer account (Shopify customer account extension).
- B2B customers entering their **VAT number at checkout**. The app reads it from an order attribute named "VAT number" (or "btw nummer", "VAT ID" and similar).

This app follows the Dutch and EU invoice rules as well as we could, but it is not legal advice. Let your accountant check a few sample invoices before going live.
