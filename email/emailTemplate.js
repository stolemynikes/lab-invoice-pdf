// The e-mail that comes with an invoice or credit note: subject, plain text and a simple HTML version.
// English for everyone (EMAIL_LANGUAGE=en, the default). With EMAIL_LANGUAGE=auto, customers in the
// Netherlands and Belgium get Dutch and everyone else English.
// Everything that comes from Shopify (names, order numbers) is escaped, so nobody can put code in the e-mail.

const TEXTS = {
    nl: {
        locale: 'nl-NL',
        invoiceSubject: 'Factuur {number} – bestelling {order}',
        creditSubject: 'Creditnota {number} – bestelling {order}',
        greeting: 'Beste {name},',
        fallbackName: 'klant',
        invoiceIntro: 'Bedankt voor je bestelling {order} bij {shop}. In de bijlage vind je de factuur ({number}) als PDF.',
        invoiceAmount: 'Bedrag: {amount}, betaald op {date}.',
        creditIntro: 'In de bijlage vind je de creditnota ({number}) voor je bestelling {order}.',
        creditAmount: 'Er is {amount} teruggestort via je oorspronkelijke betaalmethode.',
        account: 'Heb je een account? Dan vind je al je facturen ook terug in je account, onder Facturen.',
        questions: 'Dit e-mailadres kan geen berichten ontvangen. Vragen? Neem contact op via {contact}.',
        closing: 'Met vriendelijke groet,',
    },
    en: {
        locale: 'en-IE',
        invoiceSubject: 'Invoice {number} – order {order}',
        creditSubject: 'Credit note {number} – order {order}',
        greeting: 'Dear {name},',
        fallbackName: 'customer',
        invoiceIntro: 'Thank you for your order {order} at {shop}. Attached you will find the invoice ({number}) as a PDF.',
        invoiceAmount: 'Amount: {amount}, paid on {date}.',
        creditIntro: 'Attached you will find the credit note ({number}) for your order {order}.',
        creditAmount: '{amount} has been refunded to your original payment method.',
        account: 'Do you have an account? Then you can also find all your invoices in your account, under Invoices.',
        questions: 'This e-mail address cannot receive replies. Questions? Please contact us at {contact}.',
        closing: 'Kind regards,',
    },
};

function emailLanguage(document, setting = 'en') {
    if (setting !== 'auto') return TEXTS[setting] ? setting : 'en';
    const country = document.buyer?.countryCode || document.shipTo?.countryCode;
    return ['NL', 'BE'].includes(String(country).toUpperCase()) ? 'nl' : 'en';
}

// withLogo: show the logo at the top. It is attached to the e-mail as an image with Content-ID "logo".
export function buildDocumentEmail(document, seller, { language = 'en', withLogo = false } = {}) {
    const lang = emailLanguage(document, language);
    const t = TEXTS[lang];
    const isCredit = document.kind === 'credit_note';
    const shop = seller.tradeName || seller.legalName;
    const money = (cents) => new Intl.NumberFormat(t.locale, { style: 'currency', currency: document.currency }).format(cents / 100);
    const day = (date) =>
        new Intl.DateTimeFormat(t.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

    const values = {
        number: document.number,
        order: document.orderName,
        shop,
        name: document.buyer?.name?.trim() || t.fallbackName,
        amount: money(Math.abs(isCredit ? document.refundedAmount ?? document.totals.gross : document.totals.gross)),
        date: day(document.paidDate || document.issueDate),
        contact: [seller.email, seller.phone].filter(Boolean).join(' / '),
    };
    const fill = (template) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

    const paragraphs = [
        fill(t.greeting),
        isCredit ? fill(t.creditIntro) : fill(t.invoiceIntro),
        isCredit ? fill(t.creditAmount) : fill(t.invoiceAmount),
        t.account,
        fill(t.questions),
    ];
    const footer = [seller.legalName, seller.kvkNumber && `KvK ${seller.kvkNumber}`, seller.vatId && `VAT ${seller.vatId}`, seller.website]
        .filter(Boolean)
        .join(' · ');

    // No line breaks in the subject: they could be used to add extra e-mail headers
    const subject = fill(isCredit ? t.creditSubject : t.invoiceSubject).replace(/[\r\n]+/g, ' ');

    const text = `${paragraphs.join('\n\n')}\n\n${t.closing}\n${shop}\n\n--\n${footer}\n`;

    const html = `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:'Open Sans',Arial,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.55;">
    <div style="background:#ffffff;border:1px solid #dedede;border-radius:12px;padding:28px;">
      ${withLogo
          ? `<img src="cid:logo" alt="${escapeHtml(shop)}" width="240" style="display:block;width:240px;max-width:100%;height:auto;margin:0 0 22px;border:0;">`
          : `<div style="font-size:20px;font-weight:600;color:#1e4475;margin-bottom:20px;">${escapeHtml(shop)}</div>`}
${paragraphs.map((p) => `      <p style="margin:0 0 14px;">${escapeHtml(p)}</p>`).join('\n')}
      <p style="margin:20px 0 0;">${escapeHtml(t.closing)}<br>${escapeHtml(shop)}</p>
    </div>
    <p style="margin:14px 0 0;font-size:12px;color:#707070;text-align:center;">${escapeHtml(footer)}</p>
  </div>
</body>
</html>
`;

    return { subject, text, html, filename: `${document.number}.pdf` };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
