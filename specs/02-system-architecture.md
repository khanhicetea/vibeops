# Bento system architecture

## 1. Architectural summary

Bento is a host-local desired-state controller around Docker Compose. It does not continuously reconcile like Kubernetes; instead, the operator invokes mutations or apply operations. The CLI owns state transitions, rendering, validation, and targeted reloads. Containers own request serving and background execution.

```text
Operator
   |
   v
Management CLI ---- desired state ----> complete candidate generation
   |                                      |
   |                                      v
   +---- Compose assembly          validate and atomic promote
                                              |
                                              v
Internet ---> host-network Nginx ---> per-app PHP-FPM socket
                    |                         |
                    |                         +---- private backend ---- MySQL version services
                    |                         |                       \-- Redis
                    |                         |
                    |                         +---- shared app home
                    |
                    +-- reverse proxy ---> host/private upstream

Versioned PHP runner ---> per-app scheduler processes + per-app workers
Ephemeral PHP CLI ------> app shells, installs, migrations, operator commands
```

## 2. Control plane and data plane

### 2.1 Host control plane

The control plane is a strict TypeScript CLI on Deno 2.9 plus tracked or embedded templates and topology definitions. It is the only Python replacement in scope; PHP code that must execute inside an app's FPM pool may remain PHP. Its responsibilities are:

- validate operator intent;
- own the desired-state schema and stable app identities;
- derive managed PHP/MySQL service topology;
- render Nginx, PHP-FPM, scheduler, worker, and secret material;
- stage and transactionally promote generated output;
- validate running services before reload;
- apply the narrowest safe reload scope;
- invoke Compose, database administration, permission helpers, backup/restore, and diagnostics;
- protect destructive operations.

It is invoked on demand. There is no resident Bento daemon or remote database.

The source and compiled forms are two distributions of the same application:

```text
TypeScript modules + packages + immutable assets
                 |
          one entrypoint
           /           \
deno run / deno task    deno compile
           \           /
       identical command/domain/platform services
                         |
              local state + Docker/Compose
```

Source mode is the development and repository workflow. Compiled mode is the preferred production release artifact and must not require Deno, Node.js, Python, npm, or `node_modules` on the target host. Docker Engine, Docker Compose, and normal system utilities remain platform prerequisites.

### 2.2 Containerized data plane

The data plane consists of:

| Component | Cardinality | Responsibility |
|---|---:|---|
| Nginx | One | Public HTTP/HTTPS/HTTP3 ingress, TLS, PHP routing, reverse proxying, compression, request/access logs |
| PHP-FPM | One per PHP version | Serves requests through one pool/socket per app |
| PHP runner | One per PHP version | Supervises per-app schedulers and long-running workers |
| PHP CLI | Ephemeral per invocation | Runs app commands and shells with the correct identity/runtime |
| MySQL | One per managed MySQL version | Durable relational data for apps assigned to that service |
| Redis | One | Durable shared cache/queue service, optionally ACL-isolated per app |

Nginx is the only public service. PHP, runners, MySQL, and Redis use a private Compose network. Nginx deliberately does not join that network; PHP communication crosses shared Unix-socket mounts.

### 2.3 Target codebase layering

The TypeScript implementation must preserve one-way dependencies even though exact directories are flexible:

| Layer | Target responsibility |
|---|---|
| Entrypoint and command adapters | Parse scripted/interactive intent, select records, coordinate use cases, map typed errors to exit codes, and format operator output |
| Domain/application services | State transitions, rendering plans, Compose assembly, Nginx/PHP/MySQL/Redis behavior, runtime versions, runners, deployment, and access logs |
| Schemas and migrations | Runtime validation, schema-version dispatch, defaults, upgrades, and conversion from `unknown` into domain values |
| Platform adapters | Atomic filesystem primitives, locks, clocks, randomness, subprocess/Docker execution, terminal access, and host inspection |
| Shared UI/policy | Paths, environment/default policy, templating, prompts, tables, and stable operator diagnostics |
| Immutable runtime assets | Base Compose topology, Nginx/PHP/MySQL templates, Docker build contexts, and in-container helper programs |
| Behavioral tests | Validate domain invariants, secret handling, scoped reloads, render rollback, version resolution, and operational safety |

