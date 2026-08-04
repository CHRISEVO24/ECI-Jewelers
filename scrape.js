#!/usr/bin/env node
/**
 * ECI Jewelers — Inventory Scraper
 *
 * ECI Jewelers runs on Shopify (same platform as the previous Links of NY
 * target), which exposes a public JSON API at /products.json. Every
 * product's spec info (Condition, Reference Number, Model, Movement,
 * Bezel, Dial, Bracelet, Papers, Year, etc.) lives inside body_html —
 * but unlike Links of NY (which used clean HTML <table> markup), ECI's
 * listings use "<strong>Label:</strong> Value" or "<strong>Label</strong> -
 * Value" pairs sitting loose inside <div>/<li> tags, and the exact
 * separator (":" vs "-") and wrapper element are inconsistent from
 * listing to listing. The parser below handles both table markup (kept
 * for robustness/portability) and this label/value style, including
 * values nested inside inline tags like <span>.
 *
 * Usage:  node scrape.js
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

const HISTORY_FILE = path.join(__dirname, "history.json");
const LASTRUN_FILE = path.join(__dirname, "last-run.json");
const SITE_URL     = "https://ecijewelers.com";
const PAGE_SIZE    = 250;

// ── HTTP ──────────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "ECIJewelersTracker/1.0" } }, (res) => {
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

// Table-based spec markup — not used by ECI's current listings, but kept
// so the scraper keeps working if a listing (or future site) uses tables.
//   <table><tr><td>Label</td><td>Value</td></tr></table>
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

// ECI's spec markup: "<strong>Label:</strong> Value" or
// "<strong>Label</strong> - Value", loose inside <div>/<li>/plain text.
// The value may be wrapped in inline tags (e.g. <span style="...">), so we
// grab everything up to the next block-level boundary and strip tags from
// that chunk rather than stopping at the first "<".
function parseSpecLabels(html) {
  const attrs = {};
  const strongRegex = /<strong[^>]*>([\s\S]*?)<\/strong>/gi;
  let m;
  while ((m = strongRegex.exec(html)) !== null) {
    const label = stripHtml(m[1]).replace(/:\s*$/, "").trim();
    if (!label) continue; // e.g. a bare "<strong>Details</strong>" section header
    const afterIdx = m.index + m[0].length;
    const rest = html.slice(afterIdx, afterIdx + 400);
    const boundary = rest.search(/<\/div>|<\/li>|<br\s*\/?>|<\/p>|<strong/i);
    const chunk = boundary === -1 ? rest : rest.slice(0, boundary);
    const value = stripHtml(chunk).replace(/^[\s:\-–—]+/, "").trim();
    if (label && value) attrs[label] = value;
  }

  // A handful of listings put "Accessories: ..." as plain text without a
  // <strong> wrapper. Catch that specific, known field name as a targeted
  // fallback (not a general "any label" scan, to avoid false positives on
  // ordinary prose sentences that happen to contain a colon).
  if (!attrs["Accessories"]) {
    const plainMatch = html.match(/(?:^|>)\s*Accessories\s*:\s*([^<]+)/i);
    if (plainMatch) {
      const value = stripHtml(plainMatch[1]).trim();
      if (value) attrs["Accessories"] = value;
    }
  }

  return attrs;
}

function parseSpecAttributes(html) {
  // Table-based first, then label/value — later assignments win if a key
  // appears in both (label/value is more specific to how ECI writes pages).
  return { ...parseSpecTables(html), ...parseSpecLabels(html) };
}

// Full description = the prose paragraph(s) in body_html once every
// spec label/value chunk has been stripped out. ECI wraps paragraphs in
// <div> rather than <p>, so <p> is tried first (covers table-style sites)
// and <div> is the fallback.
function parseDescription(html) {
  const withoutTables = html.replace(/<table[^>]*>[\s\S]*?<\/table>/gi, " ");
  const withoutSpecs = withoutTables.replace(
    /<strong[^>]*>[\s\S]*?<\/strong>[\s\S]*?(?=<\/div>|<\/li>|<br\s*\/?>|<\/p>|$)/gi, ""
  );

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRegex.exec(withoutSpecs)) !== null) {
    const text = stripHtml(pm[1]);
    if (text) paragraphs.push(text);
  }
  if (paragraphs.length === 0) {
    const divRegex = /<div[^>]*>([\s\S]*?)<\/div>/gi;
    let dm;
    while ((dm = divRegex.exec(withoutSpecs)) !== null) {
      const text = stripHtml(dm[1]);
      if (text && text.length > 15) paragraphs.push(text); // skip stray <br>/empty divs
    }
  }
  if (paragraphs.length) return paragraphs.join("\n\n");

  // Last-resort fallback: any reasonably long <p> anywhere on the page.
  const allP = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => stripHtml(m[1]))
    .filter(t => t.length >= 80 && t.length <= 2000);
  if (allP.length) return allP.join("\n\n");

  return stripHtml(withoutSpecs).slice(0, 500);
}

// Pull a plausible 4-digit year (1950–2039) out of the most reliable
// source first: an explicit "Year" attribute, then "Warranty Date"
// (Links-of-NY style), then the tag list, then the product title.
function deriveYear(attrs, tags, title) {
  const yearRe = /(19[5-9]\d|20[0-3]\d)/;
  const fromYearField = (attrs["Year"] || "").match(yearRe);
  if (fromYearField) return fromYearField[1];
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
// buildProduct() returns the lean fields the table/dashboard views need.
// history.json actually stores the richer buildFullProduct() version (see
// below) so exports like "WPB Setup" have full spec data available too.

function buildProduct(p) {
  const attrs       = parseSpecAttributes(p.body_html || "");
  const variant      = (p.variants || [])[0] || {};
  const description  = parseDescription(p.body_html || "");

  return {
    id:              p.id,
    name:            stripHtml(p.title),
    price:           formatPrice(variant.price),
    url:             `${SITE_URL}/products/${p.handle}`,
    image:           (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src) || "",
    // ECI doesn't label "Brand:" on the page — Shopify's own `vendor`
    // field carries it instead (e.g. "Rolex", "Audemars Piguet").
    categories:      attrs["Brand"] || p.vendor || p.product_type || "",
    inStock:         !!variant.available,
    // Some listings (e.g. certain Audemars Piguet pieces) only label
    // "Model" with the reference number rather than a separate
    // "Reference Number" field — fall back to Model when it's missing.
    referenceNumber: attrs["Reference Number"] || attrs["Model"] || "",
    productCode:     attrs["Dealer SKU"] || variant.sku || "",
    stockStatus:     variant.available ? "In Stock" : "Sold / Out of Stock",
    brand:           attrs["Brand"] || p.vendor || "",
    year:            deriveYear(attrs, p.tags, p.title),
    // No dedicated "Box:" field on ECI — inferred from the free-text
    // "Accessories" line when it mentions a box.
    box:             attrs["Box"] || (attrs["Accessories"] && /\bbox\b/i.test(attrs["Accessories"]) ? "Yes" : ""),
    papers:          attrs["Papers"] || attrs["Warranty Paper/Card"] || "",
    // Site's own condition wording (e.g. "Pre-owned 9/10 Very Good",
    // "Unworn 10/10 Excellent") — used by the dashboard's Facebook export
    // to map into FB's fixed enum.
    condition:       attrs["Condition"] || "",
    // Full, untruncated description — the dashboard visually clamps this to a
    // couple lines for a clean table (CSS, not data loss), but Excel exports
    // and the underlying history.json always carry the complete text.
    description:     description,
  };
}

// Full product record (richer attrs) — used for history.json so the
// dashboard's "Export Selected to WPB Setup" feature has everything WPB's
// own listing pages require (Model, Case, Bracelet, Dial, Bezel, Movement),
// not just the lean fields the table view needs.
function buildFullProduct(p) {
  const attrs = parseSpecAttributes(p.body_html || "");
  return {
    ...buildProduct(p),
    model:         attrs["Model"]          || "",
    caseMat:       attrs["Case Material"]  || "",
    bracelet:      attrs["Bracelet"]       || "",
    dial:          attrs["Dial"]           || "",
    bezel:         attrs["Bezel"]          || attrs["Bezel Material"] || "",
    movement:      attrs["Movement"]       || "",
    crystal:       attrs["Crystal"]        || "",
    accessories:   attrs["Accessories"]    || "",
    serialNumber:  attrs["Serial Number"]  || "",
    size:          attrs["Case Diameter"]  || attrs["Size"] || "",
    warrantyCard:  attrs["Warranty Card"]  || "",
    warrantyDate:  attrs["Warranty Date"]  || "",
    linkCount:     attrs["Link Count"]     || "",
    // All product images (not just the first) — WPB's own listings show
    // multiple photos per watch, so the setup export needs the full set.
    images:        (p.images || []).map(im => im.src).filter(Boolean),
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

  console.log(`\nECI Jewelers — Inventory Snapshot`);
  console.log(`Timestamp : ${key} ET\n`);

  let apiProducts;
  try { apiProducts = await fetchAllProducts(); }
  catch (e) { console.error("❌ API failed:", e.message); process.exit(1); }

  const snapshot = {};
  for (const p of apiProducts) {
    const rec = buildFullProduct(p);
    snapshot[rec.id] = rec;
  }

  history[key] = snapshot;
  const trimmed = trimHistory(history);
  saveHistory(trimmed);

  // Small marker file, committed on every run so there's always a git
  // change to push — that push is what makes GitHub Pages republish.
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

module.exports = { parseSpecTables, parseSpecLabels, parseSpecAttributes, parseDescription, deriveYear, formatPrice, buildProduct, buildFullProduct, stripHtml };

// Only run the scrape when this file is executed directly (`node scrape.js`),
// not when it's require()'d for testing.
if (require.main === module) {
  main().catch(e => { console.error("\nFatal:", e.message); process.exit(1); });
}
