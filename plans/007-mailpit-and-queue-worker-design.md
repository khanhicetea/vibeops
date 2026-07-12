# Plan 007: Design spike — Mailpit profile and app queue workers

> **Executor instructions**: This is a **design/spike plan**, not a full feature
> ship. Produce the design note and a minimal optional prototype only if the
> design fits existing patterns cleanly. If scope expands into multi-week work,
> stop after the design document. Update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- compose.yml docker/php/ bento/services/cron_runtime.py bento/commands/cron_commands.py docs/architecture.md README.md`
> On large drift in cron/compose models, re-read before writing the design.

## Status

> Update 2026-07-12: the worker portion is now implemented as versioned
> `phpXX-runner` services with Supervisord PID 1, per-app Supercronic children,
> and first-class `manage.py worker` commands. Mailpit remains unimplemented.
> The sections below are retained as the original design-spike brief.

- **Priority**: P3
- **Effort**: M (design); L if fully implemented later
- **Risk**: LOW for design-only; MED for implementation (long-running processes, mail relay abuse)
- **Depends on**: none (implementation later may depend on 001 lifecycle)
- **Category**: direction
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

bento already treats **cron** as a first-class, versioned, multi-tenant concern (supercronic, `php-cron-as`, state in `stack.json`). Laravel/WordPress-style apps also need:

1. **Outbound/dev mail** — password resets, notifications (no SMTP path in compose today)
2. **Queue workers** — `queue:work` / Horizon-style long-running PHP processes (today: abuse cron or run manually via `exec`)

Shipping either without a design will fork patterns (another supervisor? reuse cron containers? separate worker services?). This plan locks an architecture that matches bento isolation rules (per-app UID, PHP version affinity, no root app code).

## Current state (grounding)

- Services: nginx, php84/85 FPM, php84/85-cron, php84/85-cli (profile), mysql*, redis, node (profile)
- Cron: app jobs in state → generated files → supercronic as root scheduler → `php-cron-as` drops privileges
- CLI: `exec` / `shell` via ephemeral `php*-cli` + `php-app-run`
- No mail container; no worker container; Node is toolbox-only (`sleep infinity`)
- Architecture rule: PHP runtime split by role (FPM vs cron vs CLI) sharing the same image

## Deliverables (this plan)

### Required

1. **Design note** at `docs/design-mail-and-workers.md` covering:
   - Goals / non-goals
   - Mail: Mailpit for dev/profile vs production SMTP injection into app env
   - Workers: process model, isolation, restart, logging, scaling warning (like cron: do not scale replicas)
   - State schema sketch for `workers` or extension of app records
   - CLI sketch (`mail …`, `worker create|list|remove`)
   - Security notes (open relay forbidden; Mailpit not exposed on host by default)
   - Comparison of options with a recommendation
   - Implementation phases (P0/P1/P2)

2. **Decision table** in that doc: chosen approach vs rejected alternatives

### Optional (only if cheap and aligned)

3. **Compose profile prototype** for Mailpit only:

```yaml
# sketch — final design may differ
  mailpit:
    image: axllent/mailpit
    profiles: ["mail"]
    networks: [backend]
    # no host ports by default; document how to publish 8025 for local UI
```

4. **README pointer** under optional profiles

Do **not** implement full worker orchestration in this plan unless the design is trivial (it will not be).

## Design questions the doc must answer

### Mail

| Question | Constraint |
|----------|------------|
| Dev vs prod? | Mailpit profile for lab; prod = SMTP env in credentials file (`MAIL_HOST`, etc.) |
| Host exposure? | Default: backend network only; optional publish for UI |
| App wiring? | Extend credentials template with mail vars when profile/env set |
| Spam risk? | Never run an open relay; no postfix “send anything” by default |

### Workers

| Question | Constraint |
|----------|------------|
| Where do workers run? | Prefer dedicated `phpXX-worker` service **or** per-app `compose.d` — compare |
| Privilege drop? | Must run as app UID like cron/cli (`php-app-run` or similar) |
| Multiple workers per app? | Support N named workers in state |
| Overlap? | Document mutual exclusion with cron schedule for same job |
| Horizon? | Special case (needs more than one process / redis) — phase 2 |
| Reload? | How does `worker create` signal supervisord/s6/supercronic? |
| Logs? | Docker logging driver vs app log files (mirror cron `--output`) |

**Recommended starting opinion (executor may revise with evidence):**

- **Mailpit**: compose profile `mail`, backend-only, document port publish for UI; credentials get `MAIL_HOST=mailpit`, `MAIL_PORT=1025`
- **Workers**: new long-running role `phpXX-worker` running a tiny supervisor that reads `runtime/generated/worker/phpXX/*.conf` generated from state — **not** supercronic (cron is interval-based; workers are persistent). Alternative lighter v1: document `docker compose run` patterns only (weaker DX).

## Scope

**In scope**:
- `docs/design-mail-and-workers.md` (create)
- Optional: `compose.yml` mailpit profile + `.env.example` comments + README note
- Optional: `plans/README.md` follow-up plan stubs listed at end of design doc

**Out of scope**:
- Full worker CLI + supervisor implementation
- Production Postfix/Exim
- Kubernetes
- Changing cron semantics

## Git workflow

- Branch: `advisor/007-mail-worker-design`
- Commit style: e.g. `design mail and workers`
- Do not push unless asked

## Steps

### Step 1: Read adjacent code

Read fully:

- `docs/architecture.md` (cron + identity)
- `docker/php/bin/php-cron-as`, `php-app-run`, `php-supercronic`
- `compose.yml` service roles
- `bento/commands/cron_commands.py` CLI shape

### Step 2: Write design doc

Use clear headings, ASCII diagrams for process model, and an explicit **Recommendation** section.

### Step 3: Optional Mailpit profile

If the design recommends Mailpit as profile, implement the minimal compose profile + docs only.

### Step 4: Stop

Do not start worker generator code in this plan. List “Implementation plan 008” outline at the bottom of the design doc for a future advisor/executor pass.

**Verify**:

- Design file exists and is internally consistent
- `make check` still passes (no breakages)
- If compose changed: `docker compose config` succeeds (when docker available)

## Test plan

- No required new unit tests for design-only
- If Mailpit profile added: no test required beyond compose config validity

## Done criteria

- [ ] `docs/design-mail-and-workers.md` exists with recommendation + rejected alternatives
- [ ] Security notes cover open relay and host port exposure
- [ ] Worker model respects per-app UID and PHP version affinity
- [ ] Optional Mailpit profile either shipped minimally or explicitly deferred in the doc
- [ ] `make check` still green
- [ ] `plans/README.md` → DONE (design complete; implementation not claimed)

## STOP conditions

- Implementing a full supervisord stack mid-spike without writing the design first
- Exposing Mailpit SMTP on `0.0.0.0:25` or host 25
- Running workers as root

## Maintenance notes

- After product approval, split implementation into: (008) Mailpit+credentials, (009) worker state+CLI+service
- Revisit when Laravel Horizon users appear — may need redis + multiple processes per app
