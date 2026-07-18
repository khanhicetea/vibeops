# Bento reimplementation contract

This document defines what the Deno/TypeScript implementation must preserve and prove. It is primarily black-box oriented, but Deno 2.9, strict TypeScript, runtime-validated boundaries, reproducible package resolution, and source/binary parity are explicit implementation requirements.

## 1. Fixed decisions versus flexible decisions

### 1.1 Fixed unless the product is deliberately redesigned

- One operator-owned Linux host managed through Docker Compose.
- Host-network Nginx as the only public service.
- Per-app Unix-socket routing into version-shared PHP-FPM services.
- Stable per-app Linux identities used consistently for web, CLI, cron, worker, and deploy execution.
- One persistent FPM role, one singleton runner role, and one ephemeral CLI role per PHP version.
- One assigned MySQL service per app and private database/cache networking.
- A local desired-state source of truth and disposable generated configuration.
- Separation of upstream source, local customization, generated output, and durable runtime data.
- Staged, serialized, validated, recoverable rendering with narrow reload scopes.
- Durable named volumes for MySQL and Redis and durable host storage for apps, backups, certificates, and ACME state.
- Explicit operator confirmation for destructive restore and no automated MySQL-volume deletion.
- A host control plane implemented in strict TypeScript for Deno 2.9.x, with no Python runtime dependency after migration.
- One TypeScript entrypoint that supports direct Deno execution and standalone Linux amd64/arm64 compilation.
- Runtime validation before external data becomes a domain type, plus typed/versioned desired-state migration.
- A committed dependency lockfile and packages that work in both source and compiled modes.

Changing any of these produces a successor product, not a compatible reimplementation.

### 1.2 Flexible implementation choices

- TypeScript module/directory layout and symbol names.
- Exact CLI command names, aliases, table formatting, colors, and interactive menu design.
- Exact desired-state field names and schema layout, provided migrations/version checks exist.
- Template engine and generated file layout, provided ownership and transaction guarantees hold.
- Helper-script language and internal IPC details.
- Exact Docker image layer ordering and build optimization.
- Exact FPM profile numbers, log-retention defaults, and tool version pins, provided named policy and bounded behavior remain.
- Test framework and CI system.
- Exact JSR/npm package choices, provided they satisfy the package, security, licensing, lockfile, and compilation requirements.

If CLI compatibility with existing operator automation is required, promote command names and arguments from flexible to fixed in a separate compatibility appendix.

## 2. Priority tiers

### P0: product identity

The reimplementation is not Bento without:

- a Deno 2.9 strict-TypeScript control plane that runs from source and as the compiled `bento` executable;
- desired-state rendering and safe apply;
- host-network Nginx with PHP apps, domains, TLS, and reverse proxies;
- per-app identity, home, FPM pool/socket, and permission model;
- versioned PHP FPM/runner/CLI roles;
- one private MySQL assignment and Redis connectivity per app;
- app CLI execution;
- scheduled jobs and supervised workers;
- backup/restore safety;
- basic status and diagnostics.

### P1: complete current product

- managed PHP add/remove constraints and MySQL add-only lifecycle;
- named FPM capacity profiles and aggregate warnings;
- ACME and external certificate modes with boot TLS;
- Redis per-app ACL mode;
- authenticated webhook deployments and OPcache cleanup;
- opt-in app access logs, rotation, and GoAccess analysis;
- app vhost/pool customization with provenance;
- permission check/dry-run/repair workflows;
- guided interactive wizard and host maintenance registration.

P1 items are current features, not speculative roadmap work. The tiers describe a sensible delivery order only.

## 3. Functional acceptance matrix

