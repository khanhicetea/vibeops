# Bento product specification

Status: reimplementation baseline

Audience: product owner, systems engineer, implementation lead, reviewer

## 1. Product definition

Bento is a single-server application operations product for people who want to host several PHP applications without adopting a full cloud platform or Kubernetes. It packages the repeatable work around Nginx, PHP-FPM, MySQL, Redis, TLS, scheduled tasks, queue workers, deployments, permissions, backups, logs, and service reloads into one locally operated stack.

The application is Bento's primary unit of ownership. One application identity binds together:

- a code and data home;
- a private Linux user/group;
- one PHP version and one PHP-FPM pool;
- one or more domains;
- one MySQL user on exactly one MySQL service;
- Redis connection metadata and optional per-app ACL identity;
- scheduled jobs, long-running workers, and deployment jobs;
- logs, credentials, and permission policy.

The product is intentionally local and transparent. The operator owns the server, state, application files, database volumes, certificates, and backups.

## 2. Problem and value proposition

Running a few PHP applications on one server is operationally simple in theory but fragile in practice. It requires coordinating web routing, TLS, runtime versions, user identities, filesystem access, database grants, cache credentials, background processes, deployment commands, backups, and config reloads. Hand-maintained configuration drifts, secrets leak into shell commands, and broad restarts create avoidable outages.

Bento's value is to turn those coupled tasks into a coherent desired-state workflow with safe defaults and explicit escape hatches. It should feel closer to administering a small platform than hand-editing a collection of containers, while retaining the cost and comprehensibility of one server.

## 3. Target user

The primary user is a technically capable developer or small-team operator who:

- owns a Linux VPS or dedicated server;
- hosts multiple PHP applications, often Laravel, Symfony, WordPress, or legacy PHP;
- accepts a command-line workflow;
- wants application-level separation without one VM or container stack per site;
- needs reproducible operations but does not need multi-node orchestration.

Secondary uses include placing Nginx and TLS in front of non-PHP services already reachable from the host, and using the stack as a development approximation of the production host.

## 4. Product goals

1. Provision and operate multiple PHP applications on one Linux host with clear app ownership boundaries.
2. Make the desired configuration reproducible from a small state model.
3. Minimize disruption by validating changes and reloading only affected services.
4. Keep database, cache, credentials, and internal services private by default.
5. Support multiple PHP and MySQL versions without duplicating the whole stack.
6. Cover the complete operational lifecycle around requests, CLI tasks, schedules, workers, deployments, logs, backups, and maintenance.
7. Preserve local control and support deliberate customization without requiring a fork.

## 5. Product principles

- **Single-host first.** Optimize for one production Linux server, not a cluster.
- **Desired state over edited output.** Generated configuration is disposable and must be reconstructible.
- **App identity everywhere.** Web requests, CLI commands, schedules, workers, deployments, and data access must resolve to the same app identity.
- **Private by default.** Only the web ingress is public; PHP, MySQL, and Redis are internal.
- **Safe change application.** Generate completely, validate before reload, and preserve the previous usable generation when validation fails.
- **Narrow blast radius.** A domain change should not restart workers; a cron change should not reload Nginx.
- **Durability is explicit.** Application homes, database volumes, backups, certificates, and ACME state survive service recreation.
- **Escape hatches are owned.** Local overrides and app-specific templates are user-owned inputs, never edits to disposable output.

## 6. Required capabilities

### 6.1 Host bootstrap and operator interface

Bento must provide one Deno 2.9/TypeScript management interface for both interactive and scripted operation. It must:

- initialize an empty desired state with sensible default PHP and MySQL versions;
- render the stack before first startup;
- assemble the base Compose topology, managed runtime fragments, and local overlays consistently;
- expose guided interactive workflows as a convenience while keeping all important operations scriptable;
- report stack, service, app, runtime, TLS, and capacity status;
- refuse known destructive shortcuts, especially accidental deletion of durable database volumes.

The same TypeScript entrypoint must run directly under Deno and compile into a standalone Linux executable. Both forms must be usable on a clean host without installing Python, Node.js, a package tree, or a web control plane. The compiled form still uses an external Bento stack root for mutable/operator state and may materialize embedded Compose/Docker assets there, but it must not require a language runtime, package installation, or separate checkout of immutable control-plane assets.

### 6.2 Application provisioning and lifecycle

The operator must be able to create or update an application with a unique slug and main domain. Provisioning must establish:

- a stable numeric Linux identity;
- a private app home containing code, logs, credentials, SSH state, dependency-manager state, and Bento runtime state;
- an app-specific PHP-FPM pool and Unix socket;
- a selected PHP version and named FPM capacity profile;
- optional MySQL account and initial database;
- Redis credentials/metadata;
- an HTTP and HTTPS virtual host;
- initial filesystem ownership and modes.

