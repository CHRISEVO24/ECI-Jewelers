# Links of NY — Inventory Tracker (GitHub + Netlify)

Same architecture as your WPB Watch Co tracker, pointed at [linksofny.com](https://linksofny.com) instead.

## Why this one's simpler

Links of NY runs on **Shopify**, which publishes a public `/products.json` API. Every product's
Brand, Reference Number, Dial, Bezel, Bracelet, Condition, Box, Papers, Serial Number, Warranty
Card/Date, and Link Count are already embedded as an HTML spec table inside that single API
response — so unlike WPB (WooCommerce + Elementor), there's **no per-product page scraping and no
attribute-cache.json**. One paginated API call gets everything, every run.

## How it works

1. GitHub Actions runs `scrape.js` once a day (edit the cron in `.github/workflows/daily-scrape.yml`
   if you want a different time — it currently fires at ~6:01am ET).
2. `scrape.js` pages through `linksofny.com/products.json`, builds a snapshot, and appends it to
   `history.json` (kept to the last 30 days automatically).
3. `history.json` is uploaded to a **GitHub Release** (not committed directly — keeps the repo's
   git history small), and a small `last-run.json` marker is committed to the repo.
4. That commit is what triggers Netlify to rebuild. During the build, `fetch-history.js` downloads
   the latest `history.json` from the release so `dashboard.html` always has current data. Netlify
   never polls linksofny.com directly and never polls on a timer — it only pulls when a new commit
   lands, i.e. once a day when the scraper runs (or whenever you trigger it manually).

## One-time setup

### 1. Create the repo

Create a new GitHub repo (e.g. `links-of-ny-tracker`) and push these files to it:

```
scrape.js
package.json
dashboard.html
fetch-history.js
netlify.toml
.github/workflows/daily-scrape.yml
```

### 2. No extra secrets needed for the scraper

`GITHUB_TOKEN` is provided automatically by GitHub Actions — you don't need to create one for the
scrape step itself. (You *will* need a personal token for Netlify — see step 4.)

### 3. Connect Netlify to GitHub

1. Go to **netlify.com** → Log in → **Add new site** → **Import from Git**
2. Connect your GitHub account → select your new repo
3. Build settings: leave the build command as-is (`node fetch-history.js`, already set in
   `netlify.toml`)
4. Publish directory: leave blank (serves from root)
5. Click **Deploy site**

### 4. Give Netlify read access to your GitHub Releases

The build script needs a GitHub token to download `history.json` from Releases:

1. Create a GitHub **Personal Access Token** (classic or fine-grained) with read access to your repo
2. In Netlify: **Site settings → Environment variables**, add:
   - `GITHUB_TOKEN` = the token you just created
   - `GITHUB_REPO` = `your-username/links-of-ny-tracker`
3. Redeploy the site once so the first build can pick up `history.json`

Netlify gives you a URL like `https://links-of-ny-tracker.netlify.app` — open that any time to see
the dashboard, always reflecting the most recent scrape.

## Manual scrape trigger

Go to your GitHub repo → **Actions** tab → **Links of NY Daily Inventory Scrape** → **Run workflow**

## Files

| File                                 | Purpose                                                   |
| ------------------------------------ | ---------------------------------------------------------- |
| `scrape.js`                          | Inventory scraper (Shopify `/products.json`, no cache needed) |
| `package.json`                       | Node.js config (no dependencies — uses only built-in `https`) |
| `dashboard.html`                     | The live dashboard — Current Inventory, Changes/Sold, Price Changes |
| `fetch-history.js`                   | Netlify build step — pulls latest `history.json` from GitHub Releases |
| `netlify.toml`                       | Netlify build + routing config |
| `.github/workflows/daily-scrape.yml` | The scheduler |
| `history.json`                       | Generated locally the first time you run `node scrape.js`; not included here |

## What's different from the WPB tracker

- **No Facebook Marketplace sync** — this build skips the FB listings comparison feature (per your
  preference). If you want it added later, it can reuse the WPB tracker's `fb-scraper.js` /
  `fb-check.js` pattern with your Links of NY FB Marketplace cookies.
- **No `attribute-cache.json`** — not needed since Shopify returns all spec-table data inline.
- Dashboard field labels adjusted: "Product Code" → **Dealer SKU**, and Stock Status shows
  **"Sold / Out of Stock"** for delisted/sold pieces (Shopify doesn't distinguish the two in the
  public API — a sold watch is simply removed or marked unavailable).

## Try it now, before setting up automation

You don't need the GitHub/Netlify pipeline to see it working:

```bash
node scrape.js        # scrapes linksofny.com right now, writes history.json
```

Then open `dashboard.html` in a browser and use **"Load history.json manually"** to preview it —
or click **"Preview with sample data"** to see the dashboard's layout without live data.