| ID | Capability | Acceptance requirement |
|---|---|---|
| F-01 | Bootstrap | From an empty local state, render a startable topology containing Nginx, Redis, one PHP version's FPM/runner/CLI roles, and one durable MySQL service. |
| F-02 | App identity | Creating two apps yields stable distinct UID/GIDs, homes, pools, sockets, domains, database users, and credential files. |
| F-03 | Domain ownership | A domain or alias already owned by an app or proxy cannot be assigned elsewhere. Main-domain changes retain app identity and data. |
| F-04 | PHP routing | Front-controller apps reject direct execution of other PHP paths; legacy apps may execute existing PHP files. |
| F-05 | Static/public access | Nginx can read the selected public tree but cannot write app files or traverse private directories. |
| F-06 | Runtime selection | Shells, exec commands, schedules, workers, and deploys use the app's recorded PHP version when no override is supplied. A mismatched override fails before side effects. |
| F-07 | PHP versions | Adding a version creates all three roles. Removing a default, in-use, or final version is refused. |
| F-08 | Capacity | Apps select named FPM profiles; status warns when aggregate per-version pool maxima exceed the global process cap. |
| F-09 | MySQL ownership | An app can create only its namespaced databases on its single selected MySQL service. Cross-service creation is refused before SQL runs. |
| F-10 | Secret handling | The root password is generated once at stack initialization and each app password once at initial provisioning. Reconciliation does not alter existing MySQL account passwords, and no rotation command is provided. Passwords do not appear in host process arguments or ordinary CLI output; credential files have restricted modes. |
| F-11 | Redis modes | Shared mode emits shared auth plus an app prefix. ACL mode creates a unique app user restricted to that prefix/channel namespace. |
| F-12 | TLS | Every new site can start with boot TLS, switch to ACME or external files, and enable HTTPS redirect only for a real-certificate mode. |
| F-13 | Reverse proxy | A domain can proxy HTTP traffic to a host-reachable upstream and participate in normal TLS/domain rules. |
| F-14 | Cron | A job runs under the app user with bounded workdir, timezone, optional timeout/lock, and selected output behavior. |
| F-15 | Workers | A named argv worker can be reconciled and controlled independently; changing it does not restart sibling workers or unrelated schedulers. |
| F-16 | Manual execution | An ephemeral CLI command runs under the app UID/GID, with app home/environment and no workdir escape. |
| F-17 | Webhook auth | Only an enabled `POST /_bento/deploy` route accepts work. An unsigned/invalid raw body is rejected with 401, a body over 256 KiB with 413, and a valid SHA-256 HMAC in `X-Hub-Signature-256` or `X-Hub-Signature` receives immediate `202 {"id","status":"queued"}`. The app-writable runtime contains no webhook secret. |
| F-18 | Deploy queue | Every queue access is locked. `latest` marks older queued jobs failed/superseded while a running job finishes; FIFO processes oldest-first and rejects a 21st queued job. No app has two running deploys. Active and recent history/logs follow the 30-job retention policy. |
| F-19 | Deploy outcomes | Default hook/exit 99 is skipped, exit 0 is success, other exits are failed, and stale running work becomes failed/interrupted. History includes timestamps, result, error, payload hash/snapshot metadata, and `/home/<app>/logs/deploy-<id>.log`. Every finished job attempts OPcache reset through that app's FPM socket without changing the deploy result if reset fails. |
| F-20 | Backup | A successful dump is non-empty, private, uniquely named, and atomically finalized. Failed dumps leave no final or partial artifact. |
| F-21 | Backup batch | A mid-batch failure preserves earlier good dumps and skips retention. Successful retention is scoped per requested database and preserves the new dump. |
| F-22 | Restore | Plain/Zstandard/gzip input streams into a newly created target. Original replacement requires exact-name confirmation and warns that import is non-atomic. |
| F-23 | Access logs | Logs are absent from an app vhost by default, can be enabled without PHP/runner reload, rotate with reopen rather than config reload, and can produce a report. |
| F-24 | Customization | Selecting a custom vhost or pool preserves a user-owned source, validates the result, reports upstream drift, and can return to upstream without deleting the custom file. |
| F-25 | Compose assembly | Base, managed version fragments, and local overlays load in deterministic order through every supported Compose invocation. |
| F-26 | Safety | The supported Compose path refuses a down-with-volumes operation. MySQL version removal is unavailable. |
| F-27 | Status | Operator output identifies running roles, apps, runtimes, domains, TLS modes, proxies, DB health, and FPM-capacity problems. |
| F-28 | Source execution | On the pinned Deno 2.9.x runtime, the TypeScript entrypoint runs all scripted commands directly with the documented explicit permission set and without Python, Node.js, `npm install`, or a build step. |
| F-29 | Compiled execution | Linux amd64 and arm64 `deno compile` artifacts run on hosts without Deno/Python/Node, resolve or materialize immutable assets safely, accept an explicit external stack root, and pass the same CLI/fixture smoke suite as source mode. |
| F-30 | Source/binary parity | Given identical state, environment, asset version, and command, source and compiled modes produce byte-equivalent generated files, equal state transitions and exit codes, and equivalent normalized diagnostics. |
| F-31 | Runtime schemas | Invalid, corrupt, or future-version state; malformed environment input; invalid CLI values; and malformed subprocess JSON are rejected before side effects. Supported old state migrates deterministically and atomically. |
| F-32 | Reproducible dependencies | Clean CI succeeds from committed `deno.json` and `deno.lock` without resolution drift. Every production dependency is compatible with Deno source execution, Linux compilation, and the declared permission policy. |

## 4. Render/apply acceptance

