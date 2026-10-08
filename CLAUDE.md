# CLAUDE.md

Guidance for Claude Code when working in this repository. Read `README.md` for the full setup and the invoice rules.

## What this is

An invoice generator for a Shopify store run by a Dutch B.V. that sells B2C and B2B across Europe (EUR only).
For every paid order it makes a legal invoice PDF; for every refund a credit note. PDFs go to a folder (often a NAS),
numbers are kept in a SQLite database, and download links are saved on the Shopify order as metafields.

Two parts:

- **Invoice app** (repo root): plain JavaScript (ES modules), Node 24+, Express, PDFKit, `node:sqlite`. Runs on the shop's own machine, NAS or server.
- **Shopify app** (`shopify-app/`): customer account UI extensions (Preact + Shopify web components, API `2026-07`). Runs at Shopify after `shopify app deploy`.

## Commands

```
npm test                                   # vitest, all tests must pass
npm run check-shopify                      # read-only connection test
npm run generate -- fixtures/*.json        # sample invoices in ./output (DEMO series)
npm run designs                            # all designs + picker in ./output/designs
npm run invoice-order -- <name>            # invoice + credit notes for a real Shopify order
npm run invoice-order -- <name> --redo-test  # test orders only
npm run catch-up                           # make missing invoices/credit notes (the server also runs this hourly)
npm run restore [-- --apply]               # rebuild the database from JSON copies + Shopify metafields
npm run security-check                     # known vulnerabilities in packages / Node.js; exit 1 when found
npm run test-email -- <address>            # one test e-mail (sends a REAL e-mail; only with the owner's OK)
npm start                                  # Express server (webhooks + downloads + hourly catch-up)
```

On Windows PowerShell, `npm` may be blocked by the execution policy; use `npm.cmd` or `node scripts/<file>.js`.

To check the Shopify extensions compile (there is no build step without a linked app):

```
cd shopify-app && npx esbuild extensions/<name>/src/<File>.jsx --bundle --format=esm --jsx=automatic --jsx-import-source=preact --outfile=<scratch file>
```

## Code style

- **Plain JavaScript, no TypeScript.** The owner reads the code and wants it simple, in the style of a basic Express project: `index.js`, `config.js`, `routes/xRoute.js`.
- Short `//` comments in plain English that explain *why*. README and user-facing text in plain, non-technical language.
- All money is **integer cents**. Use `toCents`, `formatMoney`, `sum` from `invoice/money.js`. Never use floats for amounts.
- Dates on documents are Dutch time (`dutchDate`).
- Settings only come from `.env` through `config.js`.

## Rules that must never be broken

1. **An issued real invoice or credit note never changes.** Not the data, not the number. Corrections are made with a credit note. `deleteTestInvoice` refuses anything that does not start with `TEST-`; keep it that way.
2. **Numbers are gapless and unique per series and year.** They are assigned in `InvoiceStore` inside `BEGIN IMMEDIATE` transactions. Issuing is idempotent per order (invoice) and per refund (credit note), because Shopify can send webhooks twice.
3. **Downloading never creates anything.** The download route only serves the stored PDF.
4. **VAT amounts come from Shopify** (what the customer paid). The classification (`tax/classifyOrder.js`) only picks the legal text and raises warnings when amounts and situation disagree. Do not recalculate VAT.
5. **Test data stays out of the real series.** Shopify test orders use `TEST-INV` / `TEST-CN`; sample files use `DEMO` in `./output`.
6. **Secrets stay secret.** Never print or paste values from `.env` (client secret, link secret). When checking settings, show only the prefix or length. Never commit `.env`.
7. **Nothing goes live without the owner's explicit OK**: no `shopify app deploy`, no theme changes, no webhook registration, no writes to the live store beyond what a command the owner asked for does.
8. **Documents are only for their own customer.** `/api/documents` requires a valid Shopify session token (HS256 with the client secret, `aud` = client id, `dest` = store) and only returns documents whose `customerId` matches. Download links are signed per number + customer + expiry (10 minutes). Never store download URLs in Shopify, never add a download path without these checks, and keep the same 403 answer for every failure.
9. **Untrusted input never reaches SQL, file paths or headers unchecked.** Always use prepared statements with `?` values. Document numbers must pass `isValidDocumentNumber` (`invoice/documentNumber.js`) before they are used as a file name or looked up from a request; `savePdf` and `raiseCounter` enforce it. Keep the "attacks" tests passing and add one for every new input.
10. **E-mails go out once per document, only to the order's own address.** Use the queue in `email/emailQueue.js` (claim → send → mark); never send directly. Escape everything from Shopify in the HTML, keep CR/LF out of subjects and addresses, and never send real e-mails from tests (pass a fake `send`). The sender `facturen@` is a **no-reply** address: e-mail texts must never ask customers to reply, but point them to the shop contact (`SELLER_EMAIL`, info@). `EMAIL_REPLY_TO` (info@) is only a safety net.

## Things that have caused bugs before

- **`#` in `.env` starts a comment.** Colour values must be quoted (`BRAND_COLOR="#1e4475"`). `config.js` falls back to defaults for empty values.
- **The owner often has `.env` open in an editor.** Saving their old copy can silently undo changes. After editing `.env`, re-read it before relying on it, and tell the owner to reopen the file.
- **Escaping in shell heredocs.** Regexes like `/\s+/` lost their backslash when written through `node -e` / heredoc templates. Use the Edit tool for code with backslashes, and grep the result.
- **Invoices keep the look they were made with.** A design change in `.env` only affects new documents; remake test documents with `--redo-test`.
- **PDFKit footer:** text in the bottom margin needs `doc.page.margins.bottom = 0` temporarily, or PDFKit adds a blank page.

## How to check your work

- Run `npm test` after every change.
- For PDF changes, render a sample (`npm run generate -- fixtures/order-nl-consumer.json` or `npm run designs`) and **look at the PDF** (the Read tool shows it as an image). Check both a VAT invoice (`order-nl-consumer`) and an EU business invoice with legal text (`order-be-business`), and a credit note.
- For the local HTML previews in `output/`, take a screenshot with headless Edge/Chrome and look at it.

## Where things are

- Hosting on the Synology DS225+: `Dockerfile`, `docker-compose.yml` (app + Cloudflare Tunnel, no ports exposed), guide in `docs/synology-nl.md` (Dutch, for the owner). Inside the container the paths are `/facturen` (PDFs) and `/data/invoices.db`; `docker-compose.yml` sets them and overrides `.env`.

- Invoice rules, settings, hosting and the go-live checklist: `README.md`
- Data flow: `routes/webhooksRoute.js` / `invoice/catchUp.js` / `scripts/invoiceOrder.js` → `invoice/processOrder.js` → `invoice/createInvoice.js` / `invoice/createCreditNote.js` → `invoice/build*.js` → `invoice/invoiceStore.js` → `pdf/renderInvoice.js`
- Never run `npm run catch-up` or `npm start` against the live store without the owner's OK: it issues real invoice numbers for every paid order since the start date.
- Design options: `DESIGN_OPTIONS` in `pdf/renderInvoice.js`; the picker is built by `scripts/makeDesigns.js`
- Shopify API calls: `shopify/shopifyClient.js` (client-credentials token, REST for orders/refunds, GraphQL for metafields)
