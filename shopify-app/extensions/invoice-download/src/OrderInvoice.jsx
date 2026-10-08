import '@shopify/ui-extensions/preact';
import { render } from 'preact';

// Shows an invoice card with a download button on the order page in the customer account.
// Same layout as Shopify's own status cards: icon tile, title, grey text, button.
// The invoice app saves the link on the order as the metafields invoice.download_url and invoice.number.

export default async () => {
    render(<OrderInvoice />, document.body);
};

function OrderInvoice() {
    const { i18n, appMetafields } = shopify;

    const metafield = (key) =>
        appMetafields.value.find((entry) => entry.metafield.namespace === 'invoice' && entry.metafield.key === key)
            ?.metafield.value;
    const url = metafield('download_url');
    const number = metafield('number');

    return (
        <s-section>
            <s-stack gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                    <s-box padding="base" border="base" borderRadius="base">
                        <s-icon type="note" />
                    </s-box>
                    <s-stack gap="none">
                        <s-heading>{i18n.translate('heading')}</s-heading>
                        <s-text color="subdued">
                            {url ? i18n.translate('number', { number }) : i18n.translate('notReady')}
                        </s-text>
                    </s-stack>
                </s-stack>

                {url && (
                    <s-button href={String(url)} target="_blank" variant="secondary">
                        {i18n.translate('download')}
                    </s-button>
                )}
            </s-stack>
        </s-section>
    );
}