The intended dependency direction is command adapters -> application/domain services -> narrow platform interfaces, with concrete platform adapters injected at the outside. Domain code must not import command parsers, prompts, `Deno.*`, or terminal formatting. This keeps headless behavior testable and prevents CLI presentation or Deno APIs from becoming the domain model.

### 2.4 Type and validation boundaries

TypeScript compile-time types do not make JSON, environment values, CLI tokens, or subprocess output safe. Every such input starts as `unknown` and passes through a runtime schema before it reaches domain services. The schema library may come from JSR or npm, but the inferred TypeScript type and runtime validator must describe the same model.

Use opaque/branded value types for frequently confused primitives such as `AppSlug`, `DomainName`, `Uid`, `Gid`, `PhpVersion`, `MysqlService`, `AbsoluteAppPath`, and `UnixSocketPath`. Use discriminated unions for TLS modes, reload targets, queue policies, deploy states, command results, and recovery outcomes. Exhaustive switches must fail type checking when a new variant is not handled.

Persisted state has an explicit schema version. Loading follows `bytes -> JSON unknown -> version discriminator -> schema validation -> typed migration -> current State`. Invalid or future state is reported without writing defaults over the source. Saving follows a validated domain state and an atomic writer; callers cannot write arbitrary records.

Package APIs that return weakly typed data are isolated behind adapters. Production source must not spread `any` through the domain layer, use unchecked type assertions to accept external data, or index arbitrary state objects without validation.

## 3. Application isolation model

An app is a logical tenant inside version-shared infrastructure.

| Boundary | Isolation mechanism |
|---|---|
| Process identity | Stable private Linux UID/GID used by FPM, CLI, cron, workers, and deploys |
| Web execution | Dedicated PHP-FPM pool and Unix socket |
| Filesystem | Private home; Nginx receives read-only home mount and group access only to the public tree |
| PHP filesystem access | Per-pool `open_basedir` rooted in the app home, plus required runtime libraries/log paths |
| MySQL | Same-name user with grants restricted to the app database namespace on one service |
| Redis | Mandatory app key prefix in shared mode; per-app user/key/channel ACL in ACL mode |
| Background work | Supervisor and scheduler switch to the app user and constrain working directory to the app home |
| Deployment | Authenticated per-app queue; deploy command runs as the app user with one active job |

This is not a hostile multi-tenant sandbox. Apps on the same PHP version share an image, container namespace, network access, CPU/memory envelope, FPM global process cap, and runner container. The design protects ordinary application ownership and operational mistakes; it is not equivalent to one container or VM per untrusted tenant.

Use a separate app for each codebase or trust boundary. Use a separate host or stronger isolation architecture for mutually hostile tenants.

## 4. Networking topology

### 4.1 Ingress

Nginx uses the host network and binds ports 80 and 443 directly. This design provides straightforward HTTP/3/UDP handling and lets reverse proxies reach host-loopback upstreams. It also means:

- the production target is Linux;
- another host web server must not own those ports;
- a proxy target on `127.0.0.1` means the host, not a Compose container;
- replacing host networking is an ingress redesign, not a local configuration tweak.

### 4.2 PHP request path

For an app assigned to a PHP version, the same socket directory is represented differently in each namespace:

```text
Host:      runtime socket root / <php-service> / <app>.sock
Nginx:     /run/php-fpm / <php-service> / <app>.sock
PHP-FPM:   /run/php-fpm / <app>.sock
```

The shared socket group lets Nginx connect without joining every app's private group. Socket path and group alignment are architecture invariants.

### 4.3 Backend services

PHP-FPM, runner, CLI, MySQL, and Redis communicate through a private Compose network. Apps use the selected MySQL service name and the Redis service name, never `localhost`. MySQL and Redis have no public port publication in the base topology.

## 5. State and storage layers

Bento separates five ownership layers:

| Layer | Meaning | Lifecycle |
|---|---|---|
| Upstream source | CLI, base topology, images, templates, defaults | Version-controlled and upgraded |
| Local desired state | Stack defaults/secrets and the state document | Operator-owned source of truth |
| Generated state | Compose runtime fragments, vhosts, pools, scheduler/worker config, root client files | Disposable and fully reconstructible |
| Local customization | Compose overlays and selected app templates | Operator-owned, upgrade-aware |
| Durable runtime | App homes, logs, backups, certificates, ACME state, MySQL/Redis volumes | Preserved across render and container recreation |

