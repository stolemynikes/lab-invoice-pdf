import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dutchDate } from './money.js';
import { assertValidDocumentNumber } from './documentNumber.js';

// Gives out invoice and credit note numbers and keeps every issued document unchanged.
// - Numbers have no gaps: INV-2026-1, INV-2026-2, ... (restarts every year, grows by itself: no fixed length)
// - Credit notes have their own series: CN-2026-1, ...
// - One invoice per order and one credit note per refund: if Shopify sends the same thing twice,
//   you get the existing document back
export class InvoiceStore {
    constructor(databasePath) {
        fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
        this.db = new DatabaseSync(databasePath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS counters (
                series TEXT PRIMARY KEY,
                last_number INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS invoices (
                number TEXT PRIMARY KEY,
                order_id TEXT NOT NULL UNIQUE,
                issue_date TEXT NOT NULL,
                data TEXT NOT NULL,
                pdf_path TEXT
            );
            CREATE TABLE IF NOT EXISTS credit_notes (
                number TEXT PRIMARY KEY,
                refund_id TEXT NOT NULL UNIQUE,
                order_id TEXT NOT NULL,
                invoice_number TEXT NOT NULL,
                issue_date TEXT NOT NULL,
                data TEXT NOT NULL,
                pdf_path TEXT
            );
            -- Small things the app has to remember, e.g. when the last catch-up ran
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            -- Orders whose invoice numbers still have to be saved in Shopify (e.g. because the internet was down)
            CREATE TABLE IF NOT EXISTS pending_links (
                order_id TEXT PRIMARY KEY
            );
            -- E-mails with an invoice or credit note: one per document, never sent twice
            CREATE TABLE IF NOT EXISTS email_queue (
                number TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                to_address TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', -- pending, sending, sent, failed
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                sent_at TEXT
            );
        `);
        // An e-mail that was being sent when the app stopped is tried again
        this.db.exec("UPDATE email_queue SET status = 'pending' WHERE status = 'sending'");

        // The first day this database was used. Orders from before that day never get an invoice from the catch-up.
        if (!this.getSetting('first_used')) this.setSetting('first_used', dutchDate(new Date()));
    }

    // ---------- small settings ----------

    getSetting(key) {
        return this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
    }

    setSetting(key, value) {
        this.db
            .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, String(value));
    }

    // ---------- invoice numbers still to be saved in Shopify ----------

    markNumbersPending(orderId) {
        this.db.prepare('INSERT OR IGNORE INTO pending_links (order_id) VALUES (?)').run(String(orderId));
    }

    clearNumbersPending(orderId) {
        this.db.prepare('DELETE FROM pending_links WHERE order_id = ?').run(String(orderId));
    }

    ordersWithPendingNumbers() {
        return this.db.prepare('SELECT order_id FROM pending_links').all().map((row) => row.order_id);
    }

    // ---------- invoices ----------

    findByOrder(orderId) {
        const row = this.db.prepare('SELECT data FROM invoices WHERE order_id = ?').get(String(orderId));
        return row ? JSON.parse(row.data) : null;
    }

    // Returns { invoice, created }. created = false when the order already had an invoice.
    issue(invoiceData, { series = 'INV', now = new Date() } = {}) {
        return this.inTransaction(() => {
            const existing = this.findByOrder(invoiceData.orderId);
            if (existing) return { invoice: existing, created: false };

            const issueDate = dutchDate(now);
            const invoice = { ...invoiceData, number: this.nextNumber(series, issueDate), issueDate };
            this.db
                .prepare('INSERT INTO invoices (number, order_id, issue_date, data) VALUES (?, ?, ?, ?)')
                .run(invoice.number, invoice.orderId, issueDate, JSON.stringify(invoice));
            return { invoice, created: true };
        });
    }

    // ---------- credit notes ----------

    findCreditNoteByRefund(refundId) {
        const row = this.db.prepare('SELECT data FROM credit_notes WHERE refund_id = ?').get(String(refundId));
        return row ? JSON.parse(row.data) : null;
    }

    creditNotesForOrder(orderId) {
        return this.db
            .prepare('SELECT data FROM credit_notes WHERE order_id = ? ORDER BY rowid')
            .all(String(orderId))
            .map((row) => JSON.parse(row.data));
    }

    // Returns { creditNote, created }. created = false when the refund already had a credit note.
    issueCreditNote(creditNoteData, { series = 'CN', now = new Date() } = {}) {
        return this.inTransaction(() => {
            const existing = this.findCreditNoteByRefund(creditNoteData.refundId);
            if (existing) return { creditNote: existing, created: false };

            const issueDate = dutchDate(now);
            const creditNote = { ...creditNoteData, number: this.nextNumber(series, issueDate), issueDate };
            this.db
                .prepare(
                    'INSERT INTO credit_notes (number, refund_id, order_id, invoice_number, issue_date, data) VALUES (?, ?, ?, ?, ?, ?)',
                )
                .run(
                    creditNote.number,
                    creditNote.refundId,
                    creditNote.orderId,
                    creditNote.originalInvoice.number,
                    issueDate,
                    JSON.stringify(creditNote),
                );
            return { creditNote, created: true };
        });
    }

    // ---------- restoring after a crash ----------

    // Puts back a document that already has a number (from a backup or from Shopify).
    // It never overwrites anything, and makes sure the counter continues after the restored number.
    // Returns false when the document was already there.
    restoreDocument(document) {
        return this.inTransaction(() => {
            const isCreditNote = document.kind === 'credit_note';
            const exists = isCreditNote
                ? this.db.prepare('SELECT 1 FROM credit_notes WHERE number = ? OR refund_id = ?').get(document.number, String(document.refundId))
                : this.db.prepare('SELECT 1 FROM invoices WHERE number = ? OR order_id = ?').get(document.number, String(document.orderId));
            if (exists) return false;

            if (isCreditNote) {
                this.db
                    .prepare(
                        'INSERT INTO credit_notes (number, refund_id, order_id, invoice_number, issue_date, data) VALUES (?, ?, ?, ?, ?, ?)',
                    )
                    .run(
                        document.number,
                        String(document.refundId),
                        String(document.orderId),
                        document.originalInvoice.number,
                        document.issueDate,
                        JSON.stringify(document),
                    );
            } else {
                this.db
                    .prepare('INSERT INTO invoices (number, order_id, issue_date, data) VALUES (?, ?, ?, ?)')
                    .run(document.number, String(document.orderId), document.issueDate, JSON.stringify(document));
            }
            this.raiseCounter(document.number);
            return true;
        });
    }

    // ---------- e-mails ----------

    // Puts an e-mail in the queue. Does nothing when this document already has one (sent or not).
    queueEmail(number, orderId, toAddress) {
        this.db
            .prepare('INSERT OR IGNORE INTO email_queue (number, order_id, to_address) VALUES (?, ?, ?)')
            .run(number, String(orderId), toAddress);
    }

    // Numbers of the e-mails that still have to be sent (optionally only for one order)
    pendingEmails(orderId = null) {
        const rows = orderId
            ? this.db.prepare("SELECT number FROM email_queue WHERE status = 'pending' AND order_id = ? ORDER BY rowid").all(String(orderId))
            : this.db.prepare("SELECT number FROM email_queue WHERE status = 'pending' ORDER BY rowid").all();
        return rows.map((row) => row.number);
    }

    // Claims an e-mail for sending. Only one sender can win, so an e-mail is never sent twice at the same time.
    claimEmail(number) {
        const result = this.db
            .prepare("UPDATE email_queue SET status = 'sending', attempts = attempts + 1 WHERE number = ? AND status = 'pending'")
            .run(number);
        if (result.changes !== 1) return null;
        return this.db.prepare('SELECT number, order_id, to_address, attempts FROM email_queue WHERE number = ?').get(number);
    }

    markEmailSent(number) {
        this.db
            .prepare("UPDATE email_queue SET status = 'sent', sent_at = ?, last_error = NULL WHERE number = ?")
            .run(new Date().toISOString(), number);
    }

    // After too many attempts the e-mail is given up (status "failed"), so it is not tried forever
    markEmailFailed(number, error, { maxAttempts = 10 } = {}) {
        this.db
            .prepare("UPDATE email_queue SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, last_error = ? WHERE number = ?")
            .run(maxAttempts, String(error).slice(0, 500), number);
    }

    emailStatus(number) {
        return this.db.prepare('SELECT status, attempts, last_error, sent_at FROM email_queue WHERE number = ?').get(number) ?? null;
    }

    // ---------- for the customer account ----------

    // All invoices of one Shopify customer, newest first, each with its credit notes
    documentsForCustomer(customerId) {
        return this.db
            .prepare("SELECT data FROM invoices WHERE json_extract(data, '$.customerId') = ? ORDER BY issue_date DESC, rowid DESC")
            .all(String(customerId))
            .map((row) => {
                const invoice = JSON.parse(row.data);
                return { invoice, creditNotes: this.creditNotesForOrder(invoice.orderId) };
            });
    }

    // An invoice or credit note by its number
    findDocument(number) {
        const row =
            this.db.prepare('SELECT data FROM invoices WHERE number = ?').get(number) ||
            this.db.prepare('SELECT data FROM credit_notes WHERE number = ?').get(number);
        return row ? JSON.parse(row.data) : null;
    }

    // Is there an invoice or credit note with this number?
    hasDocument(number) {
        return Boolean(
            this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(number) ||
                this.db.prepare('SELECT 1 FROM credit_notes WHERE number = ?').get(number),
        );
    }

    // "INV-2026-00000012" -> the INV-2026 counter becomes at least 12
    raiseCounter(number) {
        assertValidDocumentNumber(number);
        const match = /^(.*-\d{4})-(\d+)$/.exec(number);
        const [, counterKey, digits] = match;
        this.db
            .prepare(
                'INSERT INTO counters (series, last_number) VALUES (?, ?) ON CONFLICT(series) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)',
            )
            .run(counterKey, Number(digits));
    }

    // ---------- test orders ----------

    // Removes the invoice and credit notes of a TEST order, so they can be made again.
    // Real invoices and credit notes can never be removed.
    // Returns the PDF files of the removed documents (so they can be deleted too), or null when there was nothing.
    deleteTestInvoice(orderId) {
        const invoice = this.findByOrder(orderId);
        if (!invoice) return null;
        if (!invoice.number.startsWith('TEST-')) {
            throw new Error(`Invoice ${invoice.number} is a real invoice and can never be removed. Use a credit note instead.`);
        }
        const pdfPaths = [
            ...this.db.prepare('SELECT pdf_path FROM invoices WHERE order_id = ?').all(String(orderId)),
            ...this.db.prepare("SELECT pdf_path FROM credit_notes WHERE order_id = ? AND number LIKE 'TEST-%'").all(String(orderId)),
        ]
            .map((row) => row.pdf_path)
            .filter(Boolean);
        this.db.prepare("DELETE FROM credit_notes WHERE order_id = ? AND number LIKE 'TEST-%'").run(String(orderId));
        this.db.prepare('DELETE FROM invoices WHERE order_id = ?').run(String(orderId));
        return pdfPaths;
    }

    // ---------- PDF files ----------

    setPdfPath(number, pdfPath) {
        this.db.prepare('UPDATE invoices SET pdf_path = ? WHERE number = ?').run(pdfPath, number);
        this.db.prepare('UPDATE credit_notes SET pdf_path = ? WHERE number = ?').run(pdfPath, number);
    }

    // Works for both invoice and credit note numbers
    getPdfPath(number) {
        const row =
            this.db.prepare('SELECT pdf_path FROM invoices WHERE number = ?').get(number) ||
            this.db.prepare('SELECT pdf_path FROM credit_notes WHERE number = ?').get(number);
        return row?.pdf_path ?? null;
    }

    close() {
        this.db.close();
    }

    // ---------- helpers ----------

    // Next number in a series, e.g. INV-2026-3. No leading zeros: the number simply gets longer (…-9, …-10, …-1000).
    // Only call inside inTransaction().
    nextNumber(series, issueDate) {
        const counterKey = `${series}-${issueDate.slice(0, 4)}`;
        const row = this.db.prepare('SELECT last_number FROM counters WHERE series = ?').get(counterKey);
        const next = (row?.last_number ?? 0) + 1;
        this.db
            .prepare(
                'INSERT INTO counters (series, last_number) VALUES (?, ?) ON CONFLICT(series) DO UPDATE SET last_number = excluded.last_number',
            )
            .run(counterKey, next);
        return assertValidDocumentNumber(`${counterKey}-${next}`);
    }

    // Locks the database so two orders at the same moment can never get the same number
    inTransaction(work) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
