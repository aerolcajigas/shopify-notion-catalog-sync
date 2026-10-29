# Shopify Catalog to Notion

Keeps a Notion database in sync with the Shopify catalog, so merchandising, marketing and ops can filter, plan and
comment on products in Notion without Shopify admin access.

Each row: **Name, Shopify ID, Status, Vendor, Type, Price, Inventory, Low stock, Store URL, Admin URL, Last change.**
Add your own columns (owner, launch date, notes); the sync never touches them.

```
every 30 min -> Shopify products updated since the last run (GraphQL, oldest first)
             -> find each one's Notion page by Shopify ID
             -> create it, update it only if a synced value changed, or skip it
             -> move the watermark forward
```

## Design

- **Incremental.** Only products changed since the last run are read (`updated_at:>=` watermark kept in workflow
  static data). A big first sync of thousands of products spreads over several runs, 100 at a time, oldest first.
- **Change-only writes.** Existing pages are compared field by field; unchanged pages aren't written, so Notion's
  edit history stays meaningful and the API rate limit isn't wasted.
- **Safe watermark.** It only moves after the Notion writes succeed. If a write fails, the run stops and the next run
  retries the same products.
- **Low stock** is computed (active, tracked inventory at or below `lowStock`) so Notion views like "Low stock,
  active" work out of the box.
- Archived products stay in Notion with status Archived. Deleted products are not removed.
- Logic lives in `src/core.js`, pasted into the Code nodes by `build.mjs`; the tests run the same code.

## Set up

1. **Notion:** create a database with these properties: Name (title), Shopify ID (text), Status, Vendor, Type
   (select), Price, Inventory (number), Low stock (checkbox), Store URL, Admin URL (URL), Last change (date).
   Create an internal integration and share the database with it.
2. **n8n credentials:** Shopify Access Token (`read_products`, `read_inventory`) and Notion API.
3. `cp config.example.json config.json`: shop, database id, credential ids, schedule.
4. `npm run build`, then import `workflows/catalog-sync.json` or `npm run deploy`. Activate it.

```
npm test   # builds the workflow, then 6 tests: mapping, create/update/skip, watermark, Code nodes with mocked n8n
```

Tested with sample payloads and n8n's workflow validator, not against live accounts. Uses Notion API version
2022-06-28. Built with n8n, the Shopify Admin GraphQL API and the Notion API.