Generated state must carry a managed marker and must never be the place for user edits. A full generation also determines which old managed files are stale.

Sensitive root-client files are generated with restricted modes. App credentials live inside the relevant app home with app-only permissions. The desired state may contain deployment secrets and must itself be treated as sensitive local state.

## 6. Conceptual domain model

The persisted schema may be implemented differently, but it must represent these relationships:

```text
Stack
  defaults -> PHP version, MySQL service, FPM profile
  managed PHP versions[]
  managed MySQL versions[]
  apps{}
  proxy sites{}
  global domain ownership{}
  cron jobs{}
  workers{}

App
  identity -> slug, UID/GID, home
  runtime  -> PHP version, PHP service, FPM profile, entrypoint mode
  ingress  -> main domain, aliases, TLS mode, access-log flag
  data     -> one MySQL service, MySQL user, databases[], Redis identity/prefix
  deploy   -> enabled, HMAC secret, queue policy, timeout, workdir, trusted argv
  config   -> selected app vhost/pool template provenance

Domain owner -> exactly one PHP app or one proxy site
Cron job     -> exactly one app and its PHP version
Worker       -> exactly one app and its PHP version
Database     -> exactly one app and its selected MySQL service
Deploy job  -> exactly one app and one of queued|running|success|failed|skipped
```

The app slug is stack-wide unique and reused as the Linux identity, FPM pool, socket name, database user, home directory, cron identity, worker namespace, and deploy queue owner. Changing it is therefore an identity migration, not a rename.

## 7. Core control flows

### 7.1 App provisioning

1. Validate app name, domains, document root, runtime, database choice, and capacity profile.
2. Refuse domain collisions and unmanaged runtime versions.
3. Allocate or reuse a stable UID/GID.
4. Create the app home and private/public directory structure.
5. Create/update MySQL and Redis identities when their services are available.
6. Record desired state.
7. Generate the app identity, FPM pool, vhost, and related runtime configuration.
8. Validate/reload PHP-FPM and Nginx as required.
9. Apply the initial recursive permission policy once, while the tree is small.

An explicit database request must fail before recording a database if MySQL is unavailable. Best-effort account setup without an explicit database may be completed later.

### 7.2 Request serving

1. Nginx selects a globally unique app or proxy domain.
2. Static files are read from the app's selected public tree through a read-only mount.
3. PHP requests are routed to the app's socket under its selected PHP version.
4. The app pool executes as the app user with its pool limits and filesystem boundary.
5. PHP reaches its assigned MySQL service and Redis through the private network.

### 7.3 Render and apply transaction

```text
Acquire exclusive render lock
        |
Recover any abandoned transaction
        |
Render complete candidate into same-filesystem staging
        |
Build deterministic managed-file manifest
        |
Snapshot existing files and atomically promote candidates
        |
Remove stale managed files last
        |
Validate all targeted running services
   | failure                         | success
   v                                 v
Restore prior generation       Signal only targeted roles
                                      |
                                  Finalize journal
```

The transaction covers generated service files and sensitive generated MySQL option files. Managed PHP/MySQL Compose fragments are also derived from state, though their exact transactional mechanism may differ in a replacement as long as the observable safety guarantees remain.

### 7.4 Scoped reconciliation

| Change type | Validate/reload target |
|---|---|
| Domain, proxy, TLS, access-log toggle, vhost customization | Nginx only |
| App identity, PHP version/profile, pool customization | PHP-FPM and, when applicable, Nginx |
| Cron, deploy drain, worker definition | Matching PHP runner only |
| Database creation, password rotation, backup/restore | No web/runtime reload |
| Full apply | Nginx, all relevant PHP-FPM services, all relevant runners |

Stopped services are not treated as fatal solely because they cannot be signaled; generated config must be ready for their next startup. Running services must be validated before reload.

### 7.5 Schedules and workers

Each PHP runner uses Supervisord as PID 1. It owns:

- one root-owned system scheduler for runtime log maintenance;
- one Supercronic child per app that has schedules;
- one flat Supervisor program per enabled worker.