Each app supports one main domain plus aliases. Domains must be globally unique across PHP apps and proxy sites. Changing the main domain must not change the app identity or code tree.

The app document root can be the code root or a safe subdirectory such as `public`. Two PHP routing modes are required:

- **Front-controller mode:** only the application entrypoint is executable as PHP; other PHP paths are rejected.
- **Legacy mode:** existing PHP scripts beneath the document root may execute directly.

Re-running provisioning is the intentional path for changing an app's primary PHP version or FPM profile. Omitted choices must preserve the existing app's recorded runtime rather than silently adopting new defaults.

First-class app deletion is outside the current product contract. A replacement must not silently invent destructive teardown behavior.

### 6.3 Ingress, domains, TLS, and reverse proxies

Bento must provide a single public Nginx ingress that:

- binds host HTTP and HTTPS directly, including UDP support for HTTP/3;
- serves all app domains and proxy domains;
- reaches PHP-FPM through per-app Unix sockets;
- starts safely before production certificates exist by using a shared self-signed certificate;
- manages an optional stack-private CA and per-site SAN certificates, with public CA export for other trust stores;
- supports state-selected ACME certificates and externally managed certificate files;
- can redirect HTTP to HTTPS once a real certificate mode is enabled;
- enables HTTP/2 and HTTP/3 on generated HTTPS sites;
- provides Zstandard compression with gzip compatibility fallback;
- applies baseline security, connection, and request limits.

The operator must also be able to create a reverse-proxy site for a host-reachable upstream. Proxy sites participate in the same global domain and TLS model as PHP apps.

Because ingress uses the host network, a loopback proxy target means the host namespace. Compose service-name discovery is not available to Nginx unless the service is separately made reachable.

### 6.4 Versioned PHP runtime and capacity

Bento must manage more than one PHP version concurrently. Each managed PHP version produces three roles:

1. a persistent PHP-FPM request service;
2. a persistent runner for schedules and workers;
3. an ephemeral CLI role for shells, dependency installation, migrations, and other app commands.

All three roles for a version must use the same runtime image, application mount, identities, extensions, and language/toolchain. An app has exactly one primary PHP version at a time.

Apps select from named FPM sizing profiles rather than arbitrary process-manager fragments. The product must warn when the sum of per-app pool maxima can exceed the global process cap for a PHP version.

An unused non-default PHP version may be removed. Removal must be refused while any app still uses it or when it would remove the final managed version.

### 6.5 MySQL and Redis

Bento must manage one durable MySQL service and named volume per selected MySQL version. An app is assigned to exactly one MySQL service and receives:

- a same-name database user;
- grants limited to databases in that app's namespace;
- mode-restricted credential material;
- one or more recorded databases on that service.

The product must not create the same app identity across multiple MySQL services. Moving an app to another MySQL version is an explicit migration outside ordinary provisioning.

The MySQL root password is generated once when the stack environment is initialized. An app user's password is generated once during initial app provisioning. Reconciliation and later database grants must not alter an existing account's password. Bento does not provide password rotation; the operator is responsible for manually updating MySQL, Bento's state and credential material, and dependent applications.

Required MySQL operations are:

- add and list managed versions;
- create and list app databases;
- open root or app-authenticated database shells without exposing passwords in host arguments;
- show database sizes and active processes;
- create logical backups for one database, one app, or all user databases;
- optionally compress backup streams inside the matching database container;
- retain a configurable number of successful backups per database;
- restore to a new database name or replace the original only after exact confirmation.

Backups must be finalized atomically and must never publish an empty or failed partial dump. Restore is streamed but is not transactionally atomic at the database-object level; the product must communicate that limitation. Off-host backup transfer is the operator's responsibility.

Automated MySQL version removal is intentionally unsupported because it would couple service removal with durable-volume destruction.

Bento provides one durable Redis service. Shared-password mode is the compatibility default and requires applications to use an app-specific key prefix. Optional ACL mode creates a unique identity that can access only the app's key and channel namespace. Redis is not exposed publicly.

### 6.6 Manual command execution and deployment

The operator must be able to open a shell or run an arbitrary argv command in an ephemeral container using the app's recorded PHP version, Linux identity, home, and working directory. Working directories must remain inside the app home.

Webhook deployment is optional per app. When enabled, Bento must:

