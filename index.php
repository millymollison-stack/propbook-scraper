<?php
/**
 * Scraper proxy root — use /scrape or /health endpoints
 */
http_response_code(200);
header('Content-Type: application/json');
echo json_encode([
    'service' => 'propbook-scraper-proxy',
    'version' => '1.0',
    'endpoints' => [
        '/scrape?url=https://www.airbnb.com/rooms/XXXXX',
        '/health',
    ],
    'backend' => 'https://airbnb-scraper-foj1.onrender.com',
]);
