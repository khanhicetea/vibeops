<?php
/**
 * Stack-owned bento internal front controller.
 *
 * Mounted read-only at /usr/local/lib/bento/index.php and exposed only under
 * location ^~ /_bento when deploy (or other internal features) are enabled.
 *
 * Routes:
 *   POST /_bento/deploy          — enqueue a deploy job (HMAC auth)
 *   POST /_bento/clean-opcache   — reset FPM OPcache (HMAC or recent deploy id)
 */
declare(strict_types=1);

const BENTO_MAX_BODY = 262144; // 256 KiB
const BENTO_QUEUE_RETENTION = 30;
const BENTO_FIFO_MAX_QUEUED = 20;

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$uri = (string)($_SERVER['REQUEST_URI'] ?? '/');
$path = parse_url($uri, PHP_URL_PATH) ?: '/';
$path = rtrim($path, '/') ?: '/';

$app = bento_app_name();
if ($app === null) {
    bento_json(500, ['error' => 'unable to resolve app identity']);
}

try {
    if ($path === '/_bento/deploy' && $method === 'POST') {
        bento_route_deploy($app);
    }
    if ($path === '/_bento/clean-opcache' && $method === 'POST') {
        bento_route_clean_opcache($app);
    }
    if (str_starts_with($path, '/_bento')) {
        bento_json(404, ['error' => 'unknown bento route']);
    }
    bento_json(404, ['error' => 'not found']);
} catch (Throwable $e) {
    bento_json(500, ['error' => 'internal error', 'message' => $e->getMessage()]);
}

function bento_app_name(): ?string
{
    $user = posix_getpwuid(posix_geteuid());
    $name = is_array($user) ? (string)($user['name'] ?? '') : '';
    if ($name !== '' && preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $name)) {
        return $name;
    }
    $env = (string)(getenv('bento_APP') ?: '');
    if ($env !== '' && preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $env)) {
        return $env;
    }
    return null;
}

function bento_json(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function bento_read_body(): string
{
    $len = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($len > BENTO_MAX_BODY) {
        bento_json(413, ['error' => 'body too large']);
    }
    $raw = file_get_contents('php://input');
    if ($raw === false) {
        bento_json(400, ['error' => 'unable to read body']);
    }
    if (strlen($raw) > BENTO_MAX_BODY) {
        bento_json(413, ['error' => 'body too large']);
    }
    return $raw;
}

function bento_webhook_secret(): string
{
    // Preferred: nginx fastcgi_param DEPLOY_WEBHOOK_SECRET from stack state.
    $secret = (string)($_SERVER['DEPLOY_WEBHOOK_SECRET'] ?? '');
    if ($secret === '') {
        $secret = (string)(getenv('DEPLOY_WEBHOOK_SECRET') ?: '');
    }
    return $secret;
}

/**
 * Accept GitHub-style signatures:
 *   X-Hub-Signature-256: sha256=<hex>
 *   X-Hub-Signature: sha256=<hex> | sha1=<hex>
 */
function bento_verify_signature(string $raw, string $secret): bool
{
    if ($secret === '') {
        return false;
    }
    $headers = [
        'HTTP_X_HUB_SIGNATURE_256' => (string)($_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? ''),
        'HTTP_X_HUB_SIGNATURE' => (string)($_SERVER['HTTP_X_HUB_SIGNATURE'] ?? ''),
    ];
    foreach ($headers as $header) {
        if ($header === '') {
            continue;
        }
        if (!preg_match('/^(sha256|sha1)=([0-9a-fA-F]+)$/', trim($header), $m)) {
            continue;
        }
        $algo = strtolower($m[1]);
        $expected = hash_hmac($algo, $raw, $secret);
        if (hash_equals(strtolower($expected), strtolower($m[2]))) {
            return true;
        }
    }
    return false;
}

function bento_queue_path(string $app): string
{
    return "/home/{$app}/.bento/queue.json";
}

/**
 * @return resource
 */
function bento_queue_open(string $app, string $mode = 'c+')
{
    $dir = "/home/{$app}/.bento";
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException("cannot create {$dir}");
    }
    $path = bento_queue_path($app);
    $fh = fopen($path, $mode);
    if ($fh === false) {
        throw new RuntimeException("cannot open queue {$path}");
    }
    return $fh;
}

/**
 * @param resource $fh
 * @return array{version:int,jobs:list<array<string,mixed>>}
 */
function bento_queue_read($fh): array
{
    rewind($fh);
    $raw = stream_get_contents($fh);
    if ($raw === false || trim($raw) === '') {
        return ['version' => 1, 'jobs' => []];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return ['version' => 1, 'jobs' => []];
    }
    $jobs = $data['jobs'] ?? [];
    if (!is_array($jobs)) {
        $jobs = [];
    }
    return ['version' => (int)($data['version'] ?? 1), 'jobs' => array_values($jobs)];
}

/**
 * @param resource $fh
 * @param array{version:int,jobs:list<array<string,mixed>>} $queue
 */
function bento_queue_write($fh, array $queue): void
{
    $jobs = array_values($queue['jobs'] ?? []);
    // Keep newest terminal jobs + all active; overall cap BENTO_QUEUE_RETENTION.
    if (count($jobs) > BENTO_QUEUE_RETENTION) {
        $active = [];
        $terminal = [];
        foreach ($jobs as $job) {
            if (!is_array($job)) {
                continue;
            }
            $status = (string)($job['status'] ?? '');
            if (in_array($status, ['queued', 'running'], true)) {
                $active[] = $job;
            } else {
                $terminal[] = $job;
            }
        }
        usort($terminal, static function (array $a, array $b): int {
            return strcmp((string)($b['finished_at'] ?? $b['received_at'] ?? ''), (string)($a['finished_at'] ?? $a['received_at'] ?? ''));
        });
        $keepTerminal = max(0, BENTO_QUEUE_RETENTION - count($active));
        $jobs = array_merge($active, array_slice($terminal, 0, $keepTerminal));
    }
    $payload = json_encode(
        ['version' => (int)($queue['version'] ?? 1), 'jobs' => $jobs],
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
    ) . "\n";
    rewind($fh);
    ftruncate($fh, 0);
    fwrite($fh, $payload);
    fflush($fh);
}

