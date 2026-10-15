import { get, write, odataText } from './exactClient.js';

// A new Exact article for a Shopify product that is not in Exact yet, filled the way the existing
// articles are (sales + stock article, unit "pc"), plus the product data from the Shopify metafields.
//
// Free text fields in Exact (give them these names in Exact: Stamgegevens > Vrije velden > Artikelen):
//   01 CAS-nummer   02 EG-nummer      03 UN-nummer       04 ADR-klasse        05 Verpakkingsgroep
//   06 Signaalwoord 07 GHS-pictogrammen 08 Transport (LQ) 09 Leverancier      10 Producttype

export const FREE_FIELDS = ['cas', 'eg_nr', 'un_number', 'adr_class', 'packing_group', 'signal_word', 'ghs_pictograms', 'transport', 'leverancier', 'productType'];

// Shopify lists are stored as JSON text: ["GHS02","GHS07"] -> "GHS02, GHS07"
function text(value) {
    if (value == null) return '';
    const raw = String(value).trim();
    if (raw.startsWith('[')) {
        try {
            return JSON.parse(raw).join(', ');
        } catch {
            return raw;
        }
    }
    return raw;
}

const KG = { GRAMS: 0.001, KILOGRAMS: 1, POUNDS: 0.45359237, OUNCES: 0.028349523 };

// Pure: Shopify product details + invoice line -> the Exact article
export function itemFromShopify({ product, variant, fields }, { sku, unitPriceNet, itemGroupId }) {
    const values = { ...fields, productType: product?.productType };
    const variantTitle = variant?.title && variant.title !== 'Default Title' ? variant.title : '';
    const fullTitle = [product?.title, variantTitle].filter(Boolean).join(' – ');

    const facts = [
        ['CAS', fields.cas], ['EG-nr', fields.eg_nr], ['Index-nr', fields.index_nr], ['UN', fields.un_number],
        ['ADR-klasse', fields.adr_class], ['Verpakkingsgroep', fields.packing_group], ['Signaalwoord', fields.signal_word],
        ['GHS', fields.ghs_pictograms], ['Transport', fields.transport], ['Formule', fields.empirical_formula],
        ['Molmassa', fields.molar_mass], ['Vlampunt', fields.flash_point_c], ['WGK', fields.wgk], ['Leverancier', fields.leverancier],
    ]
        .filter(([, value]) => text(value))
        .map(([label, value]) => `${label}: ${text(value)}`);

    const weight = variant?.inventoryItem?.measurement?.weight;
    const kilos = weight?.value ? Math.round(weight.value * (KG[weight.unit] ?? 0) * 1000) / 1000 : null;

    const item = {
        Code: sku,
        Description: (fields.short_title || fullTitle || sku).slice(0, 60),
        ExtraDescription: [fullTitle, ...facts].join('\n').slice(0, 4000),
        IsSalesItem: true,
        IsStockItem: true,
        Unit: 'pc',
        StandardSalesPrice: unitPriceNet / 100,
        ...(itemGroupId ? { ItemGroup: itemGroupId } : {}),
        ...(variant?.barcode ? { Barcode: String(variant.barcode).slice(0, 30) } : {}),
        ...(kilos ? { NetWeight: kilos, GrossWeight: kilos } : {}),
        ...(variant?.inventoryItem?.harmonizedSystemCode ? { StatisticalCode: variant.inventoryItem.harmonizedSystemCode } : {}),
    };
    FREE_FIELDS.forEach((key, index) => {
        const value = text(values[key]);
        if (value) item[`FreeTextField_${String(index + 1).padStart(2, '0')}`] = value.slice(0, 100);
    });
    return item;
}

// The second line under a product on the invoice: variant + identification and transport data,
// e.g. "1 L · Glas · CAS 64-17-5 · EG 200-578-6 · UN 1170 · ADR 3 · VG II"
export function invoiceLineNote({ variant, fields = {} }) {
    const variantTitle = variant?.title && variant.title !== 'Default Title' ? variant.title : '';
    const un = text(fields.un_number);
    return [
        variantTitle,
        text(fields.cas) && `CAS ${text(fields.cas)}`,
        text(fields.eg_nr) && `EG ${text(fields.eg_nr)}`,
        un && (/^UN/i.test(un) ? un : `UN ${un}`),
        text(fields.adr_class) && `ADR ${text(fields.adr_class)}`,
        text(fields.packing_group) && `VG ${text(fields.packing_group)}`,
    ]
        .filter(Boolean)
        .join(' · ');
}

// Which Exact article group: chemicals -> HUISMERKCHEMICALIEN, the rest -> STANDAARD (proposal, see README)
export function itemGroupFor(product) {
    return /chemical/i.test(product?.productType || '') ? 'HUISMERKCHEMICALIEN' : 'STANDAARD';
}

// Creates the article in Exact and returns its id
export async function createItemFromShopify(settings, details, line, cache = {}) {
    const base = `/api/v1/${settings.division}`;
    const groupCode = itemGroupFor(details.product);
    cache.itemGroups ||= new Map();
    if (!cache.itemGroups.has(groupCode)) {
        const [group] = await get(settings, `${base}/logistics/ItemGroups?$filter=Code eq ${odataText(groupCode)}&$select=ID`);
        cache.itemGroups.set(groupCode, group?.ID ?? null);
    }
    const item = itemFromShopify(details, { sku: line.sku, unitPriceNet: line.unitPriceNet, itemGroupId: cache.itemGroups.get(groupCode) });
    const created = await write(settings, 'POST', `${base}/logistics/Items`, item);
    return created.ID;
}
