# Bento remaining work (agent todo)

Status snapshot: **~92% capabilities coded · ~78% acceptance proven · ~82% definition of done** (Phase A+B+C+D complete)

Read first (in order):

1. [README.md](README.md)
2. [01-product-spec.md](01-product-spec.md)
3. [02-system-architecture.md](02-system-architecture.md)
4. [03-reimplementation-contract.md](03-reimplementation-contract.md)

This file is the **remaining work backlog** derived from the specs vs current `src/`, `templates/`, and `tests/`. Prefer vertical slices that end with tests. Do not invent destructive teardown (app delete, MySQL volume remove). Do not switch to one-container-per-app.

## Working rules for agents

- Pin Deno **2.9.x**; use `deno task fmt|lint|check|test` before finishing a slice.
- External input enters as `unknown` and is runtime-validated (zod); no `any` in domain.
- Domain must not import CLI/prompts/`Deno.*` directly; use platform interfaces.
- Secrets: never host argv, never casual status print, restricted modes on disk.
- Generated config is disposable; desired state + durable data are not.
- Source mode and compiled mode must stay behavior-equivalent.
- Prefer automated tests for every acceptance ID you claim done.
- Update this file when closing items: mark `[x]`, note PR/commit, leave residual risks.

### Suggested check command after each slice

```bash
deno task fmt
deno task lint
deno task check
deno task test
```

---

## Priority legend

| Tag | Meaning |
|-----|---------|
| **P0** | Product identity / release blocker |
| **P1** | Current product feature (contract complete set) |
| **P2** | Hardening, proof, polish |
| **ID** | Contract acceptance id (`F-*`, `R-*`) when applicable |

---

## Phase A — Wire live side effects (high value, incomplete today)

Control plane often records intent without applying data-plane changes. Fix before claiming MySQL/Redis journeys done.

### A1. Apply MySQL grants on provision / db create  **P0** · F-09 · F-10

- [x] On `app create --db` (and `mysql db`), when Compose/MySQL is reachable, run `grantSql` via `execMysqlSql` using root option-file path (no password on host argv).
- [x] Fail **before** recording a new database in state if MySQL is unavailable and the operator made an **explicit** database request (product §7.1 / architecture §7.1).
- [x] Best-effort account setup without `--db` may defer; document operator recovery (`mysql db` retry).
- [x] Never print `mysqlPassword` / root password in CLI output.
- [x] Tests: unit with recording process runner (argv must not contain password); contract for explicit-db failure path when exec fails.

**Touch:** `src/services/app.ts`, `src/services/mysql.ts`, `src/commands/router.ts`, `src/commands/wizard.ts`, tests.

### A2. Apply Redis ACL / shared credentials on provision  **P0** · F-11

- [x] Shared mode: ensure app env/credential files get shared auth + **app key prefix**.
- [x] ACL mode: generate unique user/password; call `applyAppRedisAcl` when Redis is up; rules limited to prefix/channel namespace.
- [x] Wire into app create/update and a safe re-apply path (e.g. after redis mode change).
- [x] Tests: ACL rule content; shared prefix env; no secret in status JSON.

**Touch:** `src/services/redis.ts`, `src/services/app.ts`, commands, tests.

### A3. Materialize root MySQL client option files from env  **P0** · F-10 · R-10

- [x] Generated root client files must receive real restricted-mode content from stack secrets/env at materialize/apply time (not permanent empty placeholders).
- [x] Modes stay `0600` (or stricter) across promote and rollback.
- [x] Test: mode bits after apply + after validation rollback.

**Touch:** `src/services/generate.ts`, `src/services/render.ts`, `src/services/state_store.ts`, tests.

---

## Phase B — Finish incomplete operator commands (P1)

### B1. MySQL shells, sizes, processes  **P1** · product §6.5

- [x] `mysql shell --root` and `mysql shell --app <slug>`: stage protected in-container option file via stdin; remove after; no password in host argv.
- [x] `mysql size` / `mysql processlist` (or equivalent): show DB sizes and active processes without leaking secrets.
- [x] Wizard entries for the same.
- [x] Tests: process argv recording; help/usage smoke.

