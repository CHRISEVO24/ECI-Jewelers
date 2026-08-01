#!/usr/bin/env node
/**
 * Links of NY — Netlify Build Script
 * Runs during Netlify deploy. Downloads the latest history.json
 * from GitHub Releases so the dashboard always has fresh data.
 *
 * Set these environment variables in Netlify (Site settings → Environment):
 *   GITHUB_TOKEN  — a GitHub Personal Access Token (repo:read is enough)
 *   GITHUB_REPO   — your repo, e.g. "chrisevo24/links-of-ny-tracker"
 */

const https = require("https");
const fs    = require("fs");

const TOKEN = process.env.GITHUB_TOKEN;
const REPO  = process.env.GITHUB_REPO;

if (!TOKEN || !REPO) {
  console.log("⚠️  GITHUB_TOKEN or GITHUB_REPO not set — skipping history.json fetch");
  console.log("   Dashboard will use whatever history.json is already in the repo.");
  process.exit(0); // don't fail the build
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        "User-Agent": "LinksOfNYTracker/1.0",
        "Authorization": `token ${TOKEN}`,
        ...headers,
      }
    };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

async function main() {
  console.log(`\nFetching latest history.json from GitHub Releases...`);
  console.log(`Repo: ${REPO}\n`);

  const releaseRes = await get(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { "Accept": "application/vnd.github.v3+json" }
  );

  if (releaseRes.status === 404) {
    console.log("No releases found yet — scraper hasn't run. Using existing history.json if present.");
    process.exit(0);
  }

  const release = JSON.parse(releaseRes.body.toString());
  const asset   = (release.assets || []).find(a => a.name === "history.json");

  if (!asset) {
    console.log("No history.json asset in latest release — using existing file.");
    process.exit(0);
  }

  console.log(`Found: ${release.name} (${asset.name}, ${(asset.size / (1024*1024)).toFixed(1)} MB)`);
  console.log(`Downloading...`);

  const fileRes = await get(asset.url, { "Accept": "application/octet-stream" });

  if (fileRes.status !== 200) {
    console.error(`Download failed with status ${fileRes.status}`);
    process.exit(0); // don't fail the Netlify build
  }

  fs.writeFileSync("history.json", fileRes.body);
  const sizeMB = (fs.statSync("history.json").size / (1024*1024)).toFixed(1);
  console.log(`✅ history.json saved (${sizeMB} MB)`);
  console.log(`   Dashboard will show data from: ${release.name}\n`);
}

main().catch(e => {
  console.error("fetch-history.js error:", e.message);
  process.exit(0); // never fail the Netlify build
});
