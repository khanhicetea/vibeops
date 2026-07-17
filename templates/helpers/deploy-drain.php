<?php
/**
 * Container-local deploy queue drain.
 *
 * This helper intentionally has no dependency on the Bento control-plane binary.
 * It runs as the app UID in the versioned runner, executes one queued hook, and
 * resets OPcache by speaking FastCGI directly to that app's FPM Unix socket.
 */
declare(strict_types=1);

const BENTO_DEPLOY_SCHEMA = 1;
const BENTO_DEPLOY_GRACE_SEC = 30;
const BENTO_DEPLOY_RETENTION = 30;
const BENTO_FASTCGI_TIMEOUT_SEC = 5;

function nowIso(): string {
    return gmdate('Y-m-d\TH:i:s\Z');
}

function readJsonFile(string $path): array {
    $text = @file_get_contents($path);
    if ($text === false) {
        throw new RuntimeException("unable to read {$path}");
    }
    try {
        $value = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        throw new RuntimeException("invalid JSON in {$path}: {$e->getMessage()}", 0, $e);
    }
    if (!is_array($value)) {
        throw new RuntimeException("invalid object in {$path}");
    }
    return $value;
}

function loadQueueFile(string $path): array {
    if (!is_file($path)) {
        return ['schemaVersion' => BENTO_DEPLOY_SCHEMA, 'jobs' => []];
    }
    $queue = readJsonFile($path);
    if (($queue['schemaVersion'] ?? null) !== BENTO_DEPLOY_SCHEMA || !isset($queue['jobs']) || !is_array($queue['jobs'])) {
        throw new RuntimeException("invalid deploy queue schema in {$path}");
    }
    foreach ($queue['jobs'] as $job) {
        if (!is_array($job)) {
            throw new RuntimeException("invalid deploy job in {$path}");
        }
    }
    return $queue;
}

function atomicWriteJson(string $path, array $value): void {
    try {
        $json = json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
    } catch (JsonException $e) {
        throw new RuntimeException("unable to encode {$path}: {$e->getMessage()}", 0, $e);
    }
    $tmp = dirname($path) . '/.' . basename($path) . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';
    try {
        $written = @file_put_contents($tmp, $json);
        if ($written === false || $written !== strlen($json)) {
            throw new RuntimeException("unable to write {$tmp}");
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) {
            throw new RuntimeException("unable to replace {$path}");
        }
    } finally {
        if (is_file($tmp)) {
            @unlink($tmp);
        }
    }
}

