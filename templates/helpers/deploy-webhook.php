<?php
/**
 * Stack-owned deploy webhook front controller.
 * Mounted read-only outside /home/<app>. Verifies HMAC over raw body and enqueues.
 * Does not perform deployment work.
 */
declare(strict_types=1);

const MAX_BODY = 262144; // 256 KiB

function respond(int $code, array $body): never {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(404, ['error' => 'not found']);
}

$app = $_SERVER['BENTO_APP'] ?? '';
$secret = $_SERVER['BENTO_DEPLOY_SECRET'] ?? '';
// FastCGI parameters appear in $_SERVER; the environment fallback also makes
// the same stack-owned controller testable under PHP's built-in HTTP server.
if ($app === '') {
    $fromEnv = getenv('BENTO_APP');
    $app = is_string($fromEnv) ? $fromEnv : '';
}
if ($secret === '') {
    $fromEnv = getenv('BENTO_DEPLOY_SECRET');
    $secret = is_string($fromEnv) ? $fromEnv : '';
}
if ($app === '' || $secret === '') {
    respond(404, ['error' => 'not found']);
}

$raw = file_get_contents('php://input');
if ($raw === false) {
    respond(400, ['error' => 'bad request']);
}
if (strlen($raw) > MAX_BODY) {
    respond(413, ['error' => 'payload too large']);
}

$sig256 = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$sig = $_SERVER['HTTP_X_HUB_SIGNATURE'] ?? '';
$valid = false;
foreach ([$sig256, $sig] as $header) {
    if ($header === '') {
        continue;
    }
    if (preg_match('/^(sha256|sha1)=([0-9a-fA-F]+)$/', trim($header), $m)) {
        $algo = $m[1] === 'sha256' ? 'sha256' : 'sha1';
        $expected = hash_hmac($algo, $raw, $secret);
        if (hash_equals(strtolower($expected), strtolower($m[2]))) {
            $valid = true;
            break;
        }
    }
}
if (!$valid) {
    respond(401, ['error' => 'unauthorized']);
}

$home = '/home/' . $app;
$queuePath = $home . '/.bento/queue.json';
$lockPath = $home . '/.bento/queue.lock';
$bentoDir = $home . '/.bento';

if (!is_dir($bentoDir)) {
    respond(500, ['error' => 'queue unavailable']);
}

$fp = fopen($lockPath, 'c+');
if ($fp === false) {
    respond(500, ['error' => 'lock failed']);
}
if (!flock($fp, LOCK_EX)) {
    fclose($fp);
    respond(500, ['error' => 'lock failed']);
}

try {
    $queue = ['schemaVersion' => 1, 'jobs' => []];
    if (is_file($queuePath)) {
        $decoded = json_decode((string)file_get_contents($queuePath), true);
        if (is_array($decoded) && ($decoded['schemaVersion'] ?? null) === 1) {
            $queue = $decoded;
        }
    }

    $deployMetaPath = $home . '/.bento/deploy.json';
    $policy = 'latest';
    if (is_file($deployMetaPath)) {
        $meta = json_decode((string)file_get_contents($deployMetaPath), true);
        if (is_array($meta) && isset($meta['queuePolicy'])) {
            $policy = $meta['queuePolicy'];
        }
    }

    $queued = array_values(array_filter($queue['jobs'], fn($j) => ($j['status'] ?? '') === 'queued'));
    if ($policy === 'fifo' && count($queued) >= 20) {
        respond(429, ['error' => 'queue full']);
    }

    if ($policy === 'latest') {
        foreach ($queue['jobs'] as &$j) {
            if (($j['status'] ?? '') === 'queued') {
                $j['status'] = 'failed';
                $j['error'] = 'superseded';
                $j['finishedAt'] = gmdate('c');
            }
        }
        unset($j);
    }

    $id = 'dep_' . bin2hex(random_bytes(8));
    $job = [
        'id' => $id,
        'status' => 'queued',
        'receivedAt' => gmdate('c'),
        'deliveryId' => $_SERVER['HTTP_X_GITHUB_DELIVERY'] ?? null,
        'contentType' => $_SERVER['CONTENT_TYPE'] ?? null,
        'payloadHash' => hash('sha256', $raw),
        'payloadPreview' => substr($raw, 0, 512),
        'logName' => "deploy-{$id}.log",
    ];
    // Never store authorization headers
    $queue['jobs'][] = $job;

    $payloadFile = $bentoDir . "/payload-{$id}.json";
    file_put_contents($payloadFile, $raw);
    chmod($payloadFile, 0600);

    file_put_contents($queuePath, json_encode($queue, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    chmod($queuePath, 0600);

    respond(202, ['id' => $id, 'status' => 'queued']);
} finally {
    flock($fp, LOCK_UN);
    fclose($fp);
}