These guarantees are independently testable and are release blockers.

| ID | Scenario | Required result |
|---|---|---|
| R-01 | Two mutations start concurrently | Only one render/state transaction executes at a time. |
| R-02 | Candidate generation fails | Existing live generated files are byte-for-byte unchanged. |
| R-03 | Promotion fails after some files | All prior files and modes are restored; no mixed generation remains. |
| R-04 | A generated file is no longer desired | It is removed only after every candidate file has been promoted successfully. |
| R-05 | Nginx/PHP/runner validation fails | Previous generation is restored and no service receives a reload/reconcile signal. |
| R-06 | All validators succeed | Only the requested service groups are signaled. |
| R-07 | Reload signaling fails | The validated new generation remains live and the failure is actionable/retryable. |
| R-08 | Process stops mid-promotion | The next render recognizes the journal and restores a deterministic usable generation. |
| R-09 | Render-only operation | Files change, but no service is signaled. |
| R-10 | Sensitive generated files | Secret file permissions remain restricted across promotion and rollback. |

## 5. Non-functional requirements

### 5.1 Safety and consistency

- State mutations and generation must be deterministic and idempotent for the same inputs.
- Explicit external side effects must succeed before state claims success, especially database creation.
- Configuration validation precedes reload and invalid config must not replace a usable generation.
- Destructive actions require explicit, specific intent rather than a generic yes/no default.

### 5.2 Security

- Only ingress is public in the base topology.
- All app execution paths drop to the app identity.
- Secrets are restricted at rest and avoided in host argv/log output.
- User-supplied names, paths, schedules, and command structures are validated at trust boundaries.
- Customization sources cannot escape their owned directories. Selected app templates are trusted operator inputs; activation must be explicit, syntactically validated, and accompanied by a clear contract for required identity, socket, and TLS structure.
- The webhook handler is stack-owned; only the deploy hook and queue are app-owned.
- Deno permissions for source and compiled execution are explicit and centrally defined; unrestricted `-A` is not the supported default.
- Package code is lockfile-pinned and cannot gain network, subprocess, FFI, or out-of-root filesystem authority merely for installation or convenience.

### 5.3 Type safety and package boundaries

- Strict TypeScript is enabled for all production control-plane modules.
- Persisted/external input is represented as `unknown` until a runtime schema validates it.
- Domain services use explicit value types and discriminated unions for identities, versions, modes, statuses, reload targets, and results.
- Exhaustive handling is enforced for variants that change control flow or side effects.
- Production domain APIs contain no unbounded `any`; unsafe third-party boundaries are isolated, validated adapters.
- JSR/npm packages are allowed and encouraged where they reduce bespoke infrastructure, but direct URL imports, undeclared dependencies, duplicate-purpose libraries, and mandatory production install scripts are rejected.

### 5.4 Availability and blast radius

- Ordinary domain/TLS/log changes do not reload FPM or runners.
- Cron/worker/deploy-drain changes do not reload Nginx or FPM.
- Database administration does not reload web/runtime services.
- A worker definition change affects only its matching s6 service.
- Nginx and PHP-FPM reloads must be graceful rather than container restarts when supported.

### 5.5 Durability

- App homes, MySQL/Redis data, backups, certificates, ACME state, and local customization survive render and container recreation.
- Generated state can be deleted and fully rebuilt from desired state and tracked source.
- Named-volume deletion is never an implicit part of normal lifecycle commands.

### 5.6 Operability

- The product must be usable headlessly and through an interactive guide.
- Error messages identify the failed boundary and a practical recovery action without exposing secrets.
- Stopped-service behavior is explicit: config is prepared for startup rather than pretending a reload occurred.
- The merged Compose model and desired state remain inspectable.

### 5.7 Portability

- The supported production platform is Linux on amd64 or arm64 with Docker Compose v2.
- Host-control dependencies remain minimal.
- Runtime-version and image choices are derived rather than hard-coded to a single PHP/MySQL release.
- Source operation uses a pinned Deno 2.9.x; compiled operation requires no installed language runtime or package manager.
- Immutable assets resolve identically in repository and compiled modes; mutable operator/durable paths always live under an explicit external stack root.

## 6. Python replacement and cutover

The existing Python implementation is the behavioral oracle during migration, not a long-term runtime. Replacement proceeds by vertical feature slices behind shared black-box fixtures:

