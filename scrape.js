#!/usr/bin/env node
/**
 * Links of NY — Inventory Scraper
 *
 * Links of NY runs on Shopify (not WooCommerce/Elementor like WPB), which
 * exposes a public JSON API at /products.json. All product attributes
 * (Brand, Reference Number, Dial, Bezel, Bracelet, Condition, Box, Papers,
 * Serial Number, Warranty Card/Date, Link Count, etc.) already live inside
 * each product's body_html as one or more HTML <table> blocks — no
 * per-product page scraping or attribute cache is needed. One paginated
 * API call gets everything in a single pass.
 *
 * Usage:  node scrape.js
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const HISTORY_FILE = path.join(__dirname, "history.json");
const LASTRUN_FILE = path.join(__dirname, "last-run.json");
const SITE_URL     = "https://linksofny.com";
const PAGE_SIZE    = 250;

// ── HTTP ──────────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "LinksOfNYTracker/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error for ${url}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML helpers ─────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&#[0-9]+;/g, "")
    .replace(/&[a-zA-Z]+;/g, "")
    .trim();
}

function stripHtml(html = "") {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Each product's body_html contains one or more spec tables shaped like:
//   <table><thead><tr><th>Attribute</th><th>Detail</th></tr></thead>
//   <tbody><tr><td>Brand</td><td>Rolex</td></tr> ... </tbody></table>
// Some listings have two tables (e.g. "Specifications" + "Scope of
// Delivery"); we flatten every table's rows into one attrs object.
function parseSpecTables(html) {
  const attrs = {};
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
      const key   = stripHtml(rowMatch[1]);
      const value = stripHtml(rowMatch[2]);
      if (key && value) attrs[key] = value;
    }
  }
  return attrs;
}

// Full description = the <p> paragraphs in body_html once the spec
// table(s) are stripped out.
function parseDescription(html) {
  const withoutTables = html.replace(/<table[^>]*>[\s\S]*?<\/table>/gi, " ");
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRegex.exec(withoutTables)) !== null) {
    const text = stripHtml(pm[1]);
    if (text) paragraphs.push(text);
  }
  if (paragraphs.length) return paragraphs.join("\n\n");
  return stripHtml(withoutTables).slice(0, 500);
}

// Pull a plausible 4-digit year (1950–2039) out of the most reliable
// source first: the Warranty Date attribute, then the tag list, then
// the product title.
function deriveYear(attrs, tags, title) {
  const yearRe = /(19[5-9]\d|20[0-3]\d)/;
  const fromWarranty = (attrs["Warranty Date"] || "").match(yearRe);
  if (fromWarranty) return fromWarranty[1];
  const tagYear = (tags || []).find(t => /^\d{4}$/.test(t.trim()) && yearRe.test(t.trim()));
  if (tagYear) return tagYear.trim();
  const fromTitle = (title || "").match(yearRe);
  if (fromTitle) return fromTitle[1];
  return "";
}

function formatPrice(priceStr) {
  const n = parseFloat(priceStr);
  if (isNaN(n)) return "N/A";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── Build product record ────────────────────────────────────────────────
// history.json stores LEAN fields only — just what's needed for dashboard
// display, snapshot comparison, price tracking, and filtering.

function buildProduct(p) {
  const attrs       = parseSpecTables(p.body_html || "");
  const variant      = (p.variants || [])[0] || {};
  const description  = parseDescription(p.body_html || "");

  return {
    id:              p.id,
    name:            stripHtml(p.title),
    price:           formatPrice(variant.price),
    url:             `${SITE_URL}/products/${p.handle}`,
    image:           (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src) || "",
    categories:      attrs["Brand"] || p.product_type || "",
    inStock:         !!variant.available,
    referenceNumber: attrs["Reference Number"] || "",
    productCode:     attrs["Dealer SKU"] || variant.sku || "",
    stockStatus:     variant.available ? "In Stock" : "Sold / Out of Stock",
    brand:           attrs["Brand"] || "",
    year:            deriveYear(attrs, p.tags, p.title),
    box:             attrs["Box"] || "",
    papers:          attrs["Papers"] || attrs["Warranty Paper/Card"] || "",
    description:     description.slice(0, 120),
  };
}

// Full product record (richer attrs) — not currently used by the lean
// dashboard, but kept available if a future export needs more detail.
function buildFullProduct(p) {
  const attrs = parseSpecTables(p.body_html || "");
  return {
    ...buildProduct(p),
    description:   parseDescription(p.body_html || ""),
    model:         attrs["Series"]         || "",
    caseMat:       attrs["Material"]       || "",
    bracelet:      attrs["Bracelet"]       || "",
    dial:          attrs["Dial"]           || "",
    bezel:         attrs["Bezel"]          || "",
    condition:     attrs["Condition"]      || "",
    serialNumber:  attrs["Serial Number"]  || "",
    size:          attrs["Size"]           || "",
    warrantyCard:  attrs["Warranty Card"]  || "",
    warrantyDate:  attrs["Warranty Date"]  || "",
    linkCount:     attrs["Link Count"]     || "",
  };
}

// ── Store API (paginated) ──────────────────────────────────────────────

async function fetchAllProducts() {
  const all = [];
  let page = 1;
  process.stdout.write("  Fetching product list");
  while (true) {
    const json  = await fetchJson(`${SITE_URL}/products.json?limit=${PAGE_SIZE}&page=${page}`);
    const batch = json.products || [];
    if (batch.length === 0) break;
    all.push(...batch);
    process.stdout.write(" .");
    if (batch.length < PAGE_SIZE) break; // last page
    page++;
    await sleep(250);
  }
  console.log(` done (${all.length} products)\n`);
  return all;
}

// ── History I/O ──────────────────────────────────────────────────────────

function loadHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return {}; } }
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h)); } // no pretty-print = smaller file

// Keep only last 30 days of snapshots
function trimHistory(history) {
  const cutoff    = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const before    = Object.keys(history).length;
  const trimmed   = {};

  for (const key of Object.keys(history)) {
    if (key.slice(0, 10) >= cutoffStr) trimmed[key] = history[key];
  }

  const removed = before - Object.keys(trimmed).length;
  if (removed > 0) {
    console.log(`  🗑️  Trimmed ${removed} snapshot${removed > 1 ? "s" : ""} older than 30 days`);
  }
  return trimmed;
}

function nowKey() {
  return new Date().toLocaleString("sv-SE", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).replace("T", " ").slice(0, 16);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const key     = nowKey();
  const history = loadHistory();

  console.log(`\nLinks of NY — Inventory Snapshot`);
  console.log(`Timestamp : ${key} ET\n`);

  let apiProducts;
  try { apiProducts = await fetchAllProducts(); }
  catch (e) { console.error("❌ API failed:", e.message); process.exit(1); }

  const snapshot = {};
  for (const p of apiProducts) {
    const rec = buildProduct(p);
    snapshot[rec.id] = rec;
  }

  history[key] = snapshot;
  const trimmed = trimHistory(history);
  saveHistory(trimmed);

  // Small marker file, committed on every run so there's always a git
  // change to push — that push is what triggers Netlify's auto-redeploy.
  fs.writeFileSync(LASTRUN_FILE, JSON.stringify({
    lastRun:       key,
    totalProducts: Object.keys(snapshot).length,
    inStock:       Object.values(snapshot).filter(p => p.inStock).length,
  }, null, 2));

  // Summary
  const vals     = Object.values(snapshot);
  const withRef  = vals.filter(p => p.referenceNumber).length;
  const withCode = vals.filter(p => p.productCode).length;

  console.log(`✅ Snapshot saved — ${key} ET`);
  console.log(`   Products          : ${vals.length}`);
  console.log(`   In stock          : ${vals.filter(p => p.inStock).length}`);
  console.log(`   Snapshots on file : ${Object.keys(trimmed).length} (last 30 days)`);
  console.log(`\n   Attribute capture:`);
  console.log(`   Reference Number  : ${withRef}/${vals.length}`);
  console.log(`   Dealer SKU        : ${withCode}/${vals.length}`);
  console.log(`\n   Sample (first 3):`);
  vals.slice(0, 3).forEach(p => {
    console.log(`   ┌ ${p.name.slice(0, 55)}`);
    console.log(`   │ Reference Number : ${p.referenceNumber || "(blank on site)"}`);
    console.log(`   │ Dealer SKU       : ${p.productCode    || "(blank on site)"}`);
    console.log(`   └ Stock Status     : ${p.stockStatus}`);
  });

  console.log(`\n→ Open dashboard.html and load history.json to explore.\n`);
}

module.exports = { parseSpecTables, parseDescription, deriveYear, formatPrice, buildProduct, buildFullProduct, stripHtml };

// Only run the scrape when this file is executed directly (`node scrape.js`),
// not when it's require()'d for testing.
if (require.main === module) {
  main().catch(e => { console.error("\nFatal:", e.message); process.exit(1); });
}