- expose the stack-owned `POST /_bento/deploy` HTTPS endpoint under the app's main domain;
- reject request bodies larger than 256 KiB and authenticate the exact raw body with a constant-time GitHub-compatible HMAC signature;
- accept `X-Hub-Signature-256: sha256=<hex>` and `X-Hub-Signature: sha256=<hex>`, with legacy `sha1` on `X-Hub-Signature` optional for compatibility;
- enqueue quickly instead of deploying in the HTTP request;
- run a trusted, state-selected deploy command as the app user;
- allow `latest` coalescing or bounded FIFO queue behavior;
- guarantee one active deploy per app;
- enforce a timeout and recover interrupted jobs;
- record queued, running, successful, failed, skipped, and superseded outcomes;
- retain at most 30 active/recent jobs, keep FIFO queued depth at or below 20, and write per-job output under `/home/<app>/logs/`;
- make a bounded payload snapshot available to the deploy command;
- reset OPcache for the app's FPM pool after a finished deployment;
- support enable, reconfigure, disable, webhook-instruction, secret-rotation, status, and history workflows.

The webhook HMAC secret is sensitive desired state. Generated Nginx/FastCGI configuration supplies it to the read-only internal controller; it must not be copied to an app-writable secret file. The queue, deploy configuration, optional payload snapshot, and hook live outside the public document root under `/home/<app>/.bento/` and are app-owned. Every reader and writer of `queue.json` must use an exclusive/shared file lock appropriate to the operation.

The managed drain runs once per minute through the app's singleton PHP runner, uses the `deploy` lock, defaults to a 900-second timeout, and executes one oldest queued job at a time. The trusted default argv is `sh /home/<app>/.bento/deploy.sh`. The generated example hook deliberately performs no deployment and exits `99`, meaning `skipped`, until the operator replaces it. Exit `0` means `success`; other exits mean `failed`.

The deploy process receives `BENTO_APP`, `BENTO_DEPLOY_ID`, `BENTO_DEPLOY_LOG`, and `BENTO_DEPLOY_PAYLOAD_FILE`. After every finished attempt, the runner asks the stack-owned `/_bento/clean-opcache` route to reset OPcache through that app's own FPM socket. Failure to reset OPcache is logged but must not rewrite the deploy command's terminal result. Bento supplies orchestration and safety, not a hard-coded Git workflow.

### 6.7 Scheduled jobs and long-running workers

An app may define scheduled jobs with a schedule, timezone, working directory, output mode, timeout, and optional named lock. Jobs must run as the app user inside that app's home.

Each app with schedules gets its own scheduler process. This prevents one app's scheduler identity from executing another app's jobs and permits per-app reloads.

Long-running workers are named argv commands supervised under the app identity. The operator must be able to create, list, start, stop, restart, inspect, and remove workers. Adding or changing one worker should not recycle sibling workers or an unrelated app scheduler.

The runner for a PHP version must have exactly one replica. Scaling it would duplicate schedules and workers and is outside the architecture.

### 6.8 Desired-state rendering and change application

One local desired-state document is the source of truth for apps, domains, proxies, TLS modes, runtime versions, databases, schedules, workers, deployment settings, access-log flags, and selected custom templates.

A render must build a complete candidate generation before touching the live generated configuration. Applying a change must follow this logical transaction:

`lock -> stage -> promote -> validate -> reload -> finalize`

Required behavior:

- concurrent state/render mutations are serialized;
- candidate files are promoted with same-filesystem atomic replacement;
- stale managed files are removed only after the complete candidate exists;
- validation failure restores the previous generated bytes and modes;
- abandoned mid-promotion transactions are recoverable;
- a reload happens only after all requested validators succeed;
- a reload-signal failure keeps the already validated new generation so the signal can be retried;
- rendering alone never signals a service;
- supported mutations can be batched and applied later.

Reload targeting is part of the product behavior: ingress changes affect Nginx, pool/identity changes affect PHP-FPM, and schedule/worker changes affect only the relevant runner.

### 6.9 Identity, filesystem, and secret safety

Every app must run web, CLI, schedule, worker, and deploy processes under its stable private UID/GID. Nginx may traverse and read the public document tree but must not receive write access to app homes.

Private directories such as credentials, SSH state, dependency-manager state, logs, and deployment state must remain app-only. Public files use a shared socket/read group so Nginx can read them and connect to FPM without joining each private app group.

Startup may synchronize users and volatile runtime directories, but it must not recursively rewrite potentially large app trees. The operator needs separate check, dry-run repair, shallow repair, and explicit recursive repair workflows.

Root database credentials, app credentials, webhook secrets, certificate keys, backups, and ACME state must not be printed casually, passed in host process arguments, or stored in version control.

### 6.10 Observability and maintenance

Bento must expose an operator status view covering services, apps, selected runtimes, FPM profiles, entrypoint modes, domains, TLS state, proxies, database health, and capacity warnings.

Application access logs are opt-in. When enabled, they must record total request time and upstream response time, support bounded rotation without reloading Nginx, and be analyzable through an ad hoc terminal or static HTML report. Disabling logging must preserve existing files.