### B2. Worker lifecycle control  **P1** · F-15

- [x] CLI: `worker start|stop|restart|inspect` (and list already exists) targeting flat Supervisor program names.
- [x] Changing one worker must not restart siblings / unrelated schedulers (already model-ready; prove via reload plan + supervisorctl args).
- [x] Tests: program name stability; scoped runner reload only.

**Touch:** `src/services/worker.ts`, `src/services/render.ts` reloader, `src/commands/router.ts`, wizard, tests.

### B3. Access logs: rotate + GoAccess report  **P1** · F-23

- [x] Default: access logs absent from vhost (already).
- [x] Enable/disable without PHP/runner reload (nginx-only plan).
- [x] Rotation with **reopen** (not full nginx config reload) under live traffic.
- [x] One-shot GoAccess container/report generation to static HTML; no permanent analytics service.
- [x] Disabling logging preserves existing files.
- [x] CLI: e.g. `logs access enable|disable|rotate|report --app <slug>`.
- [x] Tests: vhost snippet presence/absence; reload plan scope; report command dry-run/fixture.

**Touch:** generate templates, new service module, commands, docker/nginx log paths, tests.

### B4. App template customization + drift  **P1** · F-24

- [x] Commands to **select** custom vhost/pool template (copy or point to user-owned source), record provenance.
- [x] Render + validate after activation.
- [x] Detect upstream template drift vs recorded digest/version; warn on status/apply.
- [x] **Return to upstream** without deleting custom source file.
- [x] Tests: provenance round-trip; drift warning; return-to-upstream leaves custom file on disk.

**Touch:** `src/domain/state.ts`, `src/services/generate.ts`, new customization service, commands, tests.

### B5. Host maintenance registration  **P1** · product §6.10

- [x] On-demand stack maintenance task (log retention, etc.).
- [x] Register/unregister with **host cron** while preserving unrelated crontab entries.
- [x] Document that in-runner logrotate is separate from host maintenance.
- [x] Tests: crontab merge/preserve logic with fixtures (no real root required).

### B6. Deferred / batched mutations  **P1** · product §6.8

- [x] Support mutating desired state without immediate apply (partially present via `--no-apply` on some commands).
- [x] Uniform `--no-apply` / `apply` workflow across app/php/mysql/proxy/tls/cron/worker/deploy.
- [x] Optional batch preview: show pending reload plan before apply.
- [x] Tests: multiple mutations then single apply produces one transaction.

---

## Phase C — Render/apply hardening (release blockers)  **P0** · R-*

Code exists in `RenderService`; close proof and edge gaps.

| ID | Task | Done |
|----|------|------|
| R-01 | Concurrent mutations: two `apply`/state writers; only one transaction at a time (exclusive lock). Add stress/unit test with memory or file lock. | [x] |
| R-02 | Candidate generation failure leaves live generation **byte-identical**. Test with injected generator failure. | [x] |
| R-03 | Mid-promote failure restores all prior files **and modes**. Expand tests beyond happy path. | [x] |
| R-04 | Stale managed file removed only after full candidate promote. Explicit unit test. | [x] |
| R-05 | Validation failure restores previous generation; no reload signal. (Exists — keep green.) | [x] |
| R-06 | Only requested service groups signaled. Assert reloader args for domain-only vs pool vs runner vs full. | [x] |
| R-07 | Reload signal failure keeps validated new generation; actionable error. (Exists — keep green.) | [x] |
| R-08 | Abandoned journal: kill mid-promote; next render restores deterministic generation. Dedicated test. | [x] |
| R-09 | Render-only never signals services. (Exists — keep green.) | [x] |
| R-10 | Secret file modes restricted across promote **and** rollback. | [x] |

### C1. Compose fragment transactional safety  **P0**

- [x] Managed PHP/MySQL Compose fragments follow same safety story as other generated files (or document equivalent guarantee and test it).
- [x] `compose config` validation before relying on new fragments when Docker available; soft-skip when Docker missing (current behavior OK if explicit).

