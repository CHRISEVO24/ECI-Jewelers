[SETUP.md](https://github.com/user-attachments/files/31039798/SETUP.md)
# ECI Jewelers — Inventory Tracker (GitHub Actions + GitHub Pages)

Same tool that was tracking linksofny.com, repointed at [ecijewelers.com](https://ecijewelers.com)
instead. Architecture is unchanged: GitHub Actions scrapes on a schedule, pushes `history.json`
straight into the repo, and GitHub Pages republishes automatically — no Netlify, no manual deploy
button, matching how the WPB tracker works.

## What changed vs. the Links of NY version

ECI Jewelers is also a Shopify store with the same public `/products.json` API, so the overall
pipeline is identical. What's different is how ECI writes each listing's spec info inside
`body_html`:

- **Links of NY** used clean `<table>` markup (`<tr><td>Label</td><td>Value</td></tr>`).
- **ECI** puts `<strong>Label:</strong> Value` or `<strong>Label</strong> - Value` pairs loose
  inside `<div>` or `<li>` tags — and inconsistently: some listings use a colon, others a dash;
  some wrap "Accessories" in `<strong>`, others don't; not every listing labels "Reference Number"
  the same way (a few only label "Model" with what's actually the reference number).

`scrape.js` now has a parser built and tested specifically against this pattern (`parseSpecLabels`),
merged with the original table parser (`parseSpecTables`) for robustness, plus targeted fallbacks:

- **Brand** comes from Shopify's own `vendor` field (ECI doesn't label "Brand:" on the page at all).
- **Reference Number** falls back to the "Model" field when no explicit "Reference Number" is given.
- **Year** now checks an explicit "Year" field first (ECI labels it directly), falling back to the
  older "Warranty Date" pattern for compatibility.
- **Box** is inferred from the free-text "Accessories" line when it mentions a box (ECI has no
  dedicated "Box:" field).

All of this was verified against 5 real ECI listings (spanning both colon- and dash-style pages)
before being wired into the live scraper — see the checks in `test-scrape.js` if you want to look.

## How it works

1. GitHub Actions runs `scrape.js` twice a day (edit the cron lines in
   `.github/workflows/daily-scrape.yml` if you want different times — currently 6am and 3pm ET).
2. `scrape.js` pages through `ecijewelers.com/products.json`, builds a snapshot, and appends it to
   `history.json` (kept to the last 30 days automatically).
3. The workflow commits the updated `history.json` **directly to the repo** and pushes it.
4. That push is what makes **GitHub Pages** republish automatically — no build step, no manual
   deploy, no separate hosting account.

## One-time setup (if starting a fresh repo)

If you're reusing the existing repo that used to track Links of NY, you can skip straight to
replacing the files below — GitHub Pages, permissions, and the schedule are already configured.

### 1. Push/update these files

```
scrape.js
package.json
dashboard.html
.github/workflows/daily-scrape.yml
```

### 2. Confirm GitHub Pages is on

**Settings → Pages** → Source: "Deploy from a branch" → Branch: `main`, folder **/ (root)** →
**Save**. Your URL will look like `https://<your-username>.github.io/<repo-name>/dashboard.html`.

### 3. Confirm write permissions

The workflow already declares:

```yaml
permissions:
  contents: write
```

If pushes still fail with a 403, check **Settings → Actions → General → Workflow permissions** is
set to "Read and write permissions."

## ⚠️ Heads up: this repoint resets your snapshot history

Since `history.json` is scraper-specific (Links of NY listings won't match ECI's IDs, prices, or
attributes), the first run against `ecijewelers.com` effectively starts fresh — old Links of NY
snapshots won't blend with new ECI ones. If you want to keep tracking Links of NY as well, that
needs a **separate repo** (copy the old `scrape.js`/`history.json` before overwriting, or fork this
one) — this single repo/site can only point at one target at a time.

## Manual scrape trigger

Go to your GitHub repo → **Actions** tab → **ECI Jewelers Daily Inventory Scrape** → **Run workflow**

## Files

| File                                  | Purpose                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| `scrape.js`                            | Inventory scraper (Shopify `/products.json`, ECI-specific parsing) |
| `package.json`                         | Node.js config (no dependencies — uses only built-in `https`)   |
| `dashboard.html`                       | The live dashboard — Current Inventory, Changes/Sold, Price Changes, Facebook export |
| `.github/workflows/daily-scrape.yml`   | The scheduler — scrapes, commits `history.json`, pushes         |
| `history.json`                         | Generated automatically by the workflow; grows with each run, trimmed to 30 days |

## Notable scraper behavior

- **Non-watch vendors are excluded.** ECI's Shopify catalog also carries non-watch jewelry
  pieces under the vendor names "ECI Jewelers" and "Elegant Creations Inc." Since this tracker
  is watches-only, `scrape.js` skips any product tagged with either vendor before it's ever
  written to `history.json` (matched case-insensitively). To exclude more vendors later, edit
  the `EXCLUDED_VENDORS` list near the top of `scrape.js`.

## Notable dashboard behavior

- "Product Code" column shows **Dealer SKU** (Shopify variant SKU, e.g. "W4286").
- Stock Status shows **"Sold / Out of Stock"** for delisted/sold pieces (Shopify's public API
  doesn't distinguish the two — an item is simply removed or marked unavailable).
- **Export Selected to Facebook (.xlsx)** matches Facebook's own Bulk Upload Template exactly
  (TITLE/PRICE/CONDITION/DESCRIPTION/CATEGORY), maps ECI's condition wording (e.g. "Pre-owned 9/10
  Very Good", "Unworn 10/10 Excellent") into Facebook's four allowed values, and appends the Dealer
  SKU to the bottom of the description. Capped at 50 listings per file (Facebook's own limit).
- **Export to WPB Setup (.xlsx)** mirrors the exact spec block every wpbwatchco.com listing shows
  (Brand, Model, Reference Number, Case, Bracelet, Dial, Bezel, Movement, Year, Box, Papers, plus
  description and up to 4 photos), so the team has everything needed to set the item up on the site.
  It intentionally leaves "WPB Listing Price" blank — it includes the source dealer's asking price
  and a 95%-of-that reference cost, but never guesses WPB's actual resale price. Like the regular
  Excel export, it exports the checked rows if any are selected, otherwise everything the current
  filters show. Note: the richer spec fields (Model, Case, Bracelet, Dial, Bezel, Movement) only
  populate for snapshots taken *after* this feature shipped — scrape.js now saves the full record
  set instead of the lean one, so older history.json snapshots won't have them retroactively.
- **Export to WPB Setup** is also available on the **Changes/Sold** tab, pulling the exact same
  full attribute set as the Current Inventory version. It combines New Arrivals and Sold/Removed
  into one file with an added "Status" column so the two stay distinguishable, and it respects
  whatever the tab's search box currently shows (search first, then export, to scope it down).
- **Export to WPB Setup (Miranda File)** is a second export format, available on both Current
  Inventory and Changes/Sold, matching the exact column layout of WPB's internal ECI purchase-
  tracking spreadsheet (DATE / Status / Date Posted Web / CR24 / Ebay / Client Stock / Brand /
  Model / Dial / Strap/Bracelet / # of Links* / Paper / Paper Date / Box / Price Check / Wholesale
  Price USD / Action / Chrono24 Price / Website Price / Net Profit Chrono / Net Profit WPB /
  Images / Video). Client Stock (Dealer SKU) through Box, plus one photo, are filled from ECI's
  site data. Wholesale Price USD is filled with the WPB Watch Co Buy Price (95% of source asking
  price, same formula as the Current Inventory column and the regular WPB Setup export's "Est.
  WPB Buy Price" field). Everything else (workflow dates/status, pricing and profit on other
  marketplaces) lives entirely on WPB's side and is deliberately left blank rather than guessed.
  On the Changes/Sold version, the template's own "Status" column is repurposed to
  carry the New/Sold tag. Since ECI doesn't always explicitly label "Reference Number" or "Model"
  on a listing, the Model column falls back to pulling it from the product title (the word right
  after the brand name, only if it contains a digit) when the labeled field is blank — this
  recovered the reference number for the large majority of previously-blank rows when tested
  against a real export of WPB's tracking file.

## Try it now, without waiting for the scheduler

```bash
node scrape.js        # scrapes ecijewelers.com right now, writes history.json
```

Then open `dashboard.html` in a browser and use **"Load history.json manually"** to preview it —
or click **"Preview with sample data"** to see the dashboard's layout without live data.
