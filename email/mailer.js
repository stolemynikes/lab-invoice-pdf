import nodemailer from 'nodemailer';

// Sends e-mails through the mailbox facturen@... (SMTP, e.g. Hostnet). The settings come from .env.
// Returns null when e-mail is switched off, so the rest of the app simply skips sending.
export function createMailer(email) {
    if (!email.enabled) return null;

    const transport = nodemailer.createTransport({
        host: email.host,
        port: email.port,
        secure: email.port === 465, // port 465 = encrypted from the start, port 587 = STARTTLS
        requireTLS: email.port !== 465, // never send the password or invoices unencrypted
        auth: { user: email.user, pass: email.password },
        connectionTimeout: 20_000,
    });

    return {
        // message: { to, subject, text, html, attachments }
        send: (message) =>
            transport.sendMail({
                from: email.from,
                replyTo: email.replyTo || undefined,
                bcc: email.bcc || undefined,
                ...message,
            }),
        // Checks the connection and password without sending anything
        verify: () => transport.verify(),
    };
}
