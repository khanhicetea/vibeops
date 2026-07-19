/**
 * Generate complete candidate configuration from desired state.
 */

import type { AppState, CronJob, DesiredState, ProxySite, Worker } from "../domain/state.ts";
import type { Platform } from "../platform/mod.ts";
import { FPM_PROFILES, SHARED_SOCKET_GID } from "../domain/types.ts";
import { ASSET_VERSION } from "../version.ts";
import { renderTemplate } from "./template.ts";
import { type GeneratedFile, withManagedMarker } from "./render.ts";
import { containerAppHome } from "../platform/paths.ts";
import { assembleComposeDocuments } from "./compose.ts";
import { loadAcmeEnvironment, loadHttp3Enabled, loadMysqlRootPassword } from "./stack_env.ts";
import { renderAcmeIssuer, renderAcmeSslSnippet, resolveSslForSite } from "./tls.ts";
import { validateUpstreams } from "./proxy.ts";

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

  // Runner: Supercronic and worker service directories supervised by s6
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
  const http3 = await loadHttp3Enabled(platform);
  let mainTpl: string;
  try {
    mainTpl = await platform.assets.readText("nginx/nginx.conf.tpl");
  } catch {
    mainTpl = DEFAULT_NGINX_MAIN;
  }
  // Keep the shared issuer present from the first Nginx start. The ACME module
  // cannot introduce a previously absent issuer with a worker reload alone.
  const acme = await loadAcmeEnvironment(platform);
  const acmeIssuers = renderAcmeIssuer(acme.url, acme.email);
  files.push({
    relPath: "nginx/nginx.conf",
    content: withManagedMarker(renderTemplate(mainTpl, {
      workerConnections: 4096,
      acmeIssuers,
    })),
    mode: 0o644,
    managed: true,
  });

  // Shared TLS snippets. ACME identifiers are inferred independently from each
  // including server block's server_name values.
  files.push({
    relPath: "nginx/snippets/boot-ssl.conf",
    content: withManagedMarker(DEFAULT_BOOT_SSL),
    mode: 0o644,
    managed: true,
  });
  files.push({
    relPath: "nginx/snippets/acme-ssl.conf",
    content: withManagedMarker(renderAcmeSslSnippet()),
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
    files.push(...await generateAppVhost(platform, state, app, http3));
  }
  for (const proxy of Object.values(state.proxies)) {
    files.push(...await generateProxyVhost(platform, proxy, http3));
  }

  return files;
}

