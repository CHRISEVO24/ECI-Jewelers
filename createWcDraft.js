// createWcDraft.js
// Creates a WooCommerce draft product on wpbwatchco.com for review before publishing
// Called by scrapers when a new item is detected

const https = require('https');

const WC_BASE = 'https://wpbwatchco.com/wp-json/wc/v3';

function wcRequest(method, endpoint, data) {
  const ck = process.env.WC_CONSUMER_KEY;
  const cs = process.env.WC_CONSUMER_SECRET;
  if (!ck || !cs) throw new Error('WC_CONSUMER_KEY / WC_CONSUMER_SECRET not set');

  const auth = Buffer.from(`${ck}:${cs}`).toString('base64');
  const body = data ? JSON.stringify(data) : null;
  const url = new URL(WC_BASE + endpoint);

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getOrCreateCategory(name) {
  // Search for existing category
  const { body: cats } = await wcRequest('GET', `/products/categories?search=${encodeURIComponent(name)}&per_page=5`);
  if (Array.isArray(cats) && cats.length > 0) {
    const match = cats.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
  }
  // Create it
  const { body: newCat } = await wcRequest('POST', '/products/categories', { name });
  return newCat.id || null;
}

async function createDraft(item, source) {
  // source = 'ECJ Luxe Collection' or 'ECI Jewelers'
  const ck = process.env.WC_CONSUMER_KEY;
  const cs = process.env.WC_CONSUMER_SECRET;
  if (!ck || !cs) {
    console.log('WC credentials not set — skipping draft creation');
    return null;
  }

  // Build description
  const descParts = [];
  if (item.description && item.description !== item.name) descParts.push(item.description);
  if (item.movement)     descParts.push(`Movement: ${item.movement}`);
  if (item.caseSize)     descParts.push(`Case Size: ${item.caseSize}`);
  if (item.caseMaterial) descParts.push(`Case Material: ${item.caseMaterial}`);
  if (item.dialDetails)  descParts.push(`Dial: ${item.dialDetails}`);
  if (item.bezelDetails) descParts.push(`Bezel: ${item.bezelDetails}`);
  if (item.bandMaterial) descParts.push(`Band: ${item.bandMaterial}`);
  if (item.boxPapers)    descParts.push(`Box/Papers: ${item.boxPapers}`);
  if (item.serialInfo)   descParts.push(`Serial: ${item.serialInfo}`);

  const description = descParts.map(p => `<p>${p}</p>`).join('\n');

  // Build short description
  const shortDesc = [
    item.brand ? `<strong>Brand:</strong> ${item.brand}` : '',
    item.referenceNumber ? `<strong>Ref:</strong> ${item.referenceNumber}` : '',
    item.year ? `<strong>Year:</strong> ${item.year}` : '',
    `<strong>Source:</strong> ${source}`
  ].filter(Boolean).join(' &nbsp;|&nbsp; ');

  // Price — strip $ and commas
  const priceNum = item.price ? item.price.replace(/[$,]/g, '') : '0';

  // Categories
  const catIds = [];
  try {
    const watchCatId = await getOrCreateCategory('Timepieces');
    if (watchCatId) catIds.push({ id: watchCatId });
    if (item.brand) {
      const brandId = await getOrCreateCategory(item.brand);
      if (brandId) catIds.push({ id: brandId });
    }
  } catch(e) { console.log('Category error:', e.message); }

  // Images
  const images = [];
  if (item.image) images.push({ src: item.image, alt: item.name });
  if (item.images && Array.isArray(item.images)) {
    item.images.slice(1, 5).forEach(src => { if (src) images.push({ src, alt: item.name }); });
  }

  // Build product payload
  const product = {
    name: item.name,
    status: 'draft',
    type: 'simple',
    regular_price: priceNum,
    description,
    short_description: shortDesc,
    sku: `${source.replace(/\s+/g,'-').toUpperCase()}-${item.sku || item.id}`,
    categories: catIds,
    images,
    tags: [
      { name: source },
      { name: 'Auto-Draft' }
    ],
    meta_data: [
      { key: '_source', value: source },
      { key: '_source_url', value: item.permalink || '' },
      { key: '_source_sku', value: String(item.sku || item.id || '') },
      { key: '_auto_drafted', value: new Date().toISOString() }
    ]
  };

  try {
    const { status, body } = await wcRequest('POST', '/products', product);
    if (status === 201) {
      console.log(`  ✓ Draft created: "${item.name}" (WPB ID: ${body.id})`);
      return body.id;
    } else {
      console.log(`  ✗ Draft failed (${status}):`, typeof body === 'object' ? body.message : body);
      return null;
    }
  } catch(e) {
    console.log(`  ✗ Draft error: ${e.message}`);
    return null;
  }
}

module.exports = { createDraft };