function bento_new_job_id(): string
{
    try {
        return bin2hex(random_bytes(16));
    } catch (Throwable) {
        return str_replace('.', '', uniqid('d', true));
    }
}

function bento_now(): string
{
    return gmdate('c');
}

function bento_queue_policy(): string
{
    $policy = strtolower(trim((string)($_SERVER['DEPLOY_QUEUE_POLICY'] ?? 'latest')));
    return in_array($policy, ['latest', 'fifo'], true) ? $policy : 'latest';
}

function bento_route_deploy(string $app): never
{
    $secret = bento_webhook_secret();
    $raw = bento_read_body();
    if ($secret === '' || !bento_verify_signature($raw, $secret)) {
        bento_json(401, ['error' => 'invalid signature']);
    }

    $payload = null;
    $trimmed = trim($raw);
    if ($trimmed !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $payload = $decoded;
        }
    }

    $id = bento_new_job_id();
    $logFile = "deploy-{$id}.log";
    $job = [
        'id' => $id,
        'status' => 'queued',
        'received_at' => bento_now(),
        'started_at' => null,
        'finished_at' => null,
        'exit_code' => null,
        'error' => null,
        'log_file' => $logFile,
        'request' => [
            'method' => 'POST',
            'content_type' => (string)($_SERVER['CONTENT_TYPE'] ?? ''),
            'content_length' => strlen($raw),
            'delivery_id' => (string)($_SERVER['HTTP_X_GITHUB_DELIVERY'] ?? $_SERVER['HTTP_X_GITLAB_EVENT_UUID'] ?? ''),
            'payload_sha256' => hash('sha256', $raw),
            'payload' => $payload,
            'raw_truncated' => strlen($raw) > 4096 ? null : $raw,
        ],
    ];

    $fh = bento_queue_open($app);
    try {
        if (!flock($fh, LOCK_EX)) {
            bento_json(503, ['error' => 'queue lock busy']);
        }
        $queue = bento_queue_read($fh);
        $jobs = $queue['jobs'];
        $policy = bento_queue_policy();

        if ($policy === 'latest') {
            foreach ($jobs as &$existing) {
                if (!is_array($existing)) {
                    continue;
                }
                if (($existing['status'] ?? '') === 'queued') {
                    $existing['status'] = 'failed';
                    $existing['error'] = 'superseded';
                    $existing['finished_at'] = bento_now();
                    $existing['exit_code'] = null;
                }
            }
            unset($existing);
        } else {
            $queued = 0;
            foreach ($jobs as $existing) {
                if (is_array($existing) && ($existing['status'] ?? '') === 'queued') {
                    $queued++;
                }
            }
            if ($queued >= BENTO_FIFO_MAX_QUEUED) {
                flock($fh, LOCK_UN);
                fclose($fh);
                bento_json(429, ['error' => 'queue full']);
            }
        }

        $jobs[] = $job;
        $queue['jobs'] = $jobs;
        bento_queue_write($fh, $queue);
        flock($fh, LOCK_UN);
    } finally {
        fclose($fh);
    }

    bento_json(202, ['id' => $id, 'status' => 'queued']);
}

function bento_route_clean_opcache(string $app): never
{
    $raw = bento_read_body();
    $secret = bento_webhook_secret();
    $authorized = $secret !== '' && bento_verify_signature($raw, $secret);

    if (!$authorized) {
        // Allow drain to clean using a recent job id (no secret file required).
        $deployId = (string)($_SERVER['HTTP_X_BENTO_DEPLOY_ID'] ?? '');
        if ($deployId === '' && $raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $deployId = (string)($decoded['deploy_id'] ?? $decoded['id'] ?? '');
            }
        }
        if ($deployId === '' || !bento_recent_deploy_id($app, $deployId)) {
            bento_json(401, ['error' => 'invalid signature or deploy id']);
        }
    }

    $reset = false;
    if (function_exists('opcache_reset')) {
        $reset = (bool)opcache_reset();
    }
    bento_json(200, ['ok' => true, 'opcache_reset' => $reset]);
}

function bento_recent_deploy_id(string $app, string $id): bool
{
    $path = bento_queue_path($app);
    if (!is_file($path)) {
        return false;
    }
    $fh = fopen($path, 'r');
    if ($fh === false) {
        return false;
    }
    try {
        if (!flock($fh, LOCK_SH)) {
            return false;
        }
        $queue = bento_queue_read($fh);
        flock($fh, LOCK_UN);
    } finally {
        fclose($fh);
    }
    $cutoff = time() - 3600;
    foreach ($queue['jobs'] as $job) {
        if (!is_array($job) || (string)($job['id'] ?? '') !== $id) {
            continue;
        }
        $status = (string)($job['status'] ?? '');
        if (!in_array($status, ['running', 'success', 'failed', 'skipped'], true)) {
            return false;
        }
        $ts = strtotime((string)($job['finished_at'] ?? $job['started_at'] ?? $job['received_at'] ?? '')) ?: 0;
        return $ts >= $cutoff || $status === 'running';
    }
    return false;
}
