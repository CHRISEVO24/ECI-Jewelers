#!/usr/bin/env node
// Verify scrape.js parsing logic against real sample products.json data
// pulled from ecijewelers.com (primary target), plus a regression check
// against the old Links of NY table-markup samples to confirm the merged
// parser (parseSpecAttributes = tables + label/value) still handles both
// styles without needing live network access from this sandbox.

const {
  buildProduct, buildFullProduct, deriveYear, parseSpecAttributes,
  parseSpecTables, parseDescription, isExcludedVendor,
} = require("./scrape.js");

let pass = 0, fail = 0;
function check(label, ok) {
  if (ok) pass++; else { fail++; console.log(`  ❌ FAILED CHECK: ${label}`); }
}

// ── Primary target: ecijewelers.com ─────────────────────────────────────

const eciSamples = require("./sample-products-eci.json");

for (const p of eciSamples) {
  const isEmptyTestCase = p.id === 99999999999998; // intentionally has no body_html
  const rec = buildProduct(p);
  const full = buildFullProduct(p);
  console.log("=".repeat(70));
  console.log(rec.name);
  console.log(JSON.stringify(rec, null, 2));
  console.log("-- full extras --");
  console.log(JSON.stringify({
    model: full.model, caseMat: full.caseMat, bracelet: full.bracelet,
    dial: full.dial, bezel: full.bezel, movement: full.movement,
    crystal: full.crystal, accessories: full.accessories, size: full.size,
  }, null, 2));

  check("has id", rec.id === p.id);
  check("has name", rec.name.length > 0);
  check("price formatted with $", rec.price.startsWith("$"));
  check("url built from ecijewelers.com + handle", rec.url === `https://ecijewelers.com/products/${p.handle}`);
  check("inStock is boolean", typeof rec.inStock === "boolean");
  check("image matches first images[].src when present", (p.images && p.images[0]) ? rec.image === p.images[0].src : rec.image === "");

  if (isEmptyTestCase) {
    check("empty body_html -> empty description", rec.description === "");
    check("empty body_html -> empty referenceNumber", rec.referenceNumber === "");
    continue;
  }

  check("has brand (from vendor fallback)", rec.brand.length > 0);
  check("brand matches Shopify vendor field", rec.brand === p.vendor);
  check("has referenceNumber (direct or Model fallback)", rec.referenceNumber.length > 0);
  check("has year (4 digits)", /^\d{4}$/.test(rec.year));
  check("has condition", rec.condition.length > 0);
  check("productCode falls back to variant.sku", rec.productCode === p.variants[0].sku);
  check("description is non-empty prose (not just spec labels)", rec.description.length > 100);
  check("description does not start with a spec label like 'Condition:'", !/^condition:/i.test(rec.description));
  check("description does not accidentally swallow the Reference Number line", !rec.description.includes("Reference Number:"));
}

// ── Specific known-tricky cases ─────────────────────────────────────────

const apRoyalOak = eciSamples.find(p => p.id === 10437759140130);
const apRec = buildProduct(apRoyalOak);
console.log("\n" + "=".repeat(70));
console.log("Targeted checks — AP Royal Oak (dash-style attrs, nested <span> value, no explicit Reference Number)");
check("AP: referenceNumber falls back to Model when Reference Number absent", apRec.referenceNumber === "26240OR.OO.1320OR.08");
check("AP: dash-separated 'Movement - Automatic' parsed correctly", buildFullProduct(apRoyalOak).movement === "Automatic");
check("AP: value nested in <span> after dash correctly extracted (not truncated to '-')", apRec.referenceNumber.length > 5);

const skyDweller = eciSamples.find(p => p.id === 10433179681058);
const skyRec = buildProduct(skyDweller);
console.log("\nTargeted checks — Sky-Dweller ('Unworn 10/10 Excellent' condition)");
check("Sky-Dweller: condition captured verbatim", skyRec.condition === "Unworn 10/10 Excellent");

const dayDate18388 = eciSamples.find(p => p.id === 10437768053026);
const ddRec = buildProduct(dayDate18388);
console.log("\nTargeted checks — Day-Date 18388 (Accessories line not wrapped in <strong>, mentions 'Box')");
check("18388: box inferred 'Yes' from unlabeled Accessories text mentioning box", ddRec.box === "Yes");

// ── Regression: old Links of NY table-markup still parses ──────────────

console.log("\n" + "=".repeat(70));
console.log("Regression check — table-based markup (old Links of NY style) still supported");
const tableHtml = `<table><tbody>
  <tr><td>Brand</td><td>Rolex</td></tr>
  <tr><td>Reference Number</td><td>126710BLNR</td></tr>
  <tr><td>Condition</td><td>Excellent</td></tr>
</tbody></table>`;
const tableAttrs = parseSpecAttributes(tableHtml);
check("table markup: Brand parsed", tableAttrs["Brand"] === "Rolex");
check("table markup: Reference Number parsed", tableAttrs["Reference Number"] === "126710BLNR");
check("table markup: Condition parsed", tableAttrs["Condition"] === "Excellent");
check("parseSpecTables alone still works standalone", parseSpecTables(tableHtml)["Brand"] === "Rolex");

// ── Non-watch vendor exclusion ──────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log("Vendor exclusion — non-watch jewelry vendors skipped");
check("excludes 'ECI Jewelers' vendor", isExcludedVendor({ vendor: "ECI Jewelers" }) === true);
check("excludes 'Elegant Creations Inc' vendor", isExcludedVendor({ vendor: "Elegant Creations Inc" }) === true);
check("exclusion is case-insensitive", isExcludedVendor({ vendor: "elegant creations inc" }) === true);
check("exclusion tolerates surrounding whitespace", isExcludedVendor({ vendor: "  ECI Jewelers  " }) === true);
check("does not exclude real watch vendors", isExcludedVendor({ vendor: "Rolex" }) === false);
check("does not exclude when vendor is missing", isExcludedVendor({}) === false);

console.log("\n" + "=".repeat(70));
console.log(`\n${pass} checks passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