async function generateAppVhost(
  platform: Platform,
  _state: DesiredState,
  app: AppState,
  http3: boolean,
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
    sslInclude: ssl.includePath,
    http3,
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
  http3: boolean,
): Promise<GeneratedFile[]> {
  const tpl = await readOrDefault(
    platform,
    "nginx/proxy-vhost.conf.tpl",
    DEFAULT_PROXY_VHOST,
  );
  const serverNames = [proxy.mainDomain, ...proxy.aliases].join(" ");
  const ssl = resolveSslForSite(proxy.tls, `proxy-${proxy.name}`, String(proxy.mainDomain));
  const upstream = validateUpstreams(proxy.upstreams);
  const content = renderTemplate(tpl, {
    name: proxy.name,
    serverNames,
    upstreamName: `upstream_${proxy.name}`,
    upstreamServers: upstream.servers,
    upstreamScheme: upstream.scheme,
    upstreamUri: upstream.uri,
    accessLog: proxy.accessLog,
    accessLogPath: `/var/log/nginx/proxy-${proxy.name}.access.log`,
    tlsKind: proxy.tls.kind,
    realTls: proxy.tls.kind !== "boot",
    redirectHttps: ssl.redirectHttps,
    sslInclude: ssl.includePath,
    http3,
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
    const dynamic = profile.manager === "dynamic";
    const home = containerAppHome(app.slug);
    const content = renderTemplate(tpl, {
      slug: app.slug,
      uid: app.uid,
      gid: app.gid,
      home,
      processManager: profile.manager,
      dynamic,
      ondemand: profile.manager === "ondemand",
      maxChildren: profile.maxChildren,
      startServers: dynamic ? profile.startServers : 0,
      minSpare: dynamic ? profile.minSpare : 0,
      maxSpare: dynamic ? profile.maxSpare : 0,
      processIdleTimeout: dynamic ? "" : profile.processIdleTimeout,
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
        // The per-app Supercronic process already runs as the app UID/GID.
        lines.push(
          `* * * * * /opt/bento/helpers/deploy-drain.sh ${app.slug} /run/php-fpm/${app.phpService}/${app.slug}.sock`,
        );
      }
      for (const job of appJobs) {
        lines.push(formatCronLine(job, app));
        files.push({
          relPath: `runner/${v.service}/cron/jobs/${app.slug}/${job.name}.sh`,
          content: formatCronScript(job),
          // The crontab invokes this through `sh`; it only needs to be readable
          // by the s6-applyuidgid-dropped app identity.
          mode: 0o644,
          managed: true,
        });
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

    // A mutable /run scan tree is reconciled from these read-only service
    // directories. This lets s6-svscan discover additions/removals without
    // recycling the runner container or unrelated services.
    files.push({
      relPath: `runner/${v.service}/services/.keep`,
      content: withManagedMarker("# s6 service definitions\n"),
      mode: 0o644,
      managed: true,
    });

    const logrotateLines: string[] = [];
    for (const app of appsOnVersion) {
      // Keep rotation out of the app's own crontab: that scheduler intentionally
      // runs without root, while PHP-FPM slow logs and captured worker logs can
      // be root-owned. One root maintenance scheduler handles every app on this
      // runner without an endless shell/sleep process.
      const logrotateConfig = `/etc/bento/cron/logrotate/${app.slug}.conf`;
      files.push({
        relPath: `runner/${v.service}/cron/logrotate/${app.slug}.conf`,
        content: withManagedMarker(
          `"${app.home}/logs/cron/*.log" "${app.home}/logs/php/*.log" "${app.home}/logs/worker/*.log" "${app.home}/logs/worker/*.err" {
  size 10M
  rotate 2
  missingok
  notifempty
  nocompress
  copytruncate
}
`,
        ),
        mode: 0o644,
        managed: true,
      });
      logrotateLines.push(
        `0 * * * * /usr/sbin/logrotate --state /run/bento-s6/logrotate-${app.slug}.status ${logrotateConfig}`,
      );

      const appJobs = jobs.filter((j) => j.app === app.slug);
      if (appJobs.length > 0 || app.deploy.enabled) {
        const service = `scheduler-${app.slug}`;
        const supercronic = `/usr/local/bin/supercronic /etc/bento/cron/${app.slug}.crontab`;
        // Open the app-owned log only after dropping privileges. Besides giving
        // the app ownership of a newly created log, this avoids root following
        // an app-controlled symlink during shell redirection.
        const scheduler = `/command/s6-applyuidgid -u ${app.uid} -g ${app.gid} -G '' sh -c ${
          shellQuote(
            `exec ${supercronic} >>${shellQuote(`${app.home}/logs/cron/scheduler.log`)} 2>&1`,
          )
        }`;
        files.push({
          relPath: `runner/${v.service}/services/${service}/run`,
          content: `#!/bin/sh\n# bento-managed: true\nexport HOME=${shellQuote(app.home)} USER=${
            shellQuote(String(app.slug))
          } BENTO_APP=${shellQuote(String(app.slug))}\nexec ${scheduler}\n`,
          mode: 0o755,
          managed: true,
        });
      }
    }

    if (logrotateLines.length > 0) {
      files.push({
        relPath: `runner/${v.service}/cron/logrotate.crontab`,
        content: withManagedMarker(`${logrotateLines.join("\n")}\n`),
        mode: 0o644,
        managed: true,
      });
      files.push({
        relPath: `runner/${v.service}/services/logrotate/run`,
        content:
          "#!/bin/sh\n# bento-managed: true\n# Root maintenance scheduler; app cron services remain unprivileged.\nexec /usr/local/bin/supercronic /etc/bento/cron/logrotate.crontab\n",
        mode: 0o755,
        managed: true,
      });
    }

    for (const w of workers) {
      const app = state.apps[w.app];
      if (!app) continue;
      const service = `worker-${app.slug}-${w.name}`;
      const cmd = w.command.map(shellQuote).join(" ");
      // Open worker logs after dropping privileges so newly created files are
      // app-owned and root never follows an app-controlled symlink.
      const workerLog = `${app.home}/logs/worker/${w.name}.log`;
      const workerErrorLog = `${app.home}/logs/worker/${w.name}.err`;
      const dropped = `/command/s6-applyuidgid -u ${app.uid} -g ${app.gid} -G '' sh -c ${
        shellQuote(
          `cd ${w.workdir} && exec ${cmd} >>${shellQuote(workerLog)} 2>>${
            shellQuote(workerErrorLog)
          }`,
        )
      }`;
      files.push({
        relPath: `runner/${v.service}/services/${service}/run`,
        content: `#!/bin/sh\n# bento-managed: true\nexport HOME=${shellQuote(app.home)} USER=${
          shellQuote(String(app.slug))
        } BENTO_APP=${shellQuote(String(app.slug))}\nexec ${dropped}\n`,
        mode: 0o755,
        managed: true,
      });
      files.push({
        relPath: `runner/${v.service}/services/${service}/down-signal`,
        content: `${s6SignalNumber(w.stopsignal)}\n`,
        mode: 0o644,
        managed: true,
      });
      files.push({
        relPath: `runner/${v.service}/services/${service}/timeout-kill`,
        content: `${w.stopwaitsecs * 1000}\n`,
        mode: 0o644,
        managed: true,
      });
      if (!w.autorestart) {
        files.push({
          relPath: `runner/${v.service}/services/${service}/finish`,
          content:
            "#!/bin/sh\n# bento-managed: true\n# Keep a one-shot worker down after it exits.\nexec /command/s6-svc -d .\n",
          mode: 0o755,
          managed: true,
        });
      }
    }
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
protocol=socket
socket=/var/run/mysqld/mysqld.sock
`),
      mode: 0o600,
      managed: true,
    });
  }
  return files;
}

function formatCronLine(job: CronJob, app: AppState): string {
  // Keep user shell source out of the crontab. Besides making the generated
  // line readable, the child script lets a user's own redirects override the
  // inherited Bento log redirect in the normal shell manner.
  const script = `/etc/bento/cron/jobs/${app.slug}/${job.name}.sh`;
  let cmd = `sh ${shellQuote(script)}`;
  if (job.timeoutSec) {
    cmd = `timeout ${job.timeoutSec}s ${cmd}`;
  }
  if (job.lock) {
    cmd = `flock -n /run/bento/${app.slug}/${job.lock}.lock -c ${shellQuote(cmd)}`;
  }
  if (job.output === "null") {
    cmd = `${cmd} >/dev/null 2>&1`;
  } else if (job.output === "log") {
    cmd = `${cmd} >> ${containerAppHome(app.slug)}/logs/cron/${job.name}.log 2>&1`;
  }
  // Supercronic already executes the crontab command through /bin/sh, and its
  // process already runs as the app UID/GID. No additional shell is needed.
  return `${job.schedule} ${cmd}`;
}

function formatCronScript(job: CronJob): string {
  const command = job.commandMode === "shell"
    ? job.command[0]!
    : `exec ${job.command.map(shellQuote).join(" ")}`;
  return withManagedMarker(
    `cd ${
      shellQuote(job.workdir)
    } || exit 1\nprintf '\\n= Run at %s =\\n\\n' "$(date '+%Y-%m-%d %H:%M:%S')"\n${command}\n`,
  );
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** s6's down-signal file contains a signal number, not a symbolic name. */
function s6SignalNumber(signal: string): number {
  const normalized = signal.trim().toUpperCase().replace(/^SIG/, "");
  const numbers: Record<string, number> = {
    HUP: 1,
    INT: 2,
    QUIT: 3,
    KILL: 9,
    USR1: 10,
    USR2: 12,
    TERM: 15,
  };
  if (numbers[normalized] !== undefined) return numbers[normalized];
  if (/^[1-9][0-9]*$/.test(normalized)) return Number(normalized);
  return 15;
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

const DEFAULT_NGINX_MAIN = `load_module /usr/lib/nginx/modules/ngx_http_acme_module.so;

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
  worker_connections {{workerConnections}};
  multi_accept on;
}

http {
  resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;

  acme_shared_zone zone=ngx_acme_shared:10M;

  {{acmeIssuers}}

  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  keepalive_timeout 65;
  server_tokens off;
  client_max_body_size 64m;

  # Shared cache zones (cache data is kept on disk; keys use bounded shared memory).
  fastcgi_cache_path /var/cache/nginx/app_cache levels=1:2 keys_zone=app_cache:10m max_size=1g inactive=1d use_temp_path=off;
  proxy_cache_path /var/cache/nginx/proxy_assets levels=1:2 keys_zone=proxy_assets:20m max_size=2g inactive=7d use_temp_path=off;
  proxy_cache_path /var/cache/nginx/proxy_cache levels=1:2 keys_zone=proxy_cache:10m max_size=1g inactive=7d use_temp_path=off;

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
    # Cache successful FastCGI responses for one day.
    fastcgi_cache app_cache;
    fastcgi_cache_valid 200 1d;
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
    # Cache successful FastCGI responses for one day.
    fastcgi_cache app_cache;
    fastcgi_cache_valid 200 1d;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/legacy}}
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  {{#http3}}
  listen 443 quic;
  listen [::]:443 quic;
  {{/http3}}
  http2 on;
  server_name {{serverNames}};

  include {{sslInclude}};
  {{#http3}}
  add_header Alt-Svc 'h3=":443"; ma=86400' always;
  {{/http3}}

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
    # Cache successful FastCGI responses for one day.
    fastcgi_cache app_cache;
    fastcgi_cache_valid 200 1d;
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
    # Cache successful FastCGI responses for one day.
    fastcgi_cache app_cache;
    fastcgi_cache_valid 200 1d;
    fastcgi_pass unix:{{socketPath}};
  }
  {{/legacy}}
}
`;

const DEFAULT_PROXY_VHOST = `# proxy {{name}}
upstream {{upstreamName}} {
  {{#upstreamServers}}
  server {{.}};
  {{/upstreamServers}}
  keepalive 5;
}

server {
  listen 80;
  listen [::]:80;
  server_name {{serverNames}};
  {{#redirectHttps}}
  location / {
    return 301 https://$host$request_uri;
  }
  {{/redirectHttps}}
  {{^redirectHttps}}
  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}
  location ~* \\.(?:css|js|mjs|jpg|jpeg|gif|png|svg|ico|webp|avif|woff|woff2|ttf|eot)$ {
    expires 30d;
    proxy_cache proxy_assets;
    proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
  location / {
    proxy_cache proxy_cache;
    proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
  {{/redirectHttps}}
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  {{#http3}}
  listen 443 quic;
  listen [::]:443 quic;
  {{/http3}}
  http2 on;
  server_name {{serverNames}};
  include {{sslInclude}};
  {{#http3}}
  add_header Alt-Svc 'h3=":443"; ma=86400' always;
  {{/http3}}
  {{#accessLog}}
  access_log {{accessLogPath}} bento_timed;
  {{/accessLog}}
  location ~* \\.(?:css|js|mjs|jpg|jpeg|gif|png|svg|ico|webp|avif|woff|woff2|ttf|eot)$ {
    expires 30d;
    proxy_cache proxy_assets;
    proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
  location / {
    proxy_cache proxy_cache;
    proxy_cache_valid 200 7d;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass {{upstreamScheme}}://{{upstreamName}}{{upstreamUri}};
  }
}
`;

const DEFAULT_POOL = `[{{slug}}]
user = {{uid}}
group = {{gid}}
listen = {{socketPath}}
listen.owner = {{uid}}
listen.group = ${SHARED_SOCKET_GID}
listen.mode = 0660
pm = {{processManager}}
pm.max_children = {{maxChildren}}
{{#dynamic}}
pm.start_servers = {{startServers}}
pm.min_spare_servers = {{minSpare}}
pm.max_spare_servers = {{maxSpare}}
{{/dynamic}}
{{#ondemand}}
pm.process_idle_timeout = {{processIdleTimeout}}
{{/ondemand}}
php_admin_value[open_basedir] = {{openBasedir}}
php_admin_value[upload_tmp_dir] = {{home}}/tmp
php_admin_value[session.save_path] = {{home}}/tmp/sessions
slowlog = {{home}}/logs/php/slow.log
request_slowlog_timeout = 15s
`;

// silence unused import lint for Worker if not used directly
void (null as unknown as Worker);
void (null as unknown as DesiredState);