Container stdout/stderr logs and app-owned file logs need bounded retention. Stack maintenance must be runnable on demand and registrable with host cron while preserving unrelated host cron entries.

### 6.11 Customization and upgrades

The product must distinguish upstream source, local desired state, generated output, local customization, and durable runtime data.

Supported extension points are:

- environment-level stack defaults and secrets;
- ordered local Compose overlays;
- app-owned complete Nginx-vhost and PHP-pool templates;
- general user-owned config mounted through overlays;
- additional Compose services.

Activating an app template must record its ownership/provenance, render and validate it, and warn when the upstream template later changes. Returning to the upstream template must not destroy the custom source.

Upgrades must remain reviewable: local changes should not require editing tracked core files or generated output.

### 6.12 Type safety, packages, and distribution

The host control plane must target Deno 2.9 and use strict TypeScript as an architectural safety mechanism:

- persisted state, environment input, template data, JSON from subprocesses, and CLI values are runtime-validated before use;
- core concepts such as app slug, domain, UID/GID, PHP/MySQL version, service name, absolute app path, TLS mode, queue policy, deploy status, and reload target have explicit types rather than being passed around as unstructured strings or dictionaries;
- state variants and operational outcomes use discriminated unions with exhaustive handling;
- state schema versions have typed migrations and reject unknown future versions without changing files;
- exported domain and platform APIs avoid `any`; unavoidable unsafe package boundaries are isolated in adapters and immediately validated.

The project is not restricted to the Deno standard library. Maintained JSR or npm packages should be used where they materially improve CLI parsing/help, runtime schema validation, semantic-version handling, templating, terminal presentation, testing, or other non-product plumbing. Package choice must remain auditable, lockfile-pinned, compatible with direct Deno execution and `deno compile`, and free of an undeclared production install step.

Repository tasks must provide one-command formatting, linting, type checking, unit/contract tests, integration tests, direct execution, and Linux amd64/arm64 release compilation. CI must test the source entrypoint and smoke-test the compiled artifact against the same fixtures so distribution mode cannot change product behavior.

## 7. Critical user journeys

### 7.1 First production host

The operator supplies stack secrets/defaults, renders the initial topology, starts the containers, and checks service health. The fresh system includes one PHP runtime, one MySQL runtime, Redis, Nginx, and an empty app state.

### 7.2 Launch a framework application

The operator creates an app with a `public` document root and front-controller routing, chooses PHP and MySQL versions, creates a database, deploys code through the app CLI role, runs migrations, points DNS, and switches the site from shared TLS to ACME. No database or cache port is made public.

### 7.3 Operate asynchronous work

The operator adds a scheduler command and queue worker. Both run under the app identity in the versioned runner. Updating the worker reconciles only the runner; web traffic remains undisturbed.

### 7.4 Deploy from source-control webhook

The operator enables deployment, stores the returned HMAC secret in the source-control provider, and replaces the example hook. A signed push enqueues a job and receives an immediate accepted response. The next drain runs one deployment, records logs and terminal status, and clears the app pool's OPcache.

### 7.5 Recover data

The operator creates compressed logical dumps, copies them off-host, and later restores one dump to a new suffixed database for verification. Replacing the original database requires its exact name as confirmation.

## 8. Explicit non-goals and current limitations

- Multi-host scheduling, high availability, clustering, and horizontal autoscaling.
- Kubernetes, a remote control plane, browser administration UI, or public management API.
- One container per app or hard container-level isolation between apps sharing a PHP version.
- General-purpose hosting for arbitrary language runtimes; non-PHP services are supported only through reverse proxying.
- Automatic source-control checkout strategy, zero-downtime release directories, or application-specific rollback logic.
- Automatic app teardown, proxy teardown, database migration between MySQL versions, MySQL service removal, volume destruction, or MySQL password rotation.
- Automatic off-host backup replication.
- Per-app CPU/memory quotas inside a shared PHP version container.
- Real-time hosted analytics; access-log analysis is ad hoc.
- Python CLI/plugin compatibility as an implementation requirement. Existing CLI behavior remains the migration oracle, but the completed control plane has no Python runtime dependency.

## 9. Product success criteria

A reimplementation is successful when an operator can rebuild a fresh host from tracked source or the compiled release plus local desired state and durable runtime data; provision multiple apps with distinct identities and runtimes; serve them securely; operate their data, jobs, workers, and deployments; apply changes without unnecessary service disruption; and recover safely from invalid generated configuration. The same acceptance suite must pass when invoked through Deno source mode and the compiled `bento` executable.

Detailed proof requirements are in [03-reimplementation-contract.md](03-reimplementation-contract.md).
