// Generates workflows/catalog-sync.json from src/core.js + config.json (or config.example.json).
//   node build.mjs [--deploy]   (--deploy needs env N8N_API_URL, N8N_API_KEY)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadCore, makeBuilder, GQL_CHECK, deploy } from './lib/n8n.mjs';

const here = (p) => new URL(p, import.meta.url);
const cfg = JSON.parse(readFileSync(here(existsSync(here('config.json')) ? 'config.json' : 'config.example.json'), 'utf8'));
const { credentials: C, apiVersion, everyMinutes, ...logic } = cfg;
const b = makeBuilder({ core: loadCore(here('src/core.js')), config: logic });
const NOTION_HEADERS = { 'Notion-Version': '2022-06-28' };

const PRODUCTS_Q = `query($q: String!) { products(first: 100, query: $q, sortKey: UPDATED_AT) { pageInfo { hasNextPage } nodes {
  id title status vendor productType totalInventory tracksInventory updatedAt onlineStoreUrl
  priceRangeV2 { minVariantPrice { amount currencyCode } } } } }`.replace(/\s+/g, ' ');

// Write -> Save Watermark only runs when something was written, so "Plan Changes" saves it itself when nothing was.
// If a Notion write fails the execution stops before the watermark moves, and the next run retries those products.
const wf = b.workflow('Notion / Shopify Catalog Sync', [
  b.schedule(`Every ${everyMinutes} Minutes`, { field: 'minutes', minutesInterval: everyMinutes }),
  b.code('Since', `
const store = $getWorkflowStaticData('global');
const since = store.since || CONFIG.startFrom;
return [{ json: { since, q: productsSearch(since) } }];`),
  b.http('Get Changed Products', { credType: 'shopifyAccessTokenApi', cred: C.shopify, method: 'POST',
    url: `https://${logic.shop}/admin/api/${apiVersion}/graphql.json`,
    jsonBody: `={{ JSON.stringify({ query: ${JSON.stringify(PRODUCTS_Q)}, variables: { q: $json.q } }) }}` }),
  b.code('Products', `${GQL_CHECK}
const products = gql($input.first()).products.nodes;
return products.map((p) => ({ json: p }));`),
  b.http('Find Notion Page', { credType: 'notionApi', cred: C.notion, method: 'POST', headers: NOTION_HEADERS,
    url: `https://api.notion.com/v1/databases/${logic.databaseId}/query`,
    jsonBody: `={{ JSON.stringify({ filter: { property: 'Shopify ID', rich_text: { equals: $json.id.split('/').pop() } }, page_size: 1 }) }}` }),
  b.code('Plan Changes', `
const products = $('Products').all().map((i) => i.json);
const writes = $input.all().map((r, i) => planWrite(products[i], r.json, CONFIG)).filter(Boolean);
const watermark = nextWatermark(products, $('Since').first().json.since);
if (!writes.length) $getWorkflowStaticData('global').since = watermark;
return writes.map((w) => ({ json: { ...w, watermark } }));`),
  b.http('Write to Notion', { credType: 'notionApi', cred: C.notion, method: '={{ $json.method }}', headers: NOTION_HEADERS,
    url: '={{ $json.url }}', jsonBody: '={{ JSON.stringify($json.body) }}' }),
  b.code('Save Watermark', `
const plans = $('Plan Changes').all().map((i) => i.json);
$getWorkflowStaticData('global').since = plans[0].watermark;
return [{ json: { created: plans.filter((p) => p.action === 'create').length, updated: plans.filter((p) => p.action === 'update').length, since: plans[0].watermark } }];`),
], 'Shopify products changed since the last run -> create or update their Notion pages (only when a value changed).');

mkdirSync(here('workflows/'), { recursive: true });
writeFileSync(here('workflows/catalog-sync.json'), JSON.stringify(wf, null, 2) + '\n');
console.log('wrote workflows/catalog-sync.json');
if (process.argv.includes('--deploy')) await deploy([wf]);
