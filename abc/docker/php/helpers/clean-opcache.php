<?php
/**
 * Stack-owned OPcache reset endpoint for the app's own FPM pool.
 * Invoked via direct FastCGI to the app socket after deploy.
 */
declare(strict_types=1);

header('Content-Type: application/json');

if (function_exists('opcache_reset')) {
    $ok = opcache_reset();
    echo json_encode(['ok' => (bool)$ok, 'detail' => $ok ? 'reset' : 'reset returned false']);
    exit;
}

echo json_encode(['ok' => false, 'detail' => 'opcache_reset unavailable']);
