/**
 * Generate complete candidate configuration from desired state.
 */

import type { AppState, CronJob, DesiredState, ProxySite, Worker } from "../domain/state.ts";
import type { Platform } from "../platform/mod.ts";
import { FPM_PROFILES } from "../domain/types.ts";
import { ASSET_VERSION } from "../version.ts";
import { renderTemplate } from "./template.ts";
import { type GeneratedFile, withManagedMarker } from "./render.ts";
import { containerAppHome } from "../platform/paths.ts";
import { assembleComposeDocuments } from "./compose.ts";
import { loadMysqlRootPassword } from "./stack_env.ts";
import { ACME_CHALLENGE_ROOT, resolveSslForSite } from "./tls.ts";

export async function generateAll(
  platform: Platform,
  state: DesiredState,
  assetDigest: string,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];

  // Compose assembly
  const composeFiles = assembleComposeDocuments(platform, state);
  for (const f of composeFiles) files.push(f);

  // Nginx core + sites
  files.push(...await generateNginx(platform, state));

  // PHP pools per app
  files.push(...await generatePhpPools(platform, state));

  // Runner: supercronic + supervisord programs
  files.push(...generateRunnerConfig(state));

  // MySQL root client option files (restricted; password from stack .env)
  const rootPassword = (await loadMysqlRootPassword(platform)) ?? "";
  files.push(...generateMysqlSecrets(state, rootPassword));

  // Generation marker
  files.push({
    relPath: "MANIFEST.txt",
    content: withManagedMarker(
      [
        `assetVersion=${ASSET_VERSION}`,
        `assetDigest=${assetDigest}`,
        `apps=${Object.keys(state.apps).sort().join(",")}`,
        `php=${state.phpVersions.map((v) => v.version).join(",")}`,
        `mysql=${state.mysqlVersions.map((v) => v.version).join(",")}`,
        "",
      ].join("\n"),
    ),
    mode: 0o644,
    managed: true,
  });

  return files;
}

async function generateNginx(
  platform: Platform,
  state: DesiredState,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  let mainTpl: string;
  try {
    mainTpl = await platform.assets.readText("nginx/nginx.conf.tpl");
  } catch {
    mainTpl = DEFAULT_NGINX_MAIN;
  }
  files.push({
    relPath: "nginx/nginx.conf",
    content: withManagedMarker(renderTemplate(mainTpl, {
      workerConnections: 4096,
    })),
    mode: 0o644,
    managed: true,
  });

  // Boot cert placeholder note
  files.push({
    relPath: "nginx/snippets/boot-ssl.conf",
    content: withManagedMarker(DEFAULT_BOOT_SSL),
    mode: 0o644,
    managed: true,
  });
  files.push({
    relPath: "nginx/snippets/app-common.conf",
    content: withManagedMarker(`# shared app defaults
charset utf-8;
index index.php index.html;
`),
    mode: 0o644,
    managed: true,
  });

  for (const app of Object.values(state.apps)) {
    files.push(...await generateAppVhost(platform, state, app));
  }
  for (const proxy of Object.values(state.proxies)) {
    files.push(...await generateProxyVhost(platform, proxy));
  }

  return files;
}