Flat programs prevent a change to one worker from restarting a process group. Scheduler files are validated before an existing scheduler receives a reload signal. Cron locks live in volatile per-app runtime directories and cover the whole command duration.

### 7.6 Webhook deployment

```text
Signed HTTPS POST /_bento/deploy (body <= 256 KiB)
      |
Nginx app vhost /_bento
      |
Stack-owned read-only PHP front controller in the app FPM pool
      | verify X-Hub-Signature-256 HMAC over raw bytes
      v
App-owned, flock-protected queue ----> immediate 202 response
      |
Managed minute scheduler (lock=deploy, default timeout=900s)
      |
Single-flight drain as app user
      | timeout + app workdir + trusted argv
      v
Per-job /home/<app>/logs output + terminal status
      |
Direct FastCGI request over the app socket ----> app-pool OPcache reset
```

The `/_bento` location is a dedicated internal routing namespace that does not fall through either PHP entrypoint mode. The front controller is mounted read-only outside `/home/<app>` so compromised app code cannot replace the webhook verifier, and deploy-enabled FPM pools explicitly include that helper path in `open_basedir`. The secret is stored in sensitive desired state and supplied by generated FastCGI parameters rather than an app-writable secret file. The route accepts `X-Hub-Signature-256: sha256=<hex>` and may accept `X-Hub-Signature` with `sha256` or legacy `sha1`; comparison is constant-time. Empty signed bodies are valid. Disabled deployment means the route is absent or returns 404. Invalid auth returns 401, an oversized body returns 413, and a full FIFO queue returns 429. A valid enqueue returns `202 {"id":"...","status":"queued"}` without running deployment work.

Runtime layout is:

```text
/home/<app>/.bento/
  queue.json                 # schema v1; app-owned, mode-restricted
  deploy.json                # timeout/workdir/argv; contains no webhook secret
  deploy.sh                  # app/operator-owned hook
  payload-<job-id>.json      # optional mode-0600 snapshot, deleted after the run
/home/<app>/logs/
  deploy-<job-id>.log
```

Every queue reader/writer uses `flock`. A job records its id, status, received/started/finished timestamps, exit code, error, log name, delivery id, content metadata, payload hash, and a bounded payload representation; authorization headers are never stored. The default `latest` policy marks older queued work `failed` with error `superseded` while allowing the current job to finish. FIFO processes oldest-first and refuses more than 20 queued jobs. Retention keeps active jobs plus the newest terminal records/logs within a 30-job policy.

The drain is the only transition authority for `queued -> running -> success|failed|skipped`. It reclaims stale `running` work as `failed/interrupted` after timeout plus a small grace interval and never runs more than one job for an app. The default command is `sh /home/<app>/.bento/deploy.sh`; exit `0` is success, exit `99` is skipped, and every other exit is failed. Missing workdir/script is an explicit failure. The command receives `BENTO_APP`, `BENTO_DEPLOY_ID`, `BENTO_DEPLOY_LOG`, and `BENTO_DEPLOY_PAYLOAD_FILE` and runs under the app UID/GID.

After any finished command, the runner sends `POST /_bento/clean-opcache` directly to the app's FPM Unix socket using the recent deploy id. This guarantees the reset executes in the correct pool rather than making a public loopback HTTP request. Reset failure is appended to the job log and does not replace the command outcome.

### 7.7 Database backup and restore

Backup runs the matching version's client tools inside the MySQL container. Output is streamed to a private partial host file. Optional compression also runs inside the container so only compressed bytes cross the Docker exec boundary. Successful, non-empty output is atomically renamed to its final unique filename. Retention runs per database only after the full requested batch succeeds.

Restore streams plain or compressed input into a freshly created destination database. Replacing an original requires exact-name confirmation and performs drop/create before import. Therefore restore is not object-level atomic, and failed import can leave a partially restored destination.

## 8. Security model

### 8.1 Public surface

Only Nginx is public. The stack may expose app sites, proxy sites, ACME HTTP challenges, and an opt-in authenticated app-internal endpoint. Management, FPM, MySQL, Redis, Supervisor, and status endpoints remain local/private.

### 8.2 Secrets

