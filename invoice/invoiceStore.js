import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dutchDate } from './money.js';

// Gives out invoice numbers and keeps every issued invoice unchanged.
// - Numbers have no gaps: INV-2026-00001, INV-2026-00002, ... (restarts every year)
// - One invoice per order: if Shopify sends the same order twice, you get the existing invoice back
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
        `);
    }

    findByOrder(orderId) {
        const row = this.db.prepare('SELECT data FROM invoices WHERE order_id = ?').get(String(orderId));
        return row ? JSON.parse(row.data) : null;
    }

    findByNumber(number) {
        const row = this.db.prepare('SELECT data FROM invoices WHERE number = ?').get(number);
        return row ? JSON.parse(row.data) : null;
    }

    // Returns { invoice, created }. created = false when the order already had an invoice.
    issue(invoiceData, { series = 'INV', now = new Date() } = {}) {
        const issueDate = dutchDate(now);
        const counterKey = `${series}-${issueDate.slice(0, 4)}`;

        // Lock the database so two orders at the same moment can never get the same number
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const existing = this.findByOrder(invoiceData.orderId);
            if (existing) {
                this.db.exec('COMMIT');
                return { invoice: existing, created: false };
            }

            const row = this.db.prepare('SELECT last_number FROM counters WHERE series = ?').get(counterKey);
            const next = (row?.last_number ?? 0) + 1;
            this.db
                .prepare(
                    'INSERT INTO counters (series, last_number) VALUES (?, ?) ON CONFLICT(series) DO UPDATE SET last_number = excluded.last_number',
                )
                .run(counterKey, next);

            const invoice = { ...invoiceData, number: `${counterKey}-${String(next).padStart(5, '0')}`, issueDate };
            this.db
                .prepare('INSERT INTO invoices (number, order_id, issue_date, data) VALUES (?, ?, ?, ?)')
                .run(invoice.number, invoice.orderId, issueDate, JSON.stringify(invoice));

            this.db.exec('COMMIT');
            return { invoice, created: true };
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    setPdfPath(number, pdfPath) {
        this.db.prepare('UPDATE invoices SET pdf_path = ? WHERE number = ?').run(pdfPath, number);
    }

    getPdfPath(number) {
        return this.db.prepare('SELECT pdf_path FROM invoices WHERE number = ?').get(number)?.pdf_path ?? null;
    }

    close() {
        this.db.close();
    }
}
