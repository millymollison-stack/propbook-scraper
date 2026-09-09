const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');

const SB_BUCKET = 'NewSiteOnboarding';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0emFncGJkcnFmaWZkaXN4aXByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ3MzUyODUsImV4cCI6MjA2MDMxMTI4NX0.uWqc82Hb-qnRq4H9kg5IPykUosm9VvU2s6e8mOalkR0';
const SUPABASE_URL = 'https://jtzagpbdrqfifdisxipr.supabase.co';

function btoa(str) { return Buffer.from(str).toString('base64'); }

function extractMeta(html, property) {
  let m = html.match(new RegExp('<meta[^>]+property="' + property + '"[^>]+content="([^"]+)"'));
  if (m) return decodeHtmlEntities(m[1]);
  const m2 = html.match(new RegExp('<meta[^>]+content="([^"]+)"[^>]+property="' + property + '"'));
  if (m2) return decodeHtmlEntities(m2[1]);
  return null;
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function upgradeImageUrl(imgUrl) {
  if (!imgUrl) return null;
  return imgUrl.replace(/\?.*$/, '').replace(/\?$/, '') + '?im_w=1200';
}

// Retry wrapper — attempts httpGet, retries once after 2s on network failure or 5xx
async function httpGetWithRetry(targetUrl, extraHeaders = {}, retries = 1) {
  try {
    const res = await httpGet(targetUrl, extraHeaders);
    // Retry on server errors only — NOT on block (4xx with no data)
    if (res.status >= 500 && retries > 0) {
      console.log(`[v26] HTTP ${res.status}, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      return httpGetWithRetry(targetUrl, extraHeaders, retries - 1);
    }
    return res;
  } catch(e) {
    if (retries > 0) {
      console.log(`[v26] Network error: ${e.message}, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      return httpGetWithRetry(targetUrl, extraHeaders, retries - 1);
    }
    throw e;
  }
}

async function httpGet(targetUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
        ...extraHeaders
      }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function downloadImageBuffer(imageUrl) {
  try {
    const resp = await fetch(imageUrl, {
      headers: { 'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8', 'Referer': 'https://www.airbnb.com/' },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}

async function uploadToSupabase(buffer, filename) {
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SB_BUCKET}/${filename}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SB_ANON_KEY}`, 'apikey': SB_ANON_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: buffer
    });
    if (!res.ok) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/${SB_BUCKET}/${filename}`;
  } catch { return null; }
}

function parseImagesFromLdJson(obj, existing) {
  const images = [...existing];
  const imgField = obj.image;
  if (!imgField) return images;
  const imgList = Array.isArray(imgField) ? imgField : [imgField];
  for (const img of imgList) {
    const imgUrl = typeof img === 'string' ? img : (img.url || null);
    if (imgUrl) {
      const upgraded = upgradeImageUrl(imgUrl);
      if (!images.includes(upgraded)) images.push(upgraded);
    }
  }
  return images;
}

// Airbnb placeholder images — skip these early to save Supabase storage and improve quality
const BLOCKED_IMAGE_PREFIXES = [
  'fe7217ff', // Airbnb logo/placeholder
  '0a55c66e', // Airbnb branding
];

function isBlockedImage(imgUrl) {
  return BLOCKED_IMAGE_PREFIXES.some(id => imgUrl && imgUrl.includes(id));
}

async function scrapeListing(targetUrl) {
  const data = {
    title: null, location: null, price: null, currency: 'USD',
    guests: null, bedrooms: null, beds: null, baths: null,
    rating: null, reviews: null, hero_image: null,
    images: [], description: null, host_name: null, error: null
  };

  let html;
  try {
    const res = await httpGetWithRetry(targetUrl, {});
    html = res.body;
    console.log('[v26] HTTP status:', res.status, 'size:', html.length);
  } catch(e) {
    data.error = 'HTTP error: ' + e.message;
    return data;
  }

  // Check for block
  const ogTitle = extractMeta(html, 'og:title');
  console.log('[v25] og:title:', ogTitle ? ogTitle.substring(0, 60) : 'MISSING');
  
  if (!ogTitle || ogTitle.includes('Oops') || ogTitle.includes('Airbnb')) {
    // Might be blocked - check if it has listing data anyway
    if (!html.includes('VacationRental') && !html.includes('StayListing')) {
      data.error = 'Airbnb blocked or returned generic page';
      return data;
    }
  }

  // Extract JSON-LD data
  const scripts = [];
  const scriptRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    try { scripts.push(JSON.parse(m[1])); } catch {}
  }

  for (const obj of scripts) {
    const graphs = obj['@graph'] || [obj];
    for (const item of graphs) {
      if (item['@type'] === 'VacationRental' || item['@type'] === 'LodgingBusiness' || item['@type'] === 'Hotel') {
        // Title
        if (!data.title && item.name) data.title = item.name;
        // Description
        if (!data.description && item.description) {
          data.description = item.description.substring(0, 2000);
        }
        // Images
        data.images = parseImagesFromLdJson(item, data.images);
        // Rating
        if (!data.rating && item.aggregateRating) {
          data.rating = parseFloat(item.aggregateRating.ratingValue) || null;
          data.reviews = parseInt(String(item.aggregateRating.ratingCount || "0").replace(/[^0-9]/g, "")) || null;
        }
        // Location
        if (!data.location && item.address) {
          const addr = item.address;
          data.location = addr.addressLocality || addr.addressRegion || addr.streetAddress || null;
        }
        // Geo
        if (!data.lat && item.geo) {
          data.lat = item.geo.latitude;
          data.lng = item.geo.longitude;
        }
        // Host name
        if (!data.host_name && item.author) {
          data.host_name = typeof item.author === 'string' ? item.author : (item.author.name || null);
        }
        // Guests/beds from occupancy
        if (item.containsPlace && item.containsPlace.occupancy) {
          const occ = item.containsPlace.occupancy;
          if (!data.guests && occ['@type'] === 'QuantitativeValue') {
            data.guests = occ.value || null;
          }
        }
      }
    }
  }

  // Also check Product type for same fields
  for (const obj of scripts) {
    if (obj['@type'] === 'Product') {
      if (!data.title && obj.name) data.title = obj.name;
      if (!data.description && obj.description) data.description = obj.description.substring(0, 2000);
      data.images = parseImagesFromLdJson(obj, data.images);
      if (!data.rating && obj.aggregateRating) {
        data.rating = obj.aggregateRating.ratingValue || null;
        data.reviews = parseInt(String(obj.aggregateRating.ratingCount || "0").replace(/[^0-9]/g, "")) || null;
      }
    }
  }

  // Hero image from og:image
  const ogImage = extractMeta(html, 'og:image');
  if (ogImage) {
    const upgraded = upgradeImageUrl(ogImage);
    if (!data.images.includes(upgraded)) data.images.unshift(upgraded);
    data.hero_image = data.images[0];
  }

  // All og:image meta tags
  const imgMetaRe = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/gi;
  while ((m = imgMetaRe.exec(html)) !== null) {
    const imgUrl = upgradeImageUrl(decodeHtmlEntities(m[1]));
    if (!data.images.includes(imgUrl)) data.images.push(imgUrl);
  }

  // Remove duplicates preserving order
  data.images = [...new Set(data.images)];

  // Remove blocked placeholder images before upload
  const rawCount = data.images.length;
  data.images = data.images.filter(img => !isBlockedImage(img));
  const blockedCount = rawCount - data.images.length;
  if (blockedCount > 0) console.log('[v26] Skipped', blockedCount, 'blocked placeholder images');

  // Get listing ID from URL for reference
  const listingId = targetUrl.split('/rooms/')[1] ? targetUrl.split('/rooms/')[1].split('?')[0] : null;
  console.log('[v26] Listing ID:', listingId, '| title:', data.title ? data.title.substring(0, 40) : 'MISSING');
  console.log('[v26] Images:', data.images.length, '| rating:', data.rating, '| reviews:', data.reviews);
  console.log('[v26] Description len:', data.description ? data.description.length : 0);

  // Phase 1 — download all images in parallel (max 8)
  if (data.images.length > 0) {
    const imagesToProcess = data.images.slice(0, 8);
    console.log('[v26] Downloading', imagesToProcess.length, 'images in parallel...');
    const downloadResults = await Promise.all(
      imagesToProcess.map(async (imgUrl, i) => {
        try {
          const buffer = await downloadImageBuffer(imgUrl);
          return { index: i, url: imgUrl, buffer: buffer || null, failed: !buffer };
        } catch(e) {
          console.log(`  Image ${i+1} download failed: ${e.message}`);
          return { index: i, url: imgUrl, buffer: null, failed: true };
        }
      })
    );

    // Phase 2 — upload all downloaded images in parallel
    console.log('[v26] Uploading', downloadResults.filter(r => !r.failed).length, 'images to Supabase...');
    const timestamp = Date.now();
    const uploadResults = await Promise.all(
      downloadResults.map(async (dl, i) => {
        if (dl.failed) return { index: i, url: dl.url, failed: true };
        try {
          const filename = `onboarding/${timestamp}-${i}.jpg`;
          const sbUrl = await uploadToSupabase(dl.buffer, filename);
          if (sbUrl) {
            console.log(`  Image ${i+1}: ${sbUrl.substring(0, 80)}`);
            return { index: i, url: sbUrl };
          }
        } catch(e) { console.log(`  Image ${i+1} upload failed: ${e.message}`); }
        return { index: i, url: dl.url, failed: true };
      })
    );

    uploadResults.forEach(r => { if (!r.failed) data.images[r.index] = r.url; });
    // Skip hero_image — og:image is Airbnb's branding placeholder, not the actual listing hero
    data.hero_image = null;
  }

  return { success: true, data };
}

// ── HTTP Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 6905;
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, bucket: SB_BUCKET }));
    return;
  }

  if (parsedUrl.pathname.startsWith('/scrape')) {
    const targetUrl = parsedUrl.query.url;
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing url param' }));
      return;
    }
    console.log('\n[SCRAPE]', targetUrl);
    const result = await scrapeListing(targetUrl);
    setImmediate(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Preview endpoint — renders scraped data as a formatted HTML page
  if (parsedUrl.pathname === '/preview' || parsedUrl.pathname === '/') {
    const targetUrl = parsedUrl.query.url;
    if (!targetUrl) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getPreviewForm());
      return;
    }
    console.log('\n[PREVIEW]', targetUrl);
    const result = await scrapeListing(targetUrl);
    setImmediate(() => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getPreviewHtml(targetUrl, result));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\nAirbnb scraper v26 (parallel downloads + retry) — Sep 9, 2026`);
  console.log(`Port: ${PORT} | Bucket: ${SB_BUCKET}`);
  console.log(`Fields: title, description, images, rating, reviews, location (no price/beds - GraphQL blocked)\n`);
});

// ── HTML Preview ───────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

function getStars(rating) {
  const full = Math.floor(rating || 0);
  const half = (rating % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function getPreviewForm() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airbnb Scraper Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; color: #222; min-height: 100vh; }
  .container { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .subtitle { color: #717171; font-size: 14px; margin-bottom: 32px; }
  .form-card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,.08); margin-bottom: 24px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #222; }
  input[type="url"] { width: 100%; padding: 12px 16px; border: 1px solid #b0b0b0; border-radius: 8px; font-size: 15px; outline: none; transition: border-color 0.2s; }
  input[type="url"]:focus { border-color: #ff385c; box-shadow: 0 0 0 3px rgba(255,56,92,.15); }
  .btn { display: inline-flex; align-items: center; gap: 8px; margin-top: 16px; background: #ff385c; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
  .btn:hover { background: #e61f4d; }
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 40px; }
  .feature { background: #fff; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .feature-icon { font-size: 28px; margin-bottom: 8px; }
  .feature-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .feature-desc { font-size: 12px; color: #717171; }
  .note { margin-top: 32px; padding: 16px; background: #fffbeb; border-radius: 8px; font-size: 13px; color: #7c5c00; border-left: 4px solid #f6c93b; }
</style>
</head>
<body>
<div class="container">
  <h1>🔍 Airbnb Listing Scraper</h1>
  <p class="subtitle">See exactly what data is extracted from any public Airbnb listing</p>

  <div class="form-card">
    <form method="get" action="/preview">
      <label for="url">Airbnb listing URL</label>
      <input type="url" id="url" name="url" placeholder="https://www.airbnb.com/rooms/XXXXX" required value="">
      <button type="submit" class="btn">Scrape & Preview →</button>
    </form>
  </div>

  <div class="features">
    <div class="feature">
      <div class="feature-icon">📋</div>
      <div class="feature-title">Title & Location</div>
      <div class="feature-desc">Listing name, city, region</div>
    </div>
    <div class="feature">
      <div class="feature-icon">⭐</div>
      <div class="feature-title">Rating & Reviews</div>
      <div class="feature-desc">Star rating + review count</div>
    </div>
    <div class="feature">
      <div class="feature-icon">📝</div>
      <div class="feature-title">Description</div>
      <div class="feature-desc">First 2000 characters</div>
    </div>
    <div class="feature">
      <div class="feature-icon">🖼️</div>
      <div class="feature-title">Images</div>
      <div class="feature-desc">Up to 8 photos, hosted on Supabase</div>
    </div>
    <div class="feature">
      <div class="feature-icon">📍</div>
      <div class="feature-title">Coordinates</div>
      <div class="feature-desc">Lat/lng for map display</div>
    </div>
    <div class="feature">
      <div class="feature-icon">🚫</div>
      <div class="feature-title">Price & Rooms</div>
      <div class="feature-desc">Blocked by Airbnb GraphQL</div>
    </div>
  </div>

  <div class="note">
    <strong>Note:</strong> Only public listing data is extractable. Price, bedrooms, beds, baths, and amenities are blocked by Airbnb and cannot be scraped.
  </div>
</div>
</body>
</html>`;
}