- Stack secrets and desired state are local and untracked.
- MySQL root credentials are mounted as protected client option files, not supplied on administrative argv.
- App MySQL/Redis credentials are mode-restricted inside the app home.
- Temporary app-authenticated database shells stage a protected in-container option file through stdin and remove it afterward.
- Webhook signatures use constant-time HMAC comparison.
- Certificate keys, ACME accounts, backups, app homes, and runtime state are never committed.

### 8.3 Filesystem

- Nginx sees application homes read-only.
- PHP/runner/CLI see them read-write but execute under the app identity.
- Private app directories are app-only.
- Public directories are app-owned and group-readable/traversable by the shared Nginx/socket group.
- Permission repair does not follow symlink targets and requires explicit recursion for a full tree.

### 8.4 Safety controls

- Global domain uniqueness prevents ambiguous routing.
- Working directories cannot escape an app home.
- Worker commands are stored as argv; shell evaluation requires an explicit shell.
- Cron values and schedules reject unsafe structure before runtime validation.
- MySQL grants escape wildcard characters in app names.
- The supported Compose wrapper refuses volume-destructive down operations.

## 9. Failure and recovery semantics

| Failure | Required outcome |
|---|---|
| Candidate render fails | Live generation remains unchanged |
| Promotion fails midway | Previous files/modes are restored from the transaction journal |
| Service validation fails | Previous generation is restored; no reload occurs |
| Reload signal fails after validation | Valid new files stay live; operator can retry the signal |
| CLI/process interrupted during promotion | Next render detects and deterministically recovers the abandoned transaction |
| Database dump fails or is empty | No final backup is published; partial is removed |
| Multi-database backup fails midway | Earlier completed dumps remain; retention is skipped |
| Restore fails during import | Destination may be partial; product reports the non-atomic failure |
| Deploy process dies/stales | Next drain marks it interrupted after timeout/grace and continues |
| Runner or web service is stopped | State/render succeeds where safe; config loads on next start |

## 10. Technology stack

The replacement must use these target choices unless the product owner explicitly authorizes an architectural change.

| Area | Target choice | Reason in the product |
|---|---|---|
| Host | Linux, Docker Engine, Docker Compose v2 | Single-server packaging, bind mounts, host networking, durable named volumes |
| Control plane | Deno 2.9.x with strict TypeScript | Type-safe domain code, direct source execution, built-in tooling, and standalone compilation |
| Distribution | Direct `deno run`/`deno task` plus `deno compile` Linux amd64/arm64 binaries | Fast development and a runtime-free production executable from one entrypoint |
| Dependency sources | JSR preferred; npm allowed through Deno compatibility; committed lockfile | Reuse maintained packages without sacrificing reproducibility or compiled delivery |
| Desired state | Local versioned JSON document | Human-inspectable, no resident database or daemon |
| Ingress | Nginx on host network | Direct 80/443 TCP+UDP, TLS/ACME, HTTP/2+3, host upstreams |
| Compression | Pinned Nginx Zstandard modules plus gzip | Modern compression with compatibility fallback and reproducible module build |
| PHP | Official Debian-based versioned PHP-FPM images | Multiple concurrent runtimes with consistent FPM/CLI/runner toolchain |
| PHP capabilities | Common web extensions, OPcache, Redis extension, Composer, Node.js, Git, SSH client | Supports typical modern and legacy PHP deployment workflows |
| Process supervision | Supervisord | Persistent per-version runner with individually controllable programs |
| Scheduling | Supercronic | Container-friendly cron parsing, validation, reload, and logs |
| Relational data | Versioned MySQL services with named volumes | App assignment to one durable engine version; matching client tools |
| Cache/queue | Redis with AOF persistence and optional ACL mode | Shared internal service with compatibility and stronger isolation modes |
| Backups | `mysqldump`, optional Zstandard/gzip streaming | Portable logical recovery without host compression dependencies |
| Log lifecycle | Docker local logging plus logrotate | Bounded service logs and app file logs without control-plane daemon |
| Analysis | One-shot GoAccess container | No permanent analytics service |
| Tests/tooling | `deno fmt`, `deno lint`, `deno check`, `deno test`, contract/integration shell checks | One pinned toolchain for format, lint, types, tests, and builds |