async function generateAppVhost(
  platform: Platform,
  _state: DesiredState,
  app: AppState,
): Promise<GeneratedFile[]> {
  let tpl: string;
  if (app.vhostTemplate.kind === "custom") {
    try {
      tpl = await platform.fs.readText(app.vhostTemplate.sourcePath);
    } catch {
      tpl = await readOrDefault(platform, "nginx/app-vhost.conf.tpl", DEFAULT_APP_VHOST);
    }
  } else {
    tpl = await readOrDefault(platform, "nginx/app-vhost.conf.tpl", DEFAULT_APP_VHOST);
  }

  const serverNames = [app.mainDomain, ...app.aliases].join(" ");
  // App code lives under /home/<slug>/code; documentRoot is relative to that tree.
  const codeRoot = `${containerAppHome(app.slug)}/code`;
  const docRoot = app.documentRoot && app.documentRoot !== "."
    ? `${codeRoot}/${app.documentRoot}`
    : codeRoot;
  const socketPath = `/run/php-fpm/${app.phpService}/${app.slug}.sock`;
  const ssl = resolveSslForSite(app.tls, app.slug, String(app.mainDomain));
  const content = renderTemplate(tpl, {
    slug: app.slug,
    serverNames,
    docRoot,
    socketPath,
    entrypointMode: app.entrypointMode,
    frontController: app.entrypointMode === "front-controller",
    legacy: app.entrypointMode === "legacy",
    accessLog: app.accessLog,
    accessLogPath: `/var/log/nginx/${app.slug}.access.log`,
    tlsKind: app.tls.kind,
    realTls: app.tls.kind !== "boot",
    redirectHttps: ssl.redirectHttps,
    acmeChallenge: ssl.acmeChallenge,
    acmeChallengeRoot: ACME_CHALLENGE_ROOT,
    sslInclude: ssl.includePath,
    deployEnabled: app.deploy.enabled,
    deploySecret: app.deploy.hmacSecret ?? "",
    uid: app.uid,
    gid: app.gid,
    home: containerAppHome(app.slug),
  });

  const files: GeneratedFile[] = [{
    relPath: `nginx/sites/${app.slug}.conf`,
    content: withManagedMarker(content),
    mode: 0o644,
    managed: true,
  }];
  if (ssl.snippetRelPath && ssl.snippetContent) {
    files.push({
      relPath: ssl.snippetRelPath,
      content: withManagedMarker(ssl.snippetContent),
      mode: 0o644,
      managed: true,
    });
  }
  return files;
}

async function generateProxyVhost(
  platform: Platform,
  proxy: ProxySite,
): Promise<GeneratedFile[]> {
  const tpl = await readOrDefault(
    platform,
    "nginx/proxy-vhost.conf.tpl",
    DEFAULT_PROXY_VHOST,
  );
  const serverNames = [proxy.mainDomain, ...proxy.aliases].join(" ");
  const ssl = resolveSslForSite(proxy.tls, `proxy-${proxy.name}`, String(proxy.mainDomain));
  const content = renderTemplate(tpl, {
    name: proxy.name,
    serverNames,
    upstream: proxy.upstream,
    accessLog: proxy.accessLog,
    accessLogPath: `/var/log/nginx/proxy-${proxy.name}.access.log`,
    tlsKind: proxy.tls.kind,
    realTls: proxy.tls.kind !== "boot",
    redirectHttps: ssl.redirectHttps,
    acmeChallenge: ssl.acmeChallenge,
    acmeChallengeRoot: ACME_CHALLENGE_ROOT,
    sslInclude: ssl.includePath,
  });
  const files: GeneratedFile[] = [{
    relPath: `nginx/sites/proxy-${proxy.name}.conf`,
    content: withManagedMarker(content),
    mode: 0o644,
    managed: true,
  }];
  if (ssl.snippetRelPath && ssl.snippetContent) {
    files.push({
      relPath: ssl.snippetRelPath,
      content: withManagedMarker(ssl.snippetContent),
      mode: 0o644,
      managed: true,
    });
  }
  return files;
}