/** Execute a callback while holding the queue's exclusive lock. */
function withQueueLock(string $bentoDir, callable $callback): mixed {
    $lockPath = $bentoDir . '/queue.lock';
    $lock = @fopen($lockPath, 'c+');
    if ($lock === false) {
        throw new RuntimeException("unable to open {$lockPath}");
    }
    @chmod($lockPath, 0600);
    if (!flock($lock, LOCK_EX)) {
        fclose($lock);
        throw new RuntimeException("unable to lock {$lockPath}");
    }
    try {
        return $callback();
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function retainJobs(array $jobs): array {
    $active = [];
    $terminal = [];
    foreach ($jobs as $job) {
        $status = (string)($job['status'] ?? '');
        if ($status === 'queued' || $status === 'running') {
            $active[] = $job;
        } else {
            $terminal[] = $job;
        }
    }
    usort($terminal, static function (array $a, array $b): int {
        $left = (string)($a['finishedAt'] ?? $a['receivedAt'] ?? '');
        $right = (string)($b['finishedAt'] ?? $b['receivedAt'] ?? '');
        return strcmp($right, $left);
    });
    $terminalLimit = max(0, BENTO_DEPLOY_RETENTION - count($active));
    return array_merge($active, array_slice($terminal, 0, $terminalLimit));
}

function appendDeployLog(string $path, string $message): void {
    $written = @file_put_contents($path, $message, FILE_APPEND | LOCK_EX);
    if ($written === false) {
        throw new RuntimeException("unable to append {$path}");
    }
}

function isInsideHome(string $home, string $path): bool {
    if ($path !== $home && !str_starts_with($path, $home . '/')) {
        return false;
    }
    $realHome = realpath($home);
    $realPath = realpath($path);
    if ($realHome === false || $realPath === false) {
        return false;
    }
    return $realPath === $realHome || str_starts_with($realPath, $realHome . DIRECTORY_SEPARATOR);
}

/** Run the trusted argv without a shell and enforce the configured timeout. */
function runDeployHook(array $argv, array $env, string $workdir, string $home, int $timeoutSec, string $logPath): array {
    if ($argv === [] || array_filter($argv, static fn ($v): bool => !is_string($v)) !== []) {
        throw new RuntimeException('deploy argv must be a non-empty string array');
    }
    if (!is_dir($workdir) || !isInsideHome($home, $workdir)) {
        throw new RuntimeException("deploy workdir is missing or outside app home: {$workdir}");
    }

    appendDeployLog($logPath, '[' . nowIso() . "] deploy hook started\n");
    $descriptors = [
        0 => ['file', '/dev/null', 'r'],
        1 => ['file', $logPath, 'a'],
        2 => ['file', $logPath, 'a'],
    ];
    $process = @proc_open($argv, $descriptors, $pipes, $workdir, $env, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        throw new RuntimeException('unable to start deploy hook');
    }

    $deadline = microtime(true) + $timeoutSec;
    $exitCode = -1;
    $timedOut = false;
    try {
        while (true) {
            $status = proc_get_status($process);
            if (!$status['running']) {
                $exitCode = (int)$status['exitcode'];
                break;
            }
            if (microtime(true) >= $deadline) {
                $timedOut = true;
                proc_terminate($process, 15);
                $termDeadline = microtime(true) + 2.0;
                do {
                    usleep(100000);
                    $status = proc_get_status($process);
                } while ($status['running'] && microtime(true) < $termDeadline);
                if ($status['running']) {
                    proc_terminate($process, 9);
                }
                break;
            }
            usleep(100000);
        }
    } finally {
        $closed = proc_close($process);
    }

    if ($timedOut) {
        appendDeployLog($logPath, "deploy hook timed out after {$timeoutSec}s\n");
        return ['code' => 124, 'error' => 'timeout'];
    }
    if ($exitCode < 0) {
        $exitCode = (int)$closed;
    }
    return ['code' => $exitCode, 'error' => null];
}

function fastcgiLength(int $length): string {
    if ($length < 128) {
        return chr($length);
    }
    return pack('N', $length | 0x80000000);
}

function fastcgiParams(array $params): string {
    $content = '';
    foreach ($params as $name => $value) {
        $name = (string)$name;
        $value = (string)$value;
        $content .= fastcgiLength(strlen($name));
        $content .= fastcgiLength(strlen($value));
        $content .= $name . $value;
    }
    return $content;
}

function fastcgiRecord(int $type, int $requestId, string $content): string {
    $length = strlen($content);
    if ($length > 65535) {
        throw new RuntimeException('FastCGI record is too large');
    }
    $padding = (8 - ($length % 8)) % 8;
    return pack('CCnnCC', 1, $type, $requestId, $length, $padding, 0) . $content . str_repeat("\0", $padding);
}

function writeAll($stream, string $data): void {
    $offset = 0;
    $length = strlen($data);
    while ($offset < $length) {
        $written = @fwrite($stream, substr($data, $offset));
        if ($written === false || $written === 0) {
            throw new RuntimeException('FastCGI socket write failed');
        }
        $offset += $written;
    }
}

function readExact($stream, int $length): string {
    $data = '';
    while (strlen($data) < $length) {
        $chunk = @fread($stream, $length - strlen($data));
        if ($chunk === false || $chunk === '') {
            $meta = stream_get_meta_data($stream);
            $reason = ($meta['timed_out'] ?? false) ? 'timed out' : 'closed';
            throw new RuntimeException("FastCGI socket {$reason}");
        }
        $data .= $chunk;
    }
    return $data;
}

/** Reset OPcache in the selected FPM pool via its Unix socket. */
function resetOpcache(string $socketPath, string $app, string $deployId): array {
    if (!str_starts_with($socketPath, '/run/php-fpm/') || !str_ends_with($socketPath, '/' . $app . '.sock')) {
        return ['ok' => false, 'detail' => 'invalid app FPM socket path'];
    }
    $errno = 0;
    $error = '';
    $socket = @stream_socket_client(
        'unix://' . $socketPath,
        $errno,
        $error,
        BENTO_FASTCGI_TIMEOUT_SEC,
        STREAM_CLIENT_CONNECT,
    );
    if ($socket === false) {
        return ['ok' => false, 'detail' => "socket connect failed ({$errno}): {$error}"];
    }

    try {
        stream_set_timeout($socket, BENTO_FASTCGI_TIMEOUT_SEC);
        $requestId = 1;
        $begin = pack('nC6', 1, 0, 0, 0, 0, 0, 0); // responder, no keep-conn
        $params = fastcgiParams([
            'GATEWAY_INTERFACE' => 'CGI/1.1',
            'SERVER_PROTOCOL' => 'HTTP/1.1',
            'REQUEST_METHOD' => 'POST',
            'REQUEST_URI' => '/_bento/clean-opcache',
            'SCRIPT_NAME' => '/_bento/clean-opcache',
            'SCRIPT_FILENAME' => '/opt/bento/helpers/clean-opcache.php',
            'CONTENT_LENGTH' => '0',
            'REMOTE_ADDR' => '127.0.0.1',
            'SERVER_NAME' => 'bento-runner',
            'BENTO_APP' => $app,
            'BENTO_DEPLOY_ID' => $deployId,
        ]);
        writeAll($socket, fastcgiRecord(1, $requestId, $begin)); // FCGI_BEGIN_REQUEST
        writeAll($socket, fastcgiRecord(4, $requestId, $params)); // FCGI_PARAMS
        writeAll($socket, fastcgiRecord(4, $requestId, ''));
        writeAll($socket, fastcgiRecord(5, $requestId, '')); // FCGI_STDIN

        $stdout = '';
        $stderr = '';
        while (true) {
            $header = readExact($socket, 8);
            $record = unpack('Cversion/Ctype/nrequestId/ncontentLength/CpaddingLength/Creserved', $header);
            if (!is_array($record) || ($record['version'] ?? 0) !== 1) {
                throw new RuntimeException('invalid FastCGI response header');
            }
            $contentLength = (int)$record['contentLength'];
            $paddingLength = (int)$record['paddingLength'];
            $content = $contentLength > 0 ? readExact($socket, $contentLength) : '';
            if ($paddingLength > 0) {
                readExact($socket, $paddingLength);
            }
            $type = (int)$record['type'];
            if ($type === 6) {
                $stdout .= $content;
            } elseif ($type === 7) {
                $stderr .= $content;
            } elseif ($type === 3) {
                break;
            }
        }

        $parts = preg_split("/\r?\n\r?\n/", $stdout, 2);
        $body = trim((string)($parts[1] ?? $parts[0] ?? ''));
        $decoded = json_decode($body, true);
        if (!is_array($decoded) || !array_key_exists('ok', $decoded)) {
            $detail = trim($stderr !== '' ? $stderr : $body);
            return ['ok' => false, 'detail' => 'invalid FPM response: ' . substr($detail, 0, 200)];
        }
        return [
            'ok' => $decoded['ok'] === true,
            'detail' => (string)($decoded['detail'] ?? ($decoded['ok'] ? 'reset' : 'failed')),
        ];
    } catch (Throwable $e) {
        return ['ok' => false, 'detail' => $e->getMessage()];
    } finally {
        fclose($socket);
    }
}

function pruneDeployLogs(string $logsDir, array $jobs): void {
    if (!is_dir($logsDir)) {
        return;
    }
    $keep = [];
    foreach ($jobs as $job) {
        if (isset($job['logName']) && is_string($job['logName'])) {
            $keep[$job['logName']] = true;
        }
    }
    $names = @scandir($logsDir);
    if ($names === false) {
        return;
    }
    foreach ($names as $name) {
        if (str_starts_with($name, 'deploy-') && str_ends_with($name, '.log') && !isset($keep[$name])) {
            @unlink($logsDir . '/' . $name);
        }
    }
}

function drainMain(array $args): int {
    $app = (string)($args[1] ?? '');
    if (!preg_match('/^[a-z][a-z0-9-]{1,31}$/', $app)) {
        fwrite(STDERR, "usage: deploy-drain.php <app> [fpm-socket]\n");
        return 2;
    }
    $socketPath = (string)($args[2] ?? "/run/php-fpm/{$app}.sock");
    $home = "/home/{$app}";
    $bentoDir = $home . '/.bento';
    $queuePath = $bentoDir . '/queue.json';
    $configPath = $bentoDir . '/deploy.json';
    $logsDir = $home . '/logs';

    if (!is_dir($bentoDir)) {
        throw new RuntimeException("deploy directory unavailable for {$app}");
    }
    $config = readJsonFile($configPath);
    $timeoutSec = filter_var($config['timeoutSec'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    $workdir = $config['workdir'] ?? null;
    $command = $config['argv'] ?? null;
    if ($timeoutSec === false || !is_string($workdir) || !is_array($command) || $command === []) {
        throw new RuntimeException("invalid deploy configuration in {$configPath}");
    }

    $deployLockPath = $bentoDir . '/deploy.lock';
    $deployLock = @fopen($deployLockPath, 'c+');
    if ($deployLock === false) {
        throw new RuntimeException("unable to open {$deployLockPath}");
    }
    @chmod($deployLockPath, 0600);
    if (!flock($deployLock, LOCK_EX | LOCK_NB)) {
        fclose($deployLock);
        return 0; // another drain owns this app; never queue behind it
    }

    try {
        $job = withQueueLock($bentoDir, static function () use ($queuePath, $timeoutSec): ?array {
            $queue = loadQueueFile($queuePath);
            $changed = false;
            $now = time();
            foreach ($queue['jobs'] as &$candidate) {
                if (($candidate['status'] ?? '') !== 'running') {
                    continue;
                }
                $started = isset($candidate['startedAt']) ? strtotime((string)$candidate['startedAt']) : false;
                if ($started === false || $now - $started > ((int)$timeoutSec + BENTO_DEPLOY_GRACE_SEC)) {
                    $candidate['status'] = 'failed';
                    $candidate['error'] = 'interrupted';
                    $candidate['finishedAt'] = nowIso();
                    $changed = true;
                }
            }
            unset($candidate);

            foreach ($queue['jobs'] as $candidate) {
                if (($candidate['status'] ?? '') === 'running') {
                    if ($changed) {
                        atomicWriteJson($queuePath, $queue);
                    }
                    return null;
                }
            }

            $nextIndex = null;
            foreach ($queue['jobs'] as $index => $candidate) {
                if (($candidate['status'] ?? '') !== 'queued') {
                    continue;
                }
                if ($nextIndex === null || strcmp((string)($candidate['receivedAt'] ?? ''), (string)($queue['jobs'][$nextIndex]['receivedAt'] ?? '')) < 0) {
                    $nextIndex = $index;
                }
            }
            if ($nextIndex === null) {
                if ($changed) {
                    atomicWriteJson($queuePath, $queue);
                }
                return null;
            }

            $queue['jobs'][$nextIndex]['status'] = 'running';
            $queue['jobs'][$nextIndex]['startedAt'] = nowIso();
            atomicWriteJson($queuePath, $queue);
            return $queue['jobs'][$nextIndex];
        });

        if ($job === null) {
            return 0;
        }

        $jobId = (string)($job['id'] ?? '');
        if (!preg_match('/^dep_[A-Za-z0-9_-]+$/', $jobId)) {
            throw new RuntimeException('queued deploy has invalid id');
        }
        $logName = isset($job['logName']) && is_string($job['logName'])
            ? basename($job['logName'])
            : "deploy-{$jobId}.log";
        if (!preg_match('/^deploy-[A-Za-z0-9_-]+\.log$/', $logName)) {
            $logName = "deploy-{$jobId}.log";
        }
        if (!is_dir($logsDir) && !@mkdir($logsDir, 0750, true) && !is_dir($logsDir)) {
            throw new RuntimeException("unable to create {$logsDir}");
        }
        $logPath = $logsDir . '/' . $logName;
        $payloadPath = $bentoDir . "/payload-{$jobId}.json";
        $job['logName'] = $logName;

        $environment = getenv();
        if (!is_array($environment)) {
            $environment = [];
        }
        $environment['BENTO_APP'] = $app;
        $environment['BENTO_DEPLOY_ID'] = $jobId;
        $environment['BENTO_DEPLOY_LOG'] = $logPath;
        $environment['BENTO_DEPLOY_PAYLOAD_FILE'] = $payloadPath;
        $environment['HOME'] = $home;

        try {
            $run = runDeployHook($command, $environment, $workdir, $home, (int)$timeoutSec, $logPath);
            $exitCode = (int)$run['code'];
            if ($exitCode === 0) {
                $job['status'] = 'success';
                unset($job['error']);
            } elseif ($exitCode === 99) {
                $job['status'] = 'skipped';
                unset($job['error']);
            } else {
                $job['status'] = 'failed';
                $job['error'] = is_string($run['error'] ?? null) ? $run['error'] : "exit {$exitCode}";
            }
        } catch (Throwable $e) {
            $exitCode = 1;
            $job['status'] = 'failed';
            $job['error'] = 'execution error';
            appendDeployLog($logPath, 'deploy execution error: ' . $e->getMessage() . "\n");
        }
        $job['exitCode'] = $exitCode;
        $job['finishedAt'] = nowIso();

        $reset = resetOpcache($socketPath, $app, $jobId);
        if ($reset['ok']) {
            appendDeployLog($logPath, 'opcache reset: ' . $reset['detail'] . "\n");
        } else {
            appendDeployLog($logPath, 'opcache reset failed: ' . $reset['detail'] . "\n");
        }

        @unlink($payloadPath);

        withQueueLock($bentoDir, static function () use ($queuePath, $job, $jobId, $logsDir): void {
            $queue = loadQueueFile($queuePath);
            $found = false;
            foreach ($queue['jobs'] as $index => $candidate) {
                if (($candidate['id'] ?? null) === $jobId) {
                    $queue['jobs'][$index] = $job;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                throw new RuntimeException("deploy job {$jobId} disappeared from queue");
            }
            $queue['jobs'] = retainJobs($queue['jobs']);
            pruneDeployLogs($logsDir, $queue['jobs']);
            atomicWriteJson($queuePath, $queue);
        });

        fwrite(STDOUT, "drained {$jobId} -> {$job['status']}\n");
        return 0;
    } finally {
        flock($deployLock, LOCK_UN);
        fclose($deployLock);
    }
}

try {
    exit(drainMain($argv));
} catch (Throwable $e) {
    fwrite(STDERR, 'deploy drain failed: ' . $e->getMessage() . "\n");
    exit(1);
}