Current defaults are PHP 8.5 and MySQL 8.4. Those defaults are product policy, not eternal architecture; version management must remain data-driven. Legacy MySQL 5.7 has special ARM64 compatibility handling but is end-of-life and should be treated as a compatibility requirement only if the reimplementation must support existing hosts.

### 10.1 Deno project and dependency policy

`deno.json` is the authoritative project configuration and declares tasks, imports, strict compiler options, lint/format/test scopes, permission sets, and compile settings. `deno.lock` is committed; CI and release builds must fail rather than silently re-resolve it. An exact Deno 2.9.x patch is pinned for local tooling and CI.

This is not a standard-library-only project. Prefer a maintained package over custom parsing or protocol code when it lowers risk, especially for CLI parsing/help, runtime schemas, semver, templating, and test fixtures. Prefer JSR packages; use npm packages when the ecosystem implementation is materially better. An npm package must work in Deno without an unmanaged lifecycle script, native addon, implicit global install, or filesystem assumptions that break `deno compile`. Direct URL imports without a central import mapping are not allowed.

Each dependency needs a clear adapter boundary and justification. Avoid overlapping packages for the same concern. Release review includes license, provenance/maintenance, transitive dependency, vulnerability, and compiled-size impact. Deno 2.9's npm minimum-release-age protection should remain enabled unless a documented exception is required.

### 10.2 Runtime permissions

The control plane needs broad operational authority but its Deno permissions must still be explicit and centrally maintained. Source tasks and compile configuration grant only the paths, environment access, subprocess commands, and network endpoints required by Bento. They must not document `-A` as the normal path. If an operation needs an extra capability, it fails before changing state and tells the operator which capability is missing.

The release build bakes the same capability manifest into the executable. No FFI permission is granted unless a chosen package makes it unavoidable and the architecture/security review accepts it. Packages never receive network or subprocess access merely for convenience.

### 10.3 Direct and compiled asset resolution

One asset-resolver interface serves both modes:

- source mode reads immutable upstream assets from the repository;
- compiled mode reads assets embedded with `deno compile --include`;
- operator state, secrets, overrides, customization, homes, backups, and generated output always resolve from the selected external stack root;
- Compose files, Docker build contexts, or scripts that external tools require as real paths are materialized atomically into a versioned digest-addressed cache before those tools run;
- generated files record the asset/release version that produced them.

The compiled executable must work from any current directory when passed an explicit stack root. It must not infer writable state relative to the executable or embedded virtual filesystem. Asset digests and parity tests ensure direct and compiled modes render byte-equivalent output for the same inputs.

### 10.4 Development and release tasks

The repository exposes stable tasks equivalent to `fmt`, `lint`, `check`, `test`, `test:integration`, `run`, and `compile`. The release pipeline runs formatting check, lint, type check, unit/contract tests, integration tests, compilation for Linux x86_64 and aarch64, and a compiled-binary smoke suite. Release binaries report both the Bento version and the pinned Deno version used to build them.

## 11. Extension boundaries

Safe extension occurs through desired-state features, local Compose overlays, user-owned custom files, and selected app templates. A replacement may use a different internal template engine or module layout, but it must preserve:

- separation of upstream and local ownership;
- deterministic overlay order;
- visibility into the merged Compose model;
- validation after customization;
- provenance/update awareness for copied app templates;
- a documented contract for required mounts, socket paths, identities, and TLS markers. App templates are trusted operator input, so they can intentionally change behavior after accepting that responsibility.

## 12. Architecture invariants

1. Bento targets one operator-owned Linux host.
2. Nginx is the only public service and uses host networking.
3. App-to-PHP routing uses per-app Unix sockets.
4. Apps share containers by PHP version and isolate through identity/pool/filesystem/data credentials.
5. Each PHP version has FPM, singleton runner, and ephemeral CLI roles.
6. Each app has one primary PHP version and one MySQL service.
7. MySQL and Redis remain private in the base topology.
8. Desired state is authoritative; generated output is disposable.
9. Durable data is separate from generated state.
10. Render/apply is serialized, staged, validated, recoverable, and reload-scoped.
11. All app execution paths use the same app identity.
12. Runner replicas remain one per PHP version.