async function generatePhpPools(
  platform: Platform,
  state: DesiredState,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const app of Object.values(state.apps)) {
    let tpl: string;
    if (app.poolTemplate.kind === "custom") {
      try {
        tpl = await platform.fs.readText(app.poolTemplate.sourcePath);
      } catch {
        tpl = await readOrDefault(platform, "php/pool.conf.tpl", DEFAULT_POOL);
      }
    } else {
      tpl = await readOrDefault(platform, "php/pool.conf.tpl", DEFAULT_POOL);
    }
    const profile = FPM_PROFILES[app.fpmProfile] ?? FPM_PROFILES.small!;
    const home = containerAppHome(app.slug);
    const content = renderTemplate(tpl, {
      slug: app.slug,
      uid: app.uid,
      gid: app.gid,
      home,
      maxChildren: profile.maxChildren,
      startServers: profile.startServers,
      minSpare: profile.minSpare,
      maxSpare: profile.maxSpare,
      socketPath: `/run/php-fpm/${app.slug}.sock`,
      openBasedir: `${home}:/usr/share/php:/tmp${app.deploy.enabled ? ":/opt/bento/helpers" : ""}`,
      deployEnabled: app.deploy.enabled,
    });
    files.push({
      relPath: `php/${app.phpService}/pools/${app.slug}.conf`,
      // PHP-FPM pool files are INI-style: only ';' comments are valid.
      content: withManagedMarker(content, "semicolon"),
      mode: 0o644,
      managed: true,
    });
  }
  // Ensure per-version pool directory placeholder + include snippet for the image
  for (const v of state.phpVersions) {
    files.push({
      relPath: `php/${v.service}/pools/.keep`,
      content: withManagedMarker(`; pools for ${v.service}\n`, "semicolon"),
      mode: 0o644,
      managed: true,
    });
    files.push({
      relPath: `php/${v.service}/zz-bento-pools.conf`,
      content: withManagedMarker(
        `; Include bind-mounted per-app pools\ninclude=/usr/local/etc/php-fpm.d/bento/*.conf\n`,
        "semicolon",
      ),
      mode: 0o644,
      managed: true,
    });
  }
  return files;
}

function generateRunnerConfig(state: DesiredState): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const v of state.phpVersions) {
    const appsOnVersion = Object.values(state.apps).filter((a) => a.phpVersion === v.version);
    const jobs = state.cronJobs.filter((j) =>
      appsOnVersion.some((a) => a.slug === j.app) && j.enabled
    );
    const workers = state.workers.filter((w) =>
      appsOnVersion.some((a) => a.slug === w.app) && w.enabled
    );

    // Per-app crontab files
    for (const app of appsOnVersion) {
      const appJobs = jobs.filter((j) => j.app === app.slug);
      // Always include deploy drain when deploy enabled
      const lines: string[] = [];
      if (app.deploy.enabled) {
        // supercronic has no user field — drop privileges via setpriv.
        lines.push(
          `* * * * * setpriv --reuid=${app.uid} --regid=${app.gid} --clear-groups -- /opt/bento/helpers/deploy-drain.sh ${app.slug}`,
        );
      }
      for (const job of appJobs) {
        lines.push(formatCronLine(job, app));
      }
      files.push({
        relPath: `runner/${v.service}/cron/${app.slug}.crontab`,
        content: withManagedMarker(
          lines.length ? lines.join("\n") + "\n" : "# no jobs\n",
        ),
        mode: 0o644,
        managed: true,
      });
    }

    // Supervisord programs (flat). Control socket is required for supervisorctl
    // reread/update and worker start|stop|restart|inspect.
    const programBlocks: string[] = [
      withManagedMarker(`[unix_http_server]
file=/var/run/supervisor.sock
chmod=0700

[supervisord]
nodaemon=true
user=root
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisord.pid

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///var/run/supervisor.sock
`),
    ];
    // system log maintenance scheduler
    programBlocks.push(`[program:system-logrotate]
command=/usr/sbin/logrotate -v /etc/logrotate.conf
autostart=false
autorestart=false
user=root
`);

    for (const app of appsOnVersion) {
      const appJobs = jobs.filter((j) => j.app === app.slug);
      if (appJobs.length > 0 || app.deploy.enabled) {
        programBlocks.push(`[program:scheduler-${app.slug}]
command=/usr/local/bin/supercronic /etc/bento/cron/${app.slug}.crontab
user=root
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/scheduler-${app.slug}.log
stderr_logfile=/var/log/supervisor/scheduler-${app.slug}.err
`);
      }
    }

    for (const w of workers) {
      const app = state.apps[w.app];
      if (!app) continue;
      const cmd = w.command.map(shellQuote).join(" ");
      // Supervisor requires a real /etc/passwd user for `user=`; app UIDs are not
      // system accounts. Drop privileges with setpriv (same approach as cron).
      const dropped = `setpriv --reuid=${app.uid} --regid=${app.gid} --clear-groups -- sh -c ${
        shellQuote(`cd ${w.workdir} && ${cmd}`)
      }`;
      programBlocks.push(`[program:worker-${app.slug}-${w.name}]
command=${dropped}
directory=${w.workdir}
user=root
environment=HOME="${app.home}",USER="${app.slug}",BENTO_APP="${app.slug}"
autostart=true
autorestart=${w.autorestart}
stopsignal=${w.stopsignal}
stopwaitsecs=${w.stopwaitsecs}
stdout_logfile=/var/log/supervisor/worker-${app.slug}-${w.name}.log
stderr_logfile=/var/log/supervisor/worker-${app.slug}-${w.name}.err
`);
    }

    files.push({
      relPath: `runner/${v.service}/supervisord.conf`,
      content: programBlocks.join("\n"),
      mode: 0o644,
      managed: true,
    });
  }
  return files;
}