1. Capture representative current state, environment, rendered output, CLI exit codes, normalized diagnostics, and subprocess interactions as fixtures before replacing a slice.
2. Implement the slice through typed domain and platform interfaces in Deno, then run Python and Deno in isolated temporary stack roots against the same inputs.
3. Compare state transitions, generated bytes, requested external effects, errors, and reload scope. Resolve intentional differences in this specification rather than hiding them in fixture normalization.
4. Permit dual-running only for read-only comparison. Python and Deno must never concurrently mutate the same state, generated tree, database, queue, or service.
5. Before the first Deno write to an existing stack, validate the complete old state and create a recoverable state/generated backup. A migration is atomic and records its schema/tool version.
6. Keep a temporary source-compatible launcher only if needed for operator cutover. The finished release removes Python imports and does not require a Python interpreter; existing automation compatibility is documented separately if retained.

A no-op Deno read/status/render of a supported current state must not silently rewrite it merely because object key order or TypeScript defaults differ. Destructive or irreversible migration steps require an explicit command, preview, and recovery procedure.

## 7. Recommended implementation sequence

This sequence minimizes architectural rework; it is not a coding task breakdown.

### Phase 1: state and topology foundation

Establish the pinned Deno project, package/lockfile policy, strict compiler/tooling tasks, domain value types, runtime schemas/migrations, platform interfaces, source/compiled asset resolver, desired-state model, Compose assembly, managed version roles, render transaction, recovery journal, and service-target abstraction. Prove F-28 through F-32 and R-01 through R-10 before adding many feature renderers.

### Phase 2: ingress and app identity

Implement app provisioning, stable identities, filesystem policy, FPM pools/sockets, HTTP/HTTPS vhosts, domains, routing modes, TLS, reverse proxies, and ephemeral CLI execution. This establishes the product's main trust and request boundaries.

### Phase 3: private data services

Add versioned MySQL, Redis modes, app grants/credentials, database administration, and backup/restore. Prove that secrets never leak into host argv and that durable data is not coupled to container lifecycle.

### Phase 4: background and deployment runtime

Add the singleton per-version runner, per-app schedulers, independently supervised workers, then authenticated deployment queues and OPcache cleanup. Keep every background path tied to the app identity.

### Phase 5: operations and extension surface

Add access logging/analysis, maintenance scheduling, capacity warnings, permission tooling, customization provenance, guided UX, and upgrade diagnostics.

## 8. System-level acceptance scenarios

Before declaring the replacement complete, run these end-to-end scenarios on a disposable Linux host:

1. Bootstrap the empty stack and recreate all containers without losing Redis/MySQL data.
2. Create two apps on the same PHP version and prove their identities, sockets, files, credentials, and domains remain separate.
3. Add a second PHP version, migrate one app intentionally, and prove its shell, FPM, cron, worker, and deploy path all follow it.
4. Serve one front-controller app, one legacy app, and one reverse-proxy site with globally unique domains.
5. Transition a site from boot TLS to a real certificate mode without disrupting PHP or workers.
6. Create databases for two apps, refuse a cross-MySQL-service operation, and prove each generated password remains stable through reconciliation.
7. Exercise Redis shared mode and ACL mode, confirming prefix behavior and denied cross-app access in ACL mode.
8. Run schedules with locks/timeouts and workers with independent restart behavior.
9. Execute valid, invalid, burst, FIFO, skipped, failed, and timed-out deploy requests; inspect history/logs and verify OPcache cleanup is attempted.
10. Inject render, promotion, validation, reload, dump, and restore failures and confirm the documented recovery semantics.
11. Enable access logs for one app, rotate them under live traffic, and generate a static report without reloading application runtimes.
12. Apply a custom vhost/pool, simulate an upstream template update, observe drift, then return to upstream generation without losing the custom source.
13. Run a representative bootstrap/render/status/error workflow from TypeScript source and both compiled Linux architectures; compare generated bytes, state, exit codes, and normalized output.
14. Corrupt each external boundary in turn (state JSON, schema version, environment value, CLI token, package lock, embedded asset digest, and subprocess JSON) and prove rejection occurs before side effects.

## 9. Definition of done

The reimplementation is done when:

- all P0 and agreed P1 capabilities are implemented;
- every functional and render/apply acceptance item has automated coverage where practical;
- the fourteen system scenarios pass on a clean Linux host;
- security review confirms public surface, identity switching, secret paths, and destructive-operation guards;
- type review confirms strict mode, validated external boundaries, exhaustive state variants, and contained package adapters;
- dependency review confirms a frozen lockfile, acceptable packages/licenses, and source/compiled compatibility;
- generated state can be deleted and reproduced without loss of durable state;
- an operator can understand current state, preview or batch changes, recover from invalid config, and perform backup/restore without reading implementation source;
- no required behavior depends on manually editing generated files;
- the released Linux amd64/arm64 binaries require no Deno, Python, Node.js, or package installation and pass the same behavioral smoke suite as source mode.
