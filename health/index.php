<?php
/**
 * /scraper/health — proxy health check to Render v26 backend
 */
$SCRAPER_BACKEND = 'https://propbook-scraper.onrender.com';

$backendUrl = $SCRAPER_BACKEND . '/health';

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $backendUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept: application/json',
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

http_response_code((int)$httpCode);
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
echo $response ?: json_encode(['status' => 'ok', 'via' => 'hostinger-proxy']);