function getPreviewHtml(targetUrl, result) {
  const d = result.data || {};
  const error = d.error || (result.success === false ? 'Unknown error' : null);
  const brandColor = '#ff385c';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title || 'Scraped Listing')} — Propbook Scraper</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; color: #222; }
  .topbar { background: ${brandColor}; padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
  .topbar-logo { color: #fff; font-weight: 700; font-size: 16px; }
  .topbar-url { color: rgba(255,255,255,0.8); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .container { max-width: 760px; margin: 0 auto; padding: 32px 20px; }

  /* Hero image */
  .listing-header { margin-bottom: 24px; }
  .listing-title { font-size: 26px; font-weight: 700; color: #222; line-height: 1.3; }
  .listing-location { font-size: 15px; color: #717171; margin-top: 6px; }

  /* Stats row */
  .stats { display: flex; gap: 0; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,.07); margin-bottom: 28px; }
  .stat { flex: 1; padding: 16px 20px; border-right: 1px solid #eee; text-align: center; }
  .stat:last-child { border-right: none; }
  .stat-value { font-size: 20px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #717171; margin-top: 2px; }

  /* Grid layout */
  .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 600px) { .layout { grid-template-columns: 1fr; } }

  /* Cards */
  .card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 6px rgba(0,0,0,.07); }
  .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #717171; margin-bottom: 10px; }
  .card-value { font-size: 15px; font-weight: 500; line-height: 1.5; }
  .card-value.muted { color: #717171; font-style: italic; }

  /* Description */
  .description { grid-column: 1 / -1; }
  .description-text { font-size: 14px; line-height: 1.7; color: #444; white-space: pre-wrap; max-height: 200px; overflow: hidden; position: relative; }
  .description-text::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 40px; background: linear-gradient(transparent, #fff); }

  /* Gallery */
  .gallery { grid-column: 1 / -1; }
  .gallery-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
  .gallery-img-wrap { aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer; transition: transform 0.2s; background: #eee; }
  .gallery-img-wrap:hover { transform: scale(1.05); }
  .gallery-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .gallery-more { aspect-ratio: 1; border-radius: 8px; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 18px; font-weight: 600; }

  /* Coordinates */
  .coords { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .coord-tag { background: #f0f0f0; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-family: monospace; }

  /* Error */
  .error-box { background: #fff0f0; border: 1px solid #fcc; border-radius: 12px; padding: 24px; text-align: center; }
  .error-icon { font-size: 40px; margin-bottom: 12px; }
  .error-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #c00; }
  .error-desc { font-size: 14px; color: #666; }

  /* Footer */
  .footer { text-align: center; margin-top: 40px; font-size: 12px; color: #b0b0b0; }
  .footer a { color: ${brandColor}; text-decoration: none; }
  .back-link { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 20px; color: ${brandColor}; text-decoration: none; font-size: 14px; font-weight: 500; }

  /* JSON toggle */
  .json-toggle { text-align: center; margin-top: 20px; }
  .json-toggle button { background: none; border: 1px solid #ddd; padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; color: #555; }
  .json-toggle button:hover { background: #f5f5f5; }
  .json-box { display: none; margin-top: 16px; background: #1a1a2e; color: #a0e0a0; padding: 20px; border-radius: 10px; font-family: monospace; font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre-wrap; text-align: left; }
</style>
</head>
<body>

<div class="topbar">
  <span class="topbar-logo">🔍 Propbook Scraper</span>
  <span class="topbar-url">${esc(targetUrl)}</span>
</div>

<div class="container">
  <a href="/preview" class="back-link">← Try another listing</a>

  ${error ? `
  <div class="error-box">
    <div class="error-icon">⚠️</div>
    <div class="error-title">Scraping Failed</div>
    <div class="error-desc">${esc(error)}</div>
  </div>` : `

  <div class="listing-header">
    <div class="listing-title">${esc(d.title)}</div>
    ${d.location ? `<div class="listing-location">${esc(d.location)}</div>` : ''}
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${d.rating ? getStars(d.rating) + ' ' + d.rating : '—'}</div>
      <div class="stat-label">${d.reviews ? d.reviews.toLocaleString() + ' reviews' : 'No rating'}</div>
    </div>
    <div class="stat">
      <div class="stat-value">${esc(d.location || '—')}</div>
      <div class="stat-label">Location</div>
    </div>
    <div class="stat">
      <div class="stat-value">${d.guests ? d.guests + ' guests' : '—'}</div>
      <div class="stat-label">Max occupancy</div>
    </div>
  </div>

  <div class="layout">
    <div class="card">
      <div class="card-title">Scraped Field</div>
      <div class="card-value">${esc(d.title || '—')}</div>
    </div>
    <div class="card">
      <div class="card-title">Location</div>
      <div class="card-value">${esc(d.location || '—')}</div>
    </div>
    <div class="card">
      <div class="card-title">Currency</div>
      <div class="card-value">${esc(d.currency || '—')}</div>
    </div>
    <div class="card">
      <div class="card-title">Max Guests</div>
      <div class="card-value">${d.guests ? esc(String(d.guests)) : '<span class="muted">Blocked by Airbnb</span>'}</div>
    </div>
    <div class="card description">
      <div class="card-title">Description (first 2000 chars)</div>
      <div class="description-text">${esc(d.description || '—')}</div>
    </div>

    ${d.lat ? `<div class="card">
      <div class="card-title">Coordinates</div>
      <div class="coords">
        <span class="coord-tag">${esc(String(d.lat))}</span>
        <span class="coord-tag">${esc(String(d.lng))}</span>
      </div>
    </div>` : ''}

    ${d.host_name ? `<div class="card">
      <div class="card-title">Host Name</div>
      <div class="card-value">${esc(d.host_name)}</div>
    </div>` : ''}

    <div class="card">
      <div class="card-title">Price</div>
      <div class="card-value muted">Blocked by Airbnb GraphQL</div>
    </div>
    <div class="card">
      <div class="card-title">Bedrooms / Beds / Baths</div>
      <div class="card-value muted">Blocked by Airbnb GraphQL</div>
    </div>

    <div class="card gallery">
      <div class="card-title">Gallery (${d.images ? d.images.length : 0} images — Supabase hosted)</div>
      <div class="gallery-grid">
        ${(d.images || []).slice(0, 7).map((img, i) => `<a href="${esc(img)}" target="_blank" class="gallery-img-wrap"><img class="gallery-img" src="${esc(img)}" alt="Image ${i+1}" onerror="this.parentElement.style.display='none'"></a>`).join('')}
        ${d.images && d.images.length > 7 ? `<div class="gallery-img-wrap gallery-more">+${d.images.length - 7}</div>` : ''}
        ${(!d.images || d.images.length === 0) ? '<div class="muted" style="grid-column:1/-1;font-size:13px;color:#999;text-align:center;padding:20px">No images scraped</div>' : ''}
      </div>
    </div>
  </div>

  <div class="json-toggle">
    <button onclick="const b=document.getElementById('json');b.style.display=b.style.display==='none'?'block':'none'">📄 Show raw JSON</button>
    <div id="json" class="json-box">${esc(JSON.stringify(result, null, 2))}</div>
  </div>
  `}
</div>

<div class="footer">
  Propbook Airbnb Scraper v26 — powered by <a href="https://propbook.pro">propbook.pro</a>
</div>

</body>
</html>`;
}
