# Airbnb Scraper — Definitive Service
**Last updated:** April 10, 2026
**Status:** Working — price needs fixing

## Location
`/Users/davidsassistant/.openclaw/workspace/projects/airbnb-scraper/`

## Start Command
```bash
cd /Users/davidsassistant/.openclaw/workspace/projects/airbnb-scraper && node server.js
```
**Port:** 6904

## API
- `GET /scrape?url=https://www.airbnb.com/rooms/XXXXX`
- Returns JSON: `{ success: true, data: { title, location, price, hero_image, images, description, ... } }`
- `GET /health` — health check

## What's Working (April 10, 2026)
- Title scraping ✓
- Hero image (converts to base64 to bypass CORS) ✓
- Image URLs from meta tags ✓
- Location from h2 ✓

## Needs Fixing
- Price extraction (returns null)
- Description extraction (not captured)
- Review count extraction

## Test URLs
```
https://www.airbnb.com/rooms/40551862
https://www.airbnb.com/rooms/670576704094588867
https://www.airbnb.com/rooms/1230061019276288869
https://www.airbnb.com/rooms/494903
```

## Architecture
- Node.js + Playwright (chromium headless)
- Single server file: `server.js`
- Uses `?url=` query param (GET request)
- Converts hero image to base64 for CORS-free embedding
