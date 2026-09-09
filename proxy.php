<?php
/**
 * Scraper proxy — forwards /scraper/ requests to the actual scraper server.
 * Usage: GET /scrape?url=https://www.airbnb.com/rooms/XXXXX
 *        GET /health
 */

$SCRAPER_BACKEND = 'https://airbnb-scraper-foj1.onrender.com';

// Build the path being accessed under /scraper/
// REQUEST_URI = /scraper/scrape?url=...
$requestUri = $_SERVER['REQUEST_URI'];  // e.g. "/scraper/scrape?url=..."
$path = parse_url($requestUri, PHP_URL_PATH);  // e.g. "/scraper/scrape"
// Strip /scraper prefix → forward path becomes "/scrape"
$forwardPath = preg_replace('#^/scraper#', '', $path);
if (!$forwardPath || $forwardPath === '/') {
    $forwardPath = '/scrape'; // default to /scrape endpoint
}

// Build backend URL
$backendUrl = $SCRAPER_BACKEND . $forwardPath;
if (!empty($_SERVER['QUERY_STRING'])) {
    $backendUrl .= '?' . $_SERVER['QUERY_STRING'];
}

// Forward request using cURL (more reliable than file_get_contents for proxies)
$ch = curl_init();
curl_setopt_array($ch, [
    CURL_URL => $backendUrl,
    CURL_RETURNTRANSFER => true,
    CURL_TIMEOUT => 20,
    CURL_CONNECTTIMEOUT => 10,
    CURL_SSL_VERIFYPEER => true,
    CURL_HTTPHEADER => [
        'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept: application/json, text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language: en-US,en;q=0.9',
    ],
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$curlError = curl_error($ch);
curl_close($ch);

if ($curlError) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Proxy error: ' . $curlError]);
    exit;
}

// Forward the HTTP status
http_response_code((int)$httpCode);
header('Content-Type: ' . ($contentType ?: 'application/json'));
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
echo $response;
