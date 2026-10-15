import { get, write, odataText } from './exactClient.js';
import { findCustomerVatId } from '../invoice/buildInvoice.js';

// Makes sure a Shopify customer exists in Exact as a relation WITH a contact person that has the e-mail address.
// Exact e-mails an invoice to the contact person ("factuur aan"); without one the invoice is never sent.

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The customer details Exact needs, taken from a Shopify order
export function customerFromOrder(order) {
    const address = order.billing_address || order.shipping_address || {};
    return {
        email: String(order.email || order.contact_email || '').trim().toLowerCase(),
        company: address.company || null,
        firstName: address.first_name || '',
        lastName: address.last_name || address.name || '',
        addressLine: [address.address1, address.address2].filter(Boolean).join(', '),
        postcode: address.zip || '',
        city: address.city || '',
        countryCode: String(address.country_code || '').toUpperCase(),
        vatId: findCustomerVatId(order) || null,
    };
}

// Finds or creates the relation and its contact person. Returns the ids to put on the invoice.
export async function ensureCustomer(settings, customer) {
    if (!EMAIL.test(customer.email)) throw new Error(`Not a usable e-mail address: ${JSON.stringify(customer.email.slice(0, 80))}`);
    const base = `/api/v1/${settings.division}`;
    const created = { account: false, contact: false };

    // 1. The relation: business customers by VAT number (one relation per company), others by e-mail
    const filter = customer.vatId ? `VATNumber eq ${odataText(customer.vatId)}` : `Email eq ${odataText(customer.email)}`;
    let [account] = await get(settings, `${base}/crm/Accounts?$filter=${filter}&$select=ID,Code,Name,MainContact`);
    if (!account) {
        account = await write(settings, 'POST', `${base}/crm/Accounts`, {
            Name: (customer.company || `${customer.firstName} ${customer.lastName}`.trim() || customer.email).slice(0, 100),
            Status: 'C',
            Email: customer.email,
            AddressLine1: customer.addressLine,
            Postcode: customer.postcode,
            City: customer.city,
            Country: customer.countryCode,
            ...(customer.vatId ? { VATNumber: customer.vatId } : {}),
        });
        created.account = true;
    }
    if (!GUID.test(account.ID)) throw new Error('Exact returned an unexpected relation id');

    // 2. The contact person with this e-mail address
    let [contact] = await get(settings, `${base}/crm/Contacts?$filter=Account eq guid'${account.ID}' and Email eq ${odataText(customer.email)}&$select=ID`);
    if (!contact) {
        contact = await write(settings, 'POST', `${base}/crm/Contacts`, {
            Account: account.ID,
            FirstName: customer.firstName.slice(0, 50),
            LastName: (customer.lastName || customer.company || 'Facturen').slice(0, 50),
            Email: customer.email,
        });
        created.contact = true;
    }
    if (!GUID.test(contact.ID)) throw new Error('Exact returned an unexpected contact id');

    // 3. A relation without a main contact gets this one, so Exact also uses it when invoicing by hand
    if (!account.MainContact) {
        await write(settings, 'PUT', `${base}/crm/Accounts(guid'${account.ID}')`, { MainContact: contact.ID });
    }

    return { accountId: account.ID, contactId: contact.ID, created };
}