/**
 * Materialize root MySQL client option files with real password content from stack env.
 * Mode is always 0600; files are disposable generated config (not durable secrets store).
 */
export function generateMysqlSecrets(
  state: DesiredState,
  rootPassword: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const m of state.mysqlVersions) {
    // MySQL accepts # comments; marker keeps file in the managed set.
    files.push({
      relPath: `mysql/${m.service}/root.cnf`,
      content: withManagedMarker(`[client]
user=root
password=${rootPassword.replace(/\n/g, "")}
host=${m.service}
`),
      mode: 0o600,
      managed: true,
    });
  }
  return files;
}

function formatCronLine(job: CronJob, app: AppState): string {
  const cmdParts = job.command.map(shellQuote).join(" ");
  let cmd = `cd ${shellQuote(job.workdir)} && ${cmdParts}`;
  if (job.timeoutSec) {
    cmd = `timeout ${job.timeoutSec}s sh -c ${shellQuote(cmd)}`;
  }
  if (job.lock) {
    cmd = `flock -n /run/bento/${app.slug}/${job.lock}.lock -c ${shellQuote(cmd)}`;
  }
  if (job.output === "null") {
    cmd = `${cmd} >/dev/null 2>&1`;
  } else if (job.output === "log") {
    cmd = `${cmd} >> ${containerAppHome(app.slug)}/logs/cron-${job.name}.log 2>&1`;
  }
  // supercronic is 5-field + command only (no user column). Drop to the app
  // identity with setpriv so open_basedir / home ownership stay consistent.
  const drop = `setpriv --reuid=${app.uid} --regid=${app.gid} --clear-groups -- sh -c ${
    shellQuote(cmd)
  }`;
  return `${job.schedule} ${drop}`;
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function readOrDefault(
  platform: Platform,
  assetPath: string,
  fallback: string,
): Promise<string> {
  try {
    return await platform.assets.readText(assetPath);
  } catch {
    return fallback;
  }
}

const DEFAULT_NGINX_MAIN = `worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
  worker_connections {{workerConnections}};
  multi_accept on;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  keepalive_timeout 65;
  server_tokens off;
  client_max_body_size 64m;

  # zstd with gzip fallback (modules loaded by image)
  gzip on;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

  include /etc/nginx/sites/*.conf;
}
`;

const DEFAULT_BOOT_SSL = `ssl_certificate     /etc/nginx/certs/boot.crt;
ssl_certificate_key /etc/nginx/certs/boot.key;
ssl_protocols       TLSv1.2 TLSv1.3;
`;

const DEFAULT_APP_VHOST = `# app {{slug}}
server {
  listen 80;
  listen [::]:80;
  server_name {{serverNames}};

  {{#acmeChallenge}}
  location ^~ /.well-known/acme-challenge/ {
    root {{acmeChallengeRoot}};
    default_type "text/plain";
    allow all;
  }
  {{/acmeChallenge}}

  {{#redirectHttps}}
  location / {
    return 301 https://$host$request_uri;
  }
  {{/redirectHttps}}
  {{^redirectHttps}}
  root {{docRoot}};
  include /etc/nginx/snippets/app-common.conf;

  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}

  {{#deployEnabled}}
  location = /_bento/deploy {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/deploy-webhook.php;
    fastcgi_param BENTO_DEPLOY_SECRET "{{deploySecret}}";
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  location = /_bento/clean-opcache {
    internal;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/clean-opcache.php;
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  {{/deployEnabled}}

  {{#frontController}}
  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }
  location ~ \\.php$ {
    if ($uri !~ ^/index\\.php$) { return 404; }
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/frontController}}
  {{#legacy}}
  location / {
    try_files $uri $uri/ =404;
  }
  location ~ \\.php$ {
    try_files $uri =404;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/legacy}}
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  listen 443 quic reuseport;
  listen [::]:443 quic reuseport;
  http2 on;
  server_name {{serverNames}};

  include {{sslInclude}};
  add_header Alt-Svc 'h3=":443"; ma=86400' always;

  root {{docRoot}};
  include /etc/nginx/snippets/app-common.conf;

  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}

  {{#deployEnabled}}
  location = /_bento/deploy {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/deploy-webhook.php;
    fastcgi_param BENTO_DEPLOY_SECRET "{{deploySecret}}";
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  location = /_bento/clean-opcache {
    internal;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME /opt/bento/helpers/clean-opcache.php;
    fastcgi_param BENTO_APP "{{slug}}";
    fastcgi_pass unix:{{socketPath}};
  }
  {{/deployEnabled}}

  {{#frontController}}
  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }
  location ~ \\.php$ {
    if ($uri !~ ^/index\\.php$) { return 404; }
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/frontController}}
  {{#legacy}}
  location / {
    try_files $uri $uri/ =404;
  }
  location ~ \\.php$ {
    try_files $uri =404;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/legacy}}
}
`;

const DEFAULT_PROXY_VHOST = `# proxy {{name}}
server {
  listen 80;
  listen [::]:80;
  server_name {{serverNames}};
  {{#acmeChallenge}}
  location ^~ /.well-known/acme-challenge/ {
    root {{acmeChallengeRoot}};
    default_type "text/plain";
    allow all;
  }
  {{/acmeChallenge}}
  {{#redirectHttps}}
  location / {
    return 301 https://$host$request_uri;
  }
  {{/redirectHttps}}
  {{^redirectHttps}}
  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}
  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstream}};
  }
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  server_name {{serverNames}};
  include {{sslInclude}};
  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}
  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstream}};
  }
}
`;

const DEFAULT_POOL = `[{{slug}}]
user = {{uid}}
group = {{gid}}
listen = {{socketPath}}
listen.owner = {{uid}}
listen.group = 1500
listen.mode = 0660
pm = dynamic
pm.max_children = {{maxChildren}}
pm.start_servers = {{startServers}}
pm.min_spare_servers = {{minSpare}}
pm.max_spare_servers = {{maxSpare}}
php_admin_value[open_basedir] = {{openBasedir}}
php_admin_value[upload_tmp_dir] = {{home}}/tmp
php_admin_value[session.save_path] = {{home}}/tmp/sessions
slowlog = {{home}}/logs/php-slow.log
request_slowlog_timeout = 5s
`;

// silence unused import lint for Worker if not used directly
void (null as unknown as Worker);
void (null as unknown as DesiredState);
