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
    // Hero = first successfully uploaded image
    const firstSuccess = uploadResults.find(r => !r.failed);
    if (firstSuccess) data.hero_image = firstSuccess.url;
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

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`\nAirbnb scraper v26 (parallel downloads + retry) — Sep 9, 2026`);
  console.log(`Port: ${PORT} | Bucket: ${SB_BUCKET}`);
  console.log(`Fields: title, description, images, rating, reviews, location (no price/beds - GraphQL blocked)\n`);
});
