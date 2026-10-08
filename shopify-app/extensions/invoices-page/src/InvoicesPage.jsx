import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchDocuments } from './appUrl.js';

// An extra "Facturen" page in the customer account:
// every order of the logged-in customer with its invoice and credit notes, per date, with a search field.
//
// The list comes from the invoice app, which checks who is logged in and only sends back that customer's
// own documents. The download links expire after a few minutes, so they are fetched again every 5 minutes.

const REFRESH_MINUTES = 5;

export default async () => {
    render(<InvoicesPage />, document.body);
};

function InvoicesPage() {
    const { i18n } = shopify;
    const [documents, setDocuments] = useState(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState('');

    useEffect(() => {
        const load = () =>
            fetchDocuments()
                .then((result) => {
                    setDocuments(result.documents);
                    setFailed(false);
                })
                .catch(() => setFailed(true));
        load();
        const timer = setInterval(load, REFRESH_MINUTES * 60 * 1000);
        return () => clearInterval(timer);
    }, []);

    const visible = (documents ?? []).filter((document) => matchesSearch(document, query));

    return (
        <s-page heading={i18n.translate('heading')} subheading={i18n.translate('subheading')}>
            {failed && <s-banner tone="critical">{i18n.translate('error')}</s-banner>}
            {!failed && documents === null && <s-spinner />}
            {documents?.length === 0 && <s-text color="subdued">{i18n.translate('empty')}</s-text>}

            {documents?.length > 0 && (
                <s-text-field
                    label={i18n.translate('search')}
                    icon="search"
                    value={query}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                />
            )}
            {documents?.length > 0 && visible.length === 0 && <s-text color="subdued">{i18n.translate('noResults')}</s-text>}

            <s-stack gap="large">
                {groupByDate(visible).map(({ date, documents: ofThisDay }) => (
                    <s-stack key={date} gap="base">
                        <s-heading>{formatDay(date)}</s-heading>
                        {ofThisDay.map((document) => (
                            <OrderInvoices key={document.orderId} document={document} />
                        ))}
                    </s-stack>
                ))}
            </s-stack>
        </s-page>
    );
}

function OrderInvoices({ document }) {
    const { i18n } = shopify;
    const total = i18n.formatCurrency(document.total / 100, { currency: document.currency });

    return (
        <s-section>
            <s-stack gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                    <s-box padding="base" border="base" borderRadius="base">
                        <s-icon type="note" />
                    </s-box>
                    <s-stack gap="none">
                        <s-heading>{i18n.translate('order', { name: document.orderName })}</s-heading>
                        <s-text color="subdued">{total}</s-text>
                    </s-stack>
                </s-stack>

                <s-stack direction="inline" gap="small-200">
                    <s-button href={document.invoice.url} target="_blank" variant="secondary">
                        {i18n.translate('invoice', { number: document.invoice.number })}
                    </s-button>
                    {document.creditNotes.map((creditNote) => (
                        <s-button key={creditNote.number} href={creditNote.url} target="_blank" variant="secondary">
                            {i18n.translate('creditNote', { number: creditNote.number })}
                        </s-button>
                    ))}
                </s-stack>
            </s-stack>
        </s-section>
    );
}

// Search on order number, date or invoice/credit note number.
// The search text must match from the start of a word: "2 oktober" does not find "12 oktober".
function matchesSearch(document, query) {
    const search = query.toLowerCase().trim().replace(/\s+/g, ' ');
    if (!search) return true;

    const [year, month, day] = document.orderDate.split('-');
    const numbers = [document.orderName, document.invoice.number, ...document.creditNotes.map((creditNote) => creditNote.number)];
    const text = [
        ...numbers,
        ...numbers.map((number) => number.replace(/[-/#]/g, ' ')), // "INV-2026-00000006" -> "inv 2026 00000006"
        ...numbers.map((number) => number.replace(/^[^\d]+/, '')), // "LD1004" -> "1004"
        `${year}-${month}-${day}`,
        `${day}-${month}-${year}`,
        `${Number(day)}-${Number(month)}-${year}`,
        `${day}/${month}/${year}`,
        formatDay(document.orderDate), // "Donderdag 8 oktober 2026"
    ].join(' ');
    return ` ${text.toLowerCase().replace(/\s+/g, ' ')} `.includes(` ${search}`);
}

// Orders of the same day under one date heading (newest first, as the invoice app sends them)
function groupByDate(documents) {
    const groups = [];
    for (const document of documents) {
        const last = groups[groups.length - 1];
        if (last?.date === document.orderDate) last.documents.push(document);
        else groups.push({ date: document.orderDate, documents: [document] });
    }
    return groups;
}

// "2026-10-08" -> "Donderdag 8 oktober 2026" (in the language of the customer)
function formatDay(date) {
    const text = shopify.i18n.formatDate(new Date(`${date}T12:00:00`), {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
    return text.charAt(0).toUpperCase() + text.slice(1);
}
