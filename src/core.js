// Shopify products -> a Notion database the whole team can read, filter and comment on (merch, marketing, ops),
// kept in sync incrementally. Plain JS, no imports: build.mjs pastes it into the n8n Code nodes; tests run the same code.

const DEFAULTS = {
  shop: 'your-store.myshopify.com',
  databaseId: 'NOTION_DATABASE_ID',
  lowStock: 5,
  startFrom: '2000-01-01T00:00:00Z', // first run syncs everything updated after this
};
const cfgOf = (c) => ({ ...DEFAULTS, ...(c || {}) });
const gidNum = (gid) => String(gid || '').split('/').pop();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const select = (s) => String(s || '').replace(/,/g, ' ').trim().slice(0, 100); // Notion select names can't contain commas

// Shopify search for products changed since the watermark. ">=" so a product sharing the watermark's timestamp is
// never skipped; re-reading it is harmless because unchanged pages are not written.
const productsSearch = (since) => `updated_at:>='${since}'`;

// GraphQL product node -> the values we store.
function productValues(p, c) {
  const cfg = cfgOf(c);
  const price = p.priceRangeV2 && p.priceRangeV2.minVariantPrice;
  const inv = p.tracksInventory === false ? null : num(p.totalInventory);
  return {
    'Name': p.title || '(untitled)',
    'Shopify ID': gidNum(p.id),
    'Status': select({ ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived' }[p.status] || p.status),
    'Vendor': select(p.vendor),
    'Type': select(p.productType),
    'Price': price ? num(price.amount) : null,
    'Inventory': inv,
    'Low stock': inv !== null && inv <= cfg.lowStock && p.status === 'ACTIVE',
    'Store URL': p.onlineStoreUrl || null,
    'Admin URL': `https://${cfg.shop}/admin/products/${gidNum(p.id)}`,
  };
}

// Values -> Notion property payload (database property types: title, rich_text, select, number, checkbox, url, date).
function toNotion(v, updatedAt) {
  const text = (s) => [{ type: 'text', text: { content: String(s).slice(0, 2000) } }];
  return {
    'Name': { title: text(v['Name']) },
    'Shopify ID': { rich_text: text(v['Shopify ID']) },
    'Status': { select: v['Status'] ? { name: v['Status'] } : null },
    'Vendor': { select: v['Vendor'] ? { name: v['Vendor'] } : null },
    'Type': { select: v['Type'] ? { name: v['Type'] } : null },
    'Price': { number: v['Price'] },
    'Inventory': { number: v['Inventory'] },
    'Low stock': { checkbox: !!v['Low stock'] },
    'Store URL': { url: v['Store URL'] },
    'Admin URL': { url: v['Admin URL'] },
    'Last change': { date: updatedAt ? { start: updatedAt } : null },
  };
}

// Existing Notion page properties -> the same simple values, to compare.
function fromNotion(props) {
  const p = props || {};
  const plain = (arr) => (arr || []).map((t) => t.plain_text != null ? t.plain_text : (t.text && t.text.content) || '').join('');
  const sel = (x) => (x && x.select && x.select.name) || '';
  return {
    'Name': plain(p['Name'] && p['Name'].title),
    'Shopify ID': plain(p['Shopify ID'] && p['Shopify ID'].rich_text),
    'Status': sel(p['Status']), 'Vendor': sel(p['Vendor']), 'Type': sel(p['Type']),
    'Price': p['Price'] ? p['Price'].number : null,
    'Inventory': p['Inventory'] ? p['Inventory'].number : null,
    'Low stock': !!(p['Low stock'] && p['Low stock'].checkbox),
    'Store URL': (p['Store URL'] && p['Store URL'].url) || null,
    'Admin URL': (p['Admin URL'] && p['Admin URL'].url) || null,
  };
}

function changedFields(want, have) {
  return Object.keys(want).filter((k) => (want[k] ?? '') !== (have[k] ?? ''));
}

// One product + the Notion query result for its Shopify ID -> the Notion request to make, or null if up to date.
function planWrite(product, found, c) {
  const cfg = cfgOf(c);
  const want = productValues(product, cfg);
  const page = found && found.results && found.results[0];
  if (!page) return { action: 'create', id: want['Shopify ID'], method: 'POST', url: 'https://api.notion.com/v1/pages',
    body: { parent: { database_id: cfg.databaseId }, properties: toNotion(want, product.updatedAt) }, changed: Object.keys(want) };
  const changed = changedFields(want, fromNotion(page.properties));
  if (!changed.length) return null;
  return { action: 'update', id: want['Shopify ID'], method: 'PATCH', url: `https://api.notion.com/v1/pages/${page.id}`,
    body: { properties: toNotion(want, product.updatedAt) }, changed };
}

// Where the next run starts: the last product's updatedAt (results are sorted by UPDATED_AT ascending). With more
// pages left, the next run simply continues from there, so a big first sync spreads over a few runs.
function nextWatermark(products, prev) {
  let w = prev;
  for (const p of products || []) if (!w || p.updatedAt > w) w = p.updatedAt;
  return w;
}

// @export
if (typeof module !== 'undefined') module.exports = { DEFAULTS, productsSearch, productValues, toNotion, fromNotion, changedFields, planWrite, nextWatermark };
