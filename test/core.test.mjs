import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, wf, node, run, checkWiring } from './harness.mjs';

const c = core();
const CFG = { shop: 'demo.myshopify.com', databaseId: 'db1' };
const product = (id, over = {}) => ({
  id: `gid://shopify/Product/${id}`, title: `Mug ${id}`, status: 'ACTIVE', vendor: 'Kiln, Co', productType: 'Mugs',
  totalInventory: 12, tracksInventory: true, updatedAt: `2026-10-30T10:0${id % 10}:00Z`, onlineStoreUrl: `https://demo.example/products/mug-${id}`,
  priceRangeV2: { minVariantPrice: { amount: '24.0', currencyCode: 'USD' } }, ...over,
});
// What Notion returns for a page created from toNotion(): plain_text instead of text.content.
const asNotionPage = (pageId, props) => ({
  id: pageId,
  properties: Object.fromEntries(Object.entries(props).map(([k, v]) => {
    if (v.title) return [k, { title: v.title.map((t) => ({ plain_text: t.text.content })) }];
    if (v.rich_text) return [k, { rich_text: v.rich_text.map((t) => ({ plain_text: t.text.content })) }];
    return [k, v];
  })),
});

test('product values: status names, comma-free selects, numbers, low stock only when active and tracked', () => {
  const v = c.productValues(product(1, { totalInventory: 3 }), CFG);
  assert.equal(v['Shopify ID'], '1');
  assert.equal(v['Status'], 'Active');
  assert.equal(v['Vendor'], 'Kiln  Co');
  assert.equal(v['Price'], 24);
  assert.equal(v['Low stock'], true);
  assert.equal(v['Admin URL'], 'https://demo.myshopify.com/admin/products/1');
  assert.equal(c.productValues(product(2, { totalInventory: 3, status: 'DRAFT' }), CFG)['Low stock'], false);
  const untracked = c.productValues(product(3, { tracksInventory: false, totalInventory: 0 }), CFG);
  assert.equal(untracked['Inventory'], null);
  assert.equal(untracked['Low stock'], false);
});

test('new product -> create a page in the database', () => {
  const w = c.planWrite(product(1), { results: [] }, CFG);
  assert.equal(w.action, 'create');
  assert.equal(w.method, 'POST');
  assert.equal(w.body.parent.database_id, 'db1');
  assert.equal(w.body.properties['Name'].title[0].text.content, 'Mug 1');
  assert.deepEqual(w.body.properties['Status'], { select: { name: 'Active' } });
  assert.deepEqual(w.body.properties['Last change'], { date: { start: '2026-10-30T10:01:00Z' } });
});

test('unchanged page -> no write; changed values -> PATCH with the changed field list', () => {
  const p = product(1);
  const page = asNotionPage('page-1', c.toNotion(c.productValues(p, CFG), p.updatedAt));
  assert.equal(c.planWrite(p, { results: [page] }, CFG), null);
  const w = c.planWrite({ ...p, totalInventory: 2, title: 'Mug 1 (blue)' }, { results: [page] }, CFG);
  assert.equal(w.action, 'update');
  assert.equal(w.method, 'PATCH');
  assert.equal(w.url, 'https://api.notion.com/v1/pages/page-1');
  assert.deepEqual(w.changed.sort(), ['Inventory', 'Low stock', 'Name']);
});

test('empty Notion selects compare equal to missing values', () => {
  const p = product(4, { vendor: '', productType: '' });
  const page = asNotionPage('page-4', c.toNotion(c.productValues(p, CFG), p.updatedAt));
  assert.equal(page.properties['Vendor'].select, null);
  assert.equal(c.planWrite(p, { results: [page] }, CFG), null);
});

test('watermark moves to the newest updatedAt seen, or stays', () => {
  assert.equal(c.nextWatermark([product(1), product(3), product(2)], '2026-01-01T00:00:00Z'), '2026-10-30T10:03:00Z');
  assert.equal(c.nextWatermark([], '2026-01-01T00:00:00Z'), '2026-01-01T00:00:00Z');
  assert.equal(c.productsSearch('2026-10-30T10:03:00Z'), "updated_at:>='2026-10-30T10:03:00Z'");
});

test('workflow: wiring, and the watermark only moves once writes are done', () => {
  const w = wf('catalog-sync');
  checkWiring(w);
  const staticData = {};
  const [since] = run(node(w, 'Since'), [{}], { staticData });
  assert.equal(since.since, '2000-01-01T00:00:00Z');

  const products = run(node(w, 'Products'), [{ data: { products: { pageInfo: { hasNextPage: false }, nodes: [product(1), product(2)] } } }]);
  assert.equal(products.length, 2);

  const p1 = products[0];
  const page1 = asNotionPage('page-1', c.toNotion(c.productValues(p1, { shop: 'your-store.myshopify.com' }), p1.updatedAt));
  const plans = run(node(w, 'Plan Changes'), [{ results: [page1] }, { results: [] }], { nodes: { Products: products, Since: [since] }, staticData });
  assert.deepEqual(plans.map((p) => p.action), ['create']);
  assert.equal(staticData.since, undefined, 'not saved before the write');
  const [done] = run(node(w, 'Save Watermark'), [{}], { nodes: { 'Plan Changes': plans }, staticData });
  assert.equal(staticData.since, '2026-10-30T10:02:00Z');
  assert.deepEqual([done.created, done.updated], [1, 0]);

  // Nothing to write: Plan Changes saves the watermark itself.
  const quiet = {};
  run(node(w, 'Plan Changes'), [{ results: [page1] }], { nodes: { Products: [p1], Since: [since] }, staticData: quiet });
  assert.equal(quiet.since, '2026-10-30T10:01:00Z');
  assert.throws(() => run(node(w, 'Products'), [{ errors: [{ message: 'Throttled' }] }]), /Throttled/);
});
