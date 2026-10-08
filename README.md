# Invoice Generator

Creates a legal invoice (PDF) automatically for every paid order in a Shopify store, and a credit note for every refund.
Built for a Dutch B.V. that sells to consumers and businesses across Europe.

## Contents

- [How it works](#how-it-works)
- [Installing on a new computer](#installing-on-a-new-computer) (step by step)
- [Settings (.env)](#settings-env)
- [Commands](#commands)
- [The Shopify app (buttons for the customer)](#the-shopify-app-buttons-for-the-customer)
- [E-mail to the customer](#e-mail-to-the-customer)
- [Security](#security)
- [Going live: hosting](#going-live-hosting)
- [Go-live checklist](#go-live-checklist)
- [Invoice rules](#invoice-rules)
- [Folder structure](#folder-structure)
- [Problems and solutions](#problems-and-solutions)

## How it works

1. A customer pays for an order in Shopify.
2. Shopify sends the order to this app (a "webhook").
3. The app checks the order:
   - **Where is it delivered?** Netherlands, another EU country, or outside the EU.
   - **Is it a business?** If the customer entered a VAT number, it is checked with the official EU service (VIES).
4. The app gives the invoice the next number (`INV-2026-00000001`, `INV-2026-00000002`, ...).
5. The PDF is saved in the invoice folder (this can be the NAS).
6. The invoice number is saved on the order in Shopify (as a safety net). The logged-in customer can download the invoice from their account.

When (part of) an order is refunded, the same happens with a **credit note** (`CN-2026-00000001`, ...).

The invoice number is made **once**, at payment. Downloading the invoice only opens the saved PDF: it never makes a new number and never changes anything.

The project has two parts:

| Part | What it does | Where it runs |
|---|---|---|
| **Invoice app** (this folder) | Makes the PDFs and numbers, keeps the archive | On your own computer, NAS or server |
| **Shopify app** (`shopify-app/`) | Shows the download buttons to the customer | At Shopify (uploaded with `shopify app deploy`) |

---

## Installing on a new computer

Follow these steps in order. Everything is done in a terminal (on Windows: PowerShell) in the project folder.

### 1. Install the programs

- [Node.js](https://nodejs.org) **version 24 or newer** (check with `node --version`)
- For the Shopify app later: nothing extra, the Shopify CLI is installed with step 3

> **Windows:** if `npm` gives the error *"running scripts is disabled on this system"*, type `npm.cmd` instead of `npm`, or run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 2. Copy the project

Copy the whole project folder to the new computer, **except**:

- `node_modules/` (is made again in step 3)
- `.env` (contains secrets, make a new one in step 4)
- `data/` and `output/` (invoices and test files)

> Moving an existing shop to a new computer? Then **do** copy `data/invoices.db` (the invoice numbers) and the PDF folder. Without the database, the numbering would start again at 1 and you would get duplicate invoice numbers.

### 3. Install the packages

```
npm install
```

### 4. Make the settings file

Copy `.env.example` to `.env` and fill it in. See [Settings (.env)](#settings-env) for what each setting means.

Make a new secret for the download links:

```
node -e "console.log(crypto.randomBytes(32).toString('hex'))"
```

Put the result in `INVOICE_LINK_SECRET`. **Use a new secret per shop and never change it afterwards**: changing it makes all existing download links stop working.

### 5. Make the Shopify app and connect it

1. Go to the **Shopify Dev Dashboard** (dev.shopify.com) and create an app.
2. Give it these permissions (scopes): `read_orders`, `write_orders`.
3. Release the app version and install it on the store.
4. Copy the **Client ID** and **Client secret** (starts with `shpss_`) to `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, and the store address (`something.myshopify.com`) to `SHOPIFY_STORE_DOMAIN`.

The app asks Shopify for its own access token with the client ID and secret (valid for 24 hours, renewed automatically). There is no `shpat_` token to copy.

Check the connection (read-only, changes nothing):

```
npm run check-shopify
```

You should see: `Connected to "<shop name>" (<store>.myshopify.com)`.

### 6. Test without touching the shop

```
npm test                                  # all automatic checks should pass
npm run generate -- fixtures/*.json       # makes sample invoices in ./output/2026/
npm run designs                           # makes the design picker: open output/designs/index.html
```

Open a few PDFs in `output/2026/` and check the company details. Choose a design in the picker and paste the four `DESIGN_...` lines into `.env`.

These test invoices use the `DEMO` number series, so they never use up real invoice numbers.

### 7. Test with a real (test) order

Place a test order in the shop (with the Shopify test payment method), then:

```
npm run invoice-order -- <order name, e.g. LD1004>
```

This makes the invoice (and credit notes for refunds), saves the PDF and puts the download link on the order. Shopify test orders get the `TEST-INV` / `TEST-CN` series.

After changing the design or company details, make the test documents again with:

```
npm run invoice-order -- <order name> --redo-test
```

This only works for test orders. Real invoices can never be made again or removed.

### 8. Go live

See [Going live: hosting](#going-live-hosting) and the [Go-live checklist](#go-live-checklist).

---

## Settings (.env)

| Setting | What to put there |
|---|---|
| `SELLER_LEGAL_NAME` | Exact name from the KvK, including "B.V." (e.g. `HD Beverwijk Trading B.V.`) |
| `SELLER_TRADE_NAME` | Shop name, if it differs from the legal name. Printed as "... is a trade name of ..." |
| `SELLER_REGISTERED_SEAT` | Statutaire zetel: the city in the articles of association (on the KvK extract) |
| `SELLER_ADDRESS_LINE1/2`, `SELLER_COUNTRY` | Business address |
| `SELLER_KVK`, `SELLER_VAT_ID` | KvK number and btw-id (`NL…B01`, **not** the omzetbelastingnummer) |
| `SELLER_IBAN`, `SELLER_BIC`, `SELLER_EMAIL`, `SELLER_PHONE`, `SELLER_WEBSITE` | Printed in the footer |
| `SHOPIFY_STORE_DOMAIN` | e.g. `your-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | From the Dev Dashboard (see step 5) |
| `PORT` / `PUBLIC_URL` | Port of the app, and the public address used in download links |
| `INVOICE_LINK_SECRET` | Long random text that signs the download links (see step 4) |
| `INVOICE_PDF_DIR` | Folder for the PDFs, e.g. `\\NAS\invoices` |
| `DATABASE_PATH` | The invoice-number database. Keep it on a **local disk**, not on a network share |
| `INVOICE_SERIES` / `CREDIT_NOTE_SERIES` | Number prefixes, default `INV` and `CN` |
| `INVOICE_NUMBER_DIGITS` | Digits after the year (8 gives `INV-2026-00000001`). **Only change before the first real invoice** |
| `VIES_ENABLED` | Check customer VAT numbers with the EU (`true`/`false`) |
| `BRAND_LOGO` | Logo file: SVG (sharpest), PNG or JPG |
| `BRAND_LOGO_TEXT` | Name written next to the logo icon in Open Sans. Leave empty if the logo file already contains the name |
| `BRAND_COLOR` | Logo colour, used for the navy accents. Keep the quotes: `"#1e4475"` |
| `DESIGN_HEADER/TABLE/TOTAL/ACCENT` | The design, chosen with `npm run designs` |

Two things to know about `.env`:

- **`#` starts a comment.** Put quotes around values with a `#`, like colours: `BRAND_COLOR="#1e4475"`.
- **Close `.env` in your editor before someone else (or Claude) changes it**, otherwise saving your old copy overwrites their changes.

**Never share `.env` or upload it to GitHub.** It is listed in `.gitignore`.

---

## Commands

```
npm test                                              # run all checks
npm run check-shopify                                 # test the connection to the store (read-only)
npm run generate -- fixtures/order-nl-consumer.json   # make a sample invoice from a sample order
npm run generate -- fixtures/*.json                   # make sample invoices from all samples
npm run designs                                       # make all invoice designs + a page to pick one
npm run invoice-order -- LD1004                       # make the invoice + credit notes for an existing order
npm run invoice-order -- LD1004 --redo-test           # test orders only: make them again (e.g. after a design change)
npm run catch-up                                      # make every invoice/credit note that is still missing (the app also does this every hour)
npm run restore                                       # after data loss: shows what can be restored (changes nothing)
npm run restore -- --apply                            # ...and restores it
npm run security-check                                # known vulnerabilities in the packages or Node.js? (only looks)
npm run test-email -- you@example.com                 # send one test e-mail with a sample invoice (checks the mailbox)
npm start                                             # start the app (for the Shopify webhooks)
```

---

## The Shopify app (buttons for the customer)

The folder `shopify-app/` contains two extensions for the customer account. They run at Shopify itself.

| Extension | What the customer sees |
|---|---|
| `invoice-download` | A "Factuur" card on the order page, with buttons for the invoice and every credit note |
| `invoices-page` | An extra "Facturen" page: all invoices per date, with a search field (order number, date or invoice number) |

Local previews (open in the browser, nothing is live): `output/preview-order-page.html`, `output/preview-facturen.html`, `output/preview-menu.html`.

### Uploading the extensions to Shopify

```
cd shopify-app
npm install
npx shopify app config link     # connect to your app in the Dev Dashboard (log in once)
npx shopify app deploy          # upload the extensions
```

Then, in the Shopify admin:

1. **Settings → Checkout and accounts → Customer accounts → Customize**: place the "Factuur downloaden" block on the order page.
2. Add the "Facturen" page to the customer account menu.

### Before deploying: the app address

Both extensions ask the invoice app for the customer's documents. Put the public address of the invoice app (the same as `PUBLIC_URL`) in **`src/appUrl.js`** of both extensions before running `shopify app deploy`.

### The "Facturen" button in the website menu

The account menu on the website (Bestellingen / Profiel) is part of the **theme**, not of this app. Add a third button there that links to the Facturen page. See `output/preview-menu.html` for how it looks.

---

## E-mail to the customer

Every invoice and credit note is e-mailed to the e-mail address of the order, with the PDF attached, in English (`EMAIL_LANGUAGE=en`; `auto` gives Dutch for NL/BE). It is sent from `EMAIL_FROM` (e.g. `facturen@laboratoriumdiscounter.nl`), and `EMAIL_BCC` can send a copy to your bookkeeping.

**facturen@ is a no-reply address.** Nobody reads that mailbox, so the e-mail says: *"This e-mail address cannot receive replies. Questions? Please contact us at info@… / phone"*. As a safety net, `EMAIL_REPLY_TO=info@laboratoriumdiscounter.nl`: a customer who presses Reply anyway ends up at info@. Leave `EMAIL_REPLY_TO` empty to switch that off. Also set an **auto-reply** on the facturen@ mailbox (Hostnet control panel), for people who mail that address directly.

- **Never twice:** every document gets at most one e-mail, also when Shopify sends a webhook twice.
- **Mail server down?** The e-mail stays in the queue and the catch-up tries again every hour (at most 10 times).
- **Switch it on in steps:**
  1. Create the mailbox (e.g. at Hostnet) and fill in the `SMTP_...` settings. Hostnet: `smtp.hostnet.nl`, port `587`.
  2. Test it: `npm run test-email -- you@example.com` (works while e-mail is still off). Without a mailbox: add `--save` to get the exact e-mail as `output/test-email.eml`.
  3. Make sure your domain has **SPF and DKIM** for the mail server (Hostnet control panel → DNS / e-mail authentication), otherwise e-mails end up in spam.
  4. Set `EMAIL_ENABLED=true`.
- Preview: `output/preview-email.html`.

## Security

### Who can see and download an invoice

- **Only the logged-in customer who placed the order.** The buttons are only in the customer account. They ask the invoice app for documents and send along the **session token** that Shopify gives the logged-in customer. The app checks that token (signed by Shopify with the app's client secret) and only sends back that customer's own invoices and credit notes.
- **Download links work for 10 minutes, for that customer only.** A forwarded or leaked link is quickly useless, and changing the number, customer or time in a link makes it invalid.
- **No download links are stored in Shopify.** The order only keeps the invoice number, date and credit note numbers (for the restore script).
- **Guest checkouts** (no account) cannot download invoices from an account. They need an account, or the invoice by e-mail.
- A brake stops anyone from trying many links or tokens (rate limit), and PDFs are never cached or passed on to other websites.
- Webhooks are only accepted with Shopify's signature, and never bigger than 5 MB.

### Protection against attacks (injection and the like)

| Attack | Protection |
|---|---|
| **SQL injection** | Every database query uses fixed queries with separate values (prepared statements). Text from outside is never put into a query. |
| **Reading or writing other files** (`../`) | Document numbers have one strict format (`SERIES-YEAR-DIGITS`) everywhere they are used as file names or looked up. Anything else is refused. The download only serves files whose path is in the database. |
| **Fake logins** | Session tokens are checked with Shopify's signature (HS256 with the client secret), for this app and this shop only. Unsigned tokens (`"alg":"none"`) are refused. |
| **Fake webhooks** | Checked with Shopify's signature, compared in constant time. |
| **Guessing links or numbers** | Signed links, the same answer for every failure (nobody can find out which numbers exist), and a rate limit. |
| **Header injection / XSS** | Numbers cannot contain line breaks or quotes; the app only sends JSON and PDFs, with strict protection headers. |
| **Leaking details** | Error messages never show internal details; links are never passed on (no referrer) or cached. |
| **Weak settings** | The app refuses to start without a long link secret, valid series, or an `https://` address. |

All of these are tested in `test/invoice.test.js` ("attacks"). New vulnerabilities are found in packages and Node.js all the time, also in versions that are safe today. `npm run security-check` checks the installed packages against npm's list of known vulnerabilities and looks for Node.js security releases. On the Synology it runs every week by itself and e-mails you only when something is found ([docs/synology-nl.md](docs/synology-nl.md), step 9). Updating stays a manual step with `npm test`, so an update can never change the invoices unnoticed.

### Protecting the NAS (Synology)

The invoice app must be reachable from the internet, **the NAS itself must not**.

1. **Open nothing in the router.** Use **Cloudflare Tunnel**: it only lets traffic through to the app's port, and only to `/webhooks`, `/api` and `/invoices`. DSM itself stays unreachable from outside.
2. **Turn off QuickConnect and remote DSM access** if you do not need them, or at least turn on **2-step verification** for every DSM account.
3. **Give the app only the invoice folder.** Run it in Container Manager with only the shared folder for invoices (and its database folder) mounted, as a separate DSM user without admin rights.
4. **Limit who can open the invoice folder** on the network (GDPR): only the people who need it.
5. **Snapshots** (Snapshot Replication, Btrfs) on the invoice folder, so ransomware cannot destroy the archive, plus **Hyper Backup** to a location outside the office, encrypted.
6. **Keep DSM and the app up to date** (automatic DSM security updates on).
7. **Keep `.env` private**: it contains the client secret and the link secret. Only the app's user may read it.

## Going live: hosting

Shopify must be able to reach the invoice app over the internet (HTTPS) for two things: sending webhooks, and customers downloading PDFs. Options:

1. **On the NAS** (recommended when you have one that runs Docker, e.g. Synology or QNAP), with **Cloudflare Tunnel** (free) so nothing has to be opened in the router. PDFs land directly on the NAS. **Step-by-step guide for Synology (in Dutch): [docs/synology-nl.md](docs/synology-nl.md)**, using `Dockerfile` and `docker-compose.yml`.
2. **On a computer in the office** that is always on, also with Cloudflare Tunnel.
3. **On a cloud server** (e.g. a VPS of about €5 a month). Copy the PDFs to the NAS as a backup.

Then:

1. Set `PUBLIC_URL` to the public address (e.g. `https://facturen.yourshop.nl`).
2. Start the app with `npm start` (keep it running, e.g. as a service or Docker container).
3. In the Dev Dashboard, add two webhook subscriptions:
   - topic `orders/paid` → `https://<your address>/webhooks/orders-paid`
   - topic `refunds/create` → `https://<your address>/webhooks/refunds-create`
4. Place a test order and check that the invoice appears by itself.

### When the app was off: the catch-up

When the app starts, and then every hour (`CATCH_UP_MINUTES`), it asks Shopify which orders changed and makes every invoice and credit note that is still missing. It also retries download links that could not be saved in Shopify (e.g. when the internet was down). So after a power cut, an internet problem or a restart, everything fixes itself.

- Orders from before the first day the app was used (or `INVOICE_START_DATE`) never get an invoice, so old orders are never invoiced by accident.
- Run it by hand with `npm run catch-up`. One order by hand: `npm run invoice-order -- <order name>`.

### When the data is lost: the restore

If the database (and maybe the PDF folder) is lost and there is no backup:

```
npm run restore              # shows what would be restored, changes nothing
npm run restore -- --apply   # restores it
```

It uses, best source first:

1. **The JSON copies next to the PDFs** (exact originals), if the PDF folder still exists.
2. **Shopify**: every order keeps its invoice number, date and credit note numbers in metafields. The document is rebuilt from the order data with that same number, and gets a warning to check it against the bookkeeping.

It never overwrites anything and the numbering continues after the highest restored number, so a number is never used twice.

> Shopify only shows the last 60 days of orders unless the app has the `read_all_orders` permission. Add that scope if you ever need to restore older invoices.

### Archive and backups

PDFs are saved per year, with a JSON copy of the data next to each one:

```
\\NAS\invoices\2026\INV-2026-00000001.pdf
\\NAS\invoices\2026\INV-2026-00000001.json
```

- Dutch law requires keeping invoices for **7 years**, unchanged and readable.
- Keep a **second copy somewhere else** (cloud backup of the NAS, or a disk at another location).
- **Back up the database** (`DATABASE_PATH`) too. Without it, numbering could start again and give duplicate numbers.
- Invoices contain personal data (GDPR): limit who can open the folder.
- If the NAS is offline when an invoice is made, the number is still saved and the PDF is made again the next time.

---

## Go-live checklist

- [ ] All company details in `.env` are filled in (no `TODO` left; the app refuses to start otherwise)
- [ ] **Btw is set up in Shopify** (Settings → Taxes and duties): Netherlands, and OSS for EU countries
- [ ] Test order with VAT checked: the invoice shows the right rate and amounts
- [ ] Test refund checked: the credit note matches
- [ ] `INVOICE_NUMBER_DIGITS` and the series are final (they cannot change after the first real invoice)
- [ ] App is hosted, `PUBLIC_URL` is set, both webhooks are registered
- [ ] `src/appUrl.js` in both extensions has the app address, extensions are deployed and placed in the customer account
- [ ] NAS protected: nothing open in the router, 2-step verification on DSM, snapshots + Hyper Backup (see Security)
- [ ] **Mailbox `facturen@laboratoriumdiscounter.nl`** created at Hostnet, `SMTP_PASSWORD` in `.env`, `npm run test-email -- <your address>` arrives (not in spam), SPF + DKIM set, then `EMAIL_ENABLED=true`
- [ ] **Auto-reply on facturen@** (Hostnet control panel): *"This address is not monitored. Please e-mail info@laboratoriumdiscounter.nl."*
- [ ] Backups of the PDF folder and the database are running
- [ ] Accountant has checked a few sample invoices

---

## Invoice rules

### What is on every invoice (Dutch and EU law)

- Invoice number (sequential, no gaps) and invoice date
- Payment date ("Paid in full on ..."), because the customer pays before delivery
- Legal name with B.V., statutory seat, address, KvK number and VAT number
- Customer name and address (plus their VAT number for business sales)
- Every product: quantity, description, price excl. VAT, discount, VAT rate
- VAT summary per rate, total excl. VAT, total VAT, total incl. VAT
- Legal text for 0% sales (intra-Community supply / export)

### VAT situations

The shipping address decides which situation applies:

| Situation | Example | What the invoice shows |
|---|---|---|
| `domestic` | Customer in the Netherlands | Dutch btw (21% / 9%) |
| `eu_b2c` | Consumer in Germany | German VAT (19%), declared via OSS |
| `eu_b2b` | Company in Belgium with a valid VAT number | 0% + "Intra-Community supply" text + their VAT number |
| `export` | UK, Switzerland, Norway, Canary Islands | 0% + "Export outside the EU" text |

The VAT **amounts** always come from Shopify (what the customer actually paid). If something looks wrong, for example VAT charged on an export, the invoice is still made, but the app prints a **warning** in the log.

Special places are handled automatically: Northern Ireland counts as EU, while the Canary Islands, Ceuta, Melilla, Åland, Heligoland, Büsingen, Livigno, Campione and the French overseas territories count as outside the EU.

Business customers enter their VAT number at checkout in an order attribute named "VAT number" (or "btw nummer", "VAT ID" and similar).

### Credit notes

A sent invoice may never be changed. For every refund the app makes a credit note:

- Its own number series, and it refers to the original invoice (number and date)
- Refunded products and shipping with negative quantities and amounts, VAT per rate
- One credit note per refund; a refund that paid nothing back (only restock) gets none
- Warning when the credit note does not match the amount Shopify refunded

### Numbers

- No gaps: `INV-2026-00000001`, `INV-2026-00000002`, ... Dashes and the prefix are fine; a **missing number** is a gap.
- The series restarts every year.
- Test orders use their own series (`TEST-INV`, `TEST-CN`, `DEMO`), so they never cause gaps.

This app follows the Dutch and EU invoice rules as well as we could, but it is not legal advice. Let your accountant check a few sample invoices before going live.

---

## Folder structure

```
index.js                  start of the app (Express server)
config.js                 reads the settings from .env
routes/
  webhooksRoute.js        receives paid orders and refunds from Shopify
  invoicesRoute.js        customer downloads the PDF (checks the link)
  apiRoute.js             documents of the logged-in customer (checks the session token)
  rateLimit.js            brake against trying many links
invoice/
  createInvoice.js        the full flow for one order
  createCreditNote.js     the full flow for one refund
  processOrder.js         everything one order needs (invoice, credit notes, links)
  catchUp.js              the hourly catch-up
  buildInvoice.js         Shopify order -> invoice lines, VAT totals, legal text
  buildCreditNote.js      Shopify refund -> credit note lines with negative amounts
  invoiceStore.js         invoice and credit note numbers + database
  downloadLinks.js        download links per customer, valid 10 minutes
  sessionToken.js         checks who is logged in
  money.js                amounts in cents, formatting
tax/
  classifyOrder.js        which VAT situation the order is in
  territories.js          which addresses are inside the EU VAT area
  vies.js                 checks EU VAT numbers with VIES
pdf/
  renderInvoice.js        draws the PDF (all designs)
shopify/
  shopifyClient.js        access token, webhooks check, Shopify API calls
  documentNumbers.js      saves the invoice numbers on the order (safety net for the restore)
scripts/
  generateFromFile.js     make a sample invoice from a JSON file
  invoiceOrder.js         make the invoice + credit notes for an existing order
  catchUp.js              make everything that is still missing
  restoreFromShopify.js   rebuild the database after data loss
  securityCheck.js        known vulnerabilities in packages or Node.js (only looks)
  checkShopify.js         test the connection to the store
  makeDesigns.js          make all designs for the picker
  designPicker.html       the design picker page
assets/
  logo-icon.svg           logo icon (vector)
  fonts/                  Open Sans (website font)
Dockerfile, docker-compose.yml   run the app on a Synology (or any Docker host)
docs/synology-nl.md       step-by-step Synology guide (Dutch)
shopify-app/
  extensions/invoice-download/   "Factuur" card on the order page
  extensions/invoices-page/      "Facturen" page with search
fixtures/                 sample Shopify orders and a refund
test/                     automatic checks
```

---

## Problems and solutions

| Problem | Solution |
|---|---|
| `npm : ... running scripts is disabled on this system` | Use `npm.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once |
| App does not start: "Please fix these settings in your .env file first" | Fill in the settings it lists |
| `Connection failed` with `check-shopify` | Check the store domain, client ID and secret, and that the app is installed on the store |
| A colour in `.env` does nothing | Put quotes around it: `BRAND_COLOR="#1e4475"` |
| My `.env` changes disappeared | The file was open in an editor with an old copy. Close and reopen it before editing |
| A downloaded invoice has the old design | Invoices keep the look they had when they were made. For test orders: `--redo-test` |
| VS Code asks about `python.terminal.useEnvFile` | Choose "Don't show again" and keep it off. This is not a Python project |