---

## Phase D — Distribution parity  **P0** · F-28 · F-29 · F-30

- [x] **F-29:** Smoke-test compiled Linux artifacts (at least native compile in CI/dev; amd64/arm64 in release pipeline).
  - `deno task compile` then run `./dist/bento --stack <tmp> init|render|status|version` without Deno on PATH if feasible.
- [x] **F-30:** Given identical state/env/assets/command, source vs compiled produce:
  - byte-equivalent generated files (normalize only where explicitly documented)
  - equal state transitions and exit codes
  - equivalent normalized diagnostics
- [x] Asset materialize: digest-addressed cache; compiled `--include=templates` parity with source repo assets.
- [x] Version banner reports Bento version **and** pinned Deno target (already started in `version.ts` — keep accurate).
- [x] Task or script: `deno task test:parity` (or contract test that spawns binary when `BENTO_BIN` set).

**Touch:** `deno.json` tasks, `tests/contract/`, `src/platform/assets.ts`, `src/services/assets_materialize.ts`, CI notes in README.

---

## Phase E — Missing / thin product edges

### E1. TLS real-world behavior  **P1** · F-12

- [ ] Boot cert generation path solid for first start (entrypoint + materialize).
- [ ] ACME mode: generated nginx markers/snippets sufficient for challenge; document operator DNS requirements.
- [ ] External mode: cert/key path validation; no world-readable keys.
- [ ] HTTPS redirect only when mode ≠ boot (template already; add contract test on generated server block).

### E2. PHP routing proof  **P1** · F-04

- [ ] Fixture-level assert: front-controller vhost rejects direct `/foo.php` execution patterns; legacy allows existing scripts.
- [ ] Optional integration later with real nginx container.

### E3. Deploy HTTP surface completeness  **P1** · F-17–F-19

- [ ] Confirm generated `/_bento/deploy` and `/_bento/clean-opcache` locations match helpers under `templates/helpers/`.
- [ ] Disabled deploy ⇒ route absent or 404 in generated config (test).
- [ ] FIFO 429 / invalid 401 / oversized 413 behavior covered in PHP helper tests or documented harness.
- [ ] Drain default argv `sh /home/<app>/.bento/deploy.sh`; exit 99 skipped; timeout + grace interrupt.
- [ ] History/logs under `/home/<app>/logs/deploy-<id>.log` with retention prune.

### E4. Permissions workflows  **P1** · product §6.9

- [ ] Check / dry-run / shallow repair / explicit recursive repair all CLI-complete and documented.
- [ ] Do not follow symlink targets (prove with test fixture).
- [ ] Startup must not recursively chown large trees (guard/assert).

### E5. Status completeness  **P1** · F-27

- [ ] Status covers: running roles, apps, runtimes, FPM profiles, entrypoint modes, domains, TLS, proxies, DB health, capacity warnings.
- [ ] Redact secrets in human and `--json` output.
- [ ] Stopped services: config ready message, not fake reload success.

### E6. Schema migrations framework  **P2** · F-31

- [ ] Keep rejecting future `schemaVersion` without write.
- [ ] When schema bumps: typed `migrateV1toV2` chain, atomic save, backup before migrate.
- [ ] No silent rewrite on no-op read (key order / defaults).

### E7. Interactive wizard gaps  **P1**

- [x] Align wizard sections with any new CLI (mysql shell, logs, templates, worker control, maintenance).
- [x] Keep all important operations scriptable (wizard is convenience only).

### E8. Overlay / Compose inspect  **P1** · F-25 · architecture §11

- [ ] Deterministic overlay order (lexicographic) — exists; add test with multiple overlay files.
- [ ] Command or status note showing merged Compose file list.
- [ ] Refuse volume-destructive down (exists — keep green).

---

## Phase F — Test and acceptance proof (closes “definition of done”)

### F1. Expand unit/contract matrix  **P0**

Map each F-*/R-* to at least one automated test where practical. Current baselines:

