import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchDocuments } from './appUrl.js';

// Shows an invoice card with download buttons on the order page in the customer account:
// the invoice, plus a button for every credit note (refund).
// Same layout as Shopify's own status cards: icon tile, title, grey text, buttons.
//
// The links come from the invoice app, which checks who is logged in. They only work for this customer
// and expire after a few minutes, so they are fetched again every 5 minutes while the page is open.

const REFRESH_MINUTES = 5;

export default async () => {
    render(<OrderInvoice />, document.body);
};

function OrderInvoice() {
    const { i18n } = shopify;
    const orderId = shopify.order.value?.id;
    const [document, setDocument] = useState(undefined); // undefined = loading, null = no invoice yet
    const [failed, setFailed] = useState(false);
    const [loggedOut, setLoggedOut] = useState(false);

    useEffect(() => {
        const load = () =>
            fetchDocuments(orderId)
                .then(({ documents }) => {
                    setDocument(documents[0] ?? null);
                    setFailed(false);
                })
                .catch((error) => (error.status === 401 ? setLoggedOut(true) : setFailed(true)));
        load();
        const timer = setInterval(load, REFRESH_MINUTES * 60 * 1000);
        return () => clearInterval(timer);
    }, [orderId]);

    // Not logged in (e.g. a guest): show nothing, invoices are only for the logged-in customer
    if (loggedOut) return null;

    const subtitle = failed
        ? i18n.translate('error')
        : document === undefined
          ? i18n.translate('loading')
          : document
            ? i18n.translate('number', { number: document.invoice.number })
            : i18n.translate('notReady');

    return (
        <s-section>
            <s-stack gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                    <s-box padding="base" border="base" borderRadius="base">
                        <s-icon type="note" />
                    </s-box>
                    <s-stack gap="none">
                        <s-heading>{i18n.translate('heading')}</s-heading>
                        <s-text color="subdued">{subtitle}</s-text>
                    </s-stack>
                </s-stack>

                {document && !failed && (
                    <s-stack direction="inline" gap="small-200">
                        <s-button href={document.invoice.url} target="_blank" variant="secondary">
                            {i18n.translate('download')}
                        </s-button>
                        {document.creditNotes.map((creditNote) => (
                            <s-button key={creditNote.number} href={creditNote.url} target="_blank" variant="secondary">
                                {i18n.translate('creditNote', { number: creditNote.number })}
                            </s-button>
                        ))}
                    </s-stack>
                )}
            </s-stack>
        </s-section>
    );
}