| Area | Existing tests | Still needed |
|------|----------------|--------------|
| Validators / state | `tests/unit/validators_test.ts` | env/CLI token rejection cases |
| App identity / domains | `tests/unit/app_test.ts` | docroot safety; legacy flag generation |
| Render transaction | `tests/unit/render_test.ts`, `phase_c_test.ts` | keep green; expand integration later |
| Deploy | `tests/unit/deploy_test.ts` | history prune files; interrupt reclaim |
| CLI smoke | `tests/contract/cli_smoke_test.ts` | backup/restore dry paths; tls set; permissions |
| TUI | `tests/unit/tui_test.ts` | keep as UI-only |
| Integration | **empty** | see F2 |
| Parity | `tests/contract/parity_test.ts` | keep green; release runs `test:parity` |

### F2. Integration suite  **P0** · contract §8

Populate `tests/integration/` (skip automatically if Docker unavailable):

- [ ] Bootstrap empty stack; `compose up` subset or `compose config` validation.
- [ ] Create two apps; assert homes/pools/sockets/domains separate on disk.
- [ ] PHP add second version; move one app; exec uses new version.
- [ ] Front-controller + legacy + proxy domains unique.
- [ ] TLS mode switch boot → external (files) without runner reload.
- [ ] MySQL create/refuse cross-service; password rotate isolation.
- [ ] Redis shared vs ACL (if redis up).
- [ ] Cron/worker config generation + scoped reload plan.
- [ ] Deploy enqueue/drain with fake hook exits 0/99/1.
- [ ] Inject validation failure; confirm rollback.
- [ ] Access log enable + report if implemented.
- [ ] Custom template select/return if implemented.
- [ ] Corrupt state/env boundaries; reject before side effects.

### F3. System scenarios checklist (manual or CI host)  **P0**

Track the fourteen scenarios from contract §8. Mark when run on a disposable Linux host:

1. [ ] Bootstrap; recreate containers without losing Redis/MySQL data
2. [ ] Two apps same PHP version; isolation proof
3. [ ] Second PHP version; migrate one app end-to-end
4. [ ] Front-controller + legacy + reverse-proxy sites
5. [ ] Boot TLS → real cert mode without disturbing PHP/workers
6. [ ] DBs for two apps; refuse cross-MySQL; rotate one password
7. [ ] Redis shared + ACL cross-app denial
8. [ ] Schedules with locks/timeouts; independent worker restart
9. [ ] Deploy valid/invalid/burst/FIFO/skip/fail/timeout; OPcache attempt
10. [ ] Inject render/promote/validate/reload/dump/restore failures
11. [ ] Access logs enable/rotate/report without runtime reload
12. [ ] Custom vhost/pool; upstream drift; return to upstream
13. [ ] Source + compiled amd64/arm64 parity smoke
14. [ ] Corrupt each external boundary; reject before side effects

### F4. CI / release gates  **P0** · product §6.12

- [ ] CI: `fmt:check`, `lint`, `check`, `test`, `test:integration` (optional allow-skip), compile, binary smoke.
- [ ] Fail on lockfile drift / unlock resolution.
- [ ] Document exact Deno 2.9.x pin in README/release notes.
- [ ] No required `-A` in documented operator path.

---

## Phase G — Explicit non-goals (do **not** implement)

Agents must **not** spend time on:

- Multi-host / k8s / remote control plane / browser admin UI
- One container per app
- Automatic app or proxy teardown
- Automated MySQL version/volume deletion
- Automatic off-host backup replication
- Hard-coded Git deploy workflow (orchestration only)
- Python runtime dependency or Python plugin compatibility as a requirement
- Per-app CPU/memory quotas inside shared PHP containers

---

## Suggested implementation order for the next agent

Do in this order unless blocked:

1. ~~**Phase A**~~ done  
2. ~~**Phase B**~~ done  
3. ~~**Phase C**~~ done  
4. ~~**Phase D**~~ done  
5. **Phase F** integration + system scenarios  
6. **Phase E** residual polish (TLS/deploy/permissions/status)  

---

## Quick file map

| Concern | Primary paths |
|---------|----------------|
| CLI | `src/commands/router.ts`, `wizard.ts`, `context.ts` |
| Domain state | `src/domain/state.ts`, `types.ts`, `reload.ts`, `errors.ts` |
| Schemas | `src/schemas/state.ts`, `validators.ts` |
| Render tx | `src/services/render.ts`, `generate.ts` |
| Apps | `src/services/app.ts`, `permissions.ts` |
| PHP | `src/services/php.ts` |
| MySQL | `src/services/mysql.ts` |
| Redis | `src/services/redis.ts` |
| Deploy | `src/services/deploy.ts`, `templates/helpers/*` |
| Cron/worker | `src/services/cron.ts`, `worker.ts` |
| Access logs | `src/services/access_log.ts` |
| Customization | `src/services/customization.ts` |
| Maintenance | `src/services/maintenance.ts` |
| Compose | `src/services/compose.ts`, `templates/compose/`, `templates/docker/` |
| Assets | `src/platform/assets.ts`, `src/services/assets_materialize.ts` |
| Templates | `templates/nginx/`, `templates/php/`, `templates/helpers/` |
| Tests | `tests/unit/`, `tests/contract/`, `tests/integration/` (empty) |
| Tooling | `deno.json`, `deno.lock`, `README.md` |

---

## Progress log

| Date | Agent | Notes |
|------|-------|-------|
| 2026-07-17 | coverage pass | Initial todo written from specs vs tree; 50 unit/contract tests green; integration empty; F-30 missing; live MySQL/Redis apply not wired on create |
| 2026-07-17 | phase A | Wired live MySQL grants (fail-closed on explicit `--db`/`mysql db`), best-effort account setup, Redis shared prefix + ACL apply (stdin secrets), root.cnf materialize from stack `.env` at 0600 with rollback mode proof. Added `stack_env.ts`, `applyAppDataPlane`, `tests/unit/mysql_redis_test.ts`. 63 unit/contract tests green. Residual: redis mode-change re-apply command surface still thin; R-10 only proven for root.cnf. |
| 2026-07-17 | phase B | Finished operator commands B1–B6: mysql shell/size/processlist (stdin-staged cnf, no host argv secrets); worker start/stop/restart/inspect (scoped supervisorctl); access logs enable/disable/rotate/report (nginx-only + reopen + GoAccess one-shot); template select/return/drift (provenance + preserve custom source); host maintenance run + crontab merge; uniform `--no-apply` + `apply --preview`. New modules `access_log.ts`, `customization.ts`, `maintenance.ts`; tests in `phase_b_test.ts` + cli smoke. 78 tests green. Dropped global `--root` alias for `--stack` so `mysql shell --root` works. Residual: interactive shell needs live docker; host cron register needs real crontab perms; GoAccess report needs image pull. |
| 2026-07-17 | phase C | Closed R-01–R-10 proof + C1 compose transactional safety. Added `candidateFactory`/`afterPromoteFile` test hooks; compose `config -q` validator (soft-skip when Docker down, fail-closed on real errors); fixed memory-lock TOCTOU so concurrent exclusive acquirers serialize. New `tests/unit/phase_c_test.ts` (17 cases). 95 unit/contract tests green. Residual: integration suite still empty; file-lock under real multi-process stress not in CI. |
| 2026-07-17 | phase D | Distribution parity F-28/F-29/F-30. Digest-addressed asset cache (`.asset-cache/<digest>/` → publish `docker/`+`helpers/`); asset resolver notes for compile `--include=templates`; version banner kept accurate; `deno task test:parity` + `smoke:compiled`; contract suite `tests/contract/parity_test.ts` (source smoke always; binary smoke/parity when `BENTO_BIN`/`dist/bento`). README CI/release notes. Residual: cross-arch binary execution still release-host only (compile:amd64/arm64 produce artifacts). |

When you complete a slice, append a row and check boxes above.
