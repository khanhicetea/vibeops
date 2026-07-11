# Plan 009: Add configurable memory-efficient PHP-FPM pool profiles

> **Executor instructions**: Preserve valid PHP-FPM syntax for both dynamic and ondemand modes. Do not silently change existing app behavior without the migration rule below. Update the plan index only after render and profile tests pass.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- config/php/templates/pool.conf.template docker/php/Dockerfile vibeops/helpers.py vibeops/parser.py vibeops/app_commands.py vibeops/runtime_commands.py vibeops/wizard_commands.py tests .env.example README.md docs/architecture.md docs/customization.md`
> Plans 002 and 005 change app metadata resolution and rendering. Use their final state/render APIs.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-establish-verification-and-ci.md`, `plans/002-resolve-app-php-version.md`, `plans/005-transactional-render-apply.md`
- **Category**: perf / dx
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

Every app pool currently starts two PHP workers even when idle. A PHP version with seventeen apps requests at least 34 startup workers while the image has global `process.max = 32`; memory use and startup pressure grow with app count. Pools need safe named profiles, with `ondemand` as the low-traffic default for new apps and explicit higher-throughput options.

## Current state

```ini
; config/php/templates/pool.conf.template:10-15
pm = dynamic
pm.max_children = 6
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 256
```

```dockerfile
# docker/php/Dockerfile:55
printf '[global]\n...\nprocess.max = 32\ninclude=...\n' > ...
```

`app create` state already stores app-specific runtime choices such as `public_dir` and `php_entrypoint`. Follow that pattern. The tiny template engine supports variables and `{% if %}` but not arbitrary expressions (`vibeops/template.py`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_fpm_profiles` | all pass |
| Full gate | `make check` | exit 0 |
| Render smoke | temporary-state render test | each generated pool contains only directives valid for selected mode |
| Docker validation | `./manage.py compose exec -T php85 php-fpm -tt` | exit 0 when a test stack is available |

## Scope

**In scope**:

- `config/php/templates/pool.conf.template`
- App state normalization/render values in `vibeops/helpers.py` or the post-Plan-005 render module
- `vibeops/parser.py`, `app_commands.py`, and `wizard_commands.py`
- `.env.example`
- `tests/test_fpm_profiles.py` (create)
- `README.md`, `docs/architecture.md`, `docs/customization.md`
- `docker/php/Dockerfile` only if making global `process.max` configurable is needed

**Out of scope**:

- Automatic memory detection or benchmarking
- Per-request autoscaling
- Container resource limits
- Changing PHP extensions/opcache
- Arbitrary raw pool directives from untrusted state
- Removing the global process cap without a replacement safety bound

## Git workflow

- Branch: `advisor/009-fpm-profiles`
- Commits: `add fpm pool profiles`, `document fpm tuning`.
- Do not push.

## Steps

### Step 1: Define a small validated profile model

Add named profiles in Python, not duplicated across parser/template/docs:

- `ondemand`: `pm=ondemand`, bounded `max_children`, `process_idle_timeout`, `max_requests`; no dynamic-only spare/start directives.
- `balanced`: conservative `pm=dynamic` values near current defaults.
- `throughput`: higher dynamic values, still bounded and documented as requiring memory sizing.

Store only the profile name in app state (`fpm_profile`). Render concrete directives from one profile registry. Support a stack default via `.env` such as `DEFAULT_FPM_PROFILE=ondemand`, validated against known names.

Migration rule:

- Existing schema records that lack `fpm_profile` normalize to `balanced` so an update does not silently alter established capacity.
- Newly created apps use `DEFAULT_FPM_PROFILE`, defaulting to `ondemand`.
- Once saved/rendered, records carry an explicit profile.

If schema version must increase, add an explicit normalization/migration test; do not merely bump the number.

**Verify**: tests distinguish legacy normalization (`balanced`) from new app default (`ondemand`).

### Step 2: Add CLI and wizard selection

Add `app create --fpm-profile {ondemand,balanced,throughput}` with omitted behavior:

- existing app: preserve recorded profile;
- new app: stack default.

Show profile in `app list`, `app show` already exposes state, wizard plan preview, and status. A profile change is an intentional pool configuration update and follows Plan 005 apply/reload safety.

Do not expose individual raw numeric flags in this plan; named profiles keep support/testing bounded. Local operators needing new values can propose an upstream profile or future ignored profile catalog.

**Verify**: parser and handler tests cover omitted/new/existing/invalid/changed profile cases.

### Step 3: Render mode-correct pool configuration

Update `pool.conf.template` and render values. Output:

For ondemand:

```ini
pm = ondemand
pm.max_children = <bounded value>
pm.process_idle_timeout = <value>s
pm.max_requests = <value>
```

For dynamic:

```ini
pm = dynamic
pm.max_children = ...
pm.start_servers = ...
pm.min_spare_servers = ...
pm.max_spare_servers = ...
pm.max_requests = ...
```

Never emit `pm.start_servers`/spare directives for ondemand. Add comments naming the generated profile. Preserve socket, timeout, log, open_basedir, clear_env, and worker-output directives unchanged.

**Verify**: golden/structural tests render every profile and assert required/forbidden directives.

### Step 4: Reconcile the global process cap

Calculate and document that per-pool limits are additionally bounded by global `process.max`. Make `process.max` configurable at image build or runtime only if PHP-FPM supports a safe generated global config path without editing the image per operator.

Preferred bounded approach: add an environment/build argument such as `PHP_FPM_PROCESS_MAX` with a conservative default of 32 and validate it before writing global config. If runtime configurability complicates immutable image behavior, retain 32 and document aggregate sizing; do not remove the cap.

Add status output that warns when the sum of configured profile `max_children` for apps on one version is greater than global process max. This is capacity information, not a claim that all workers allocate simultaneously.

**Verify**: status test produces a warning for an overcommitted synthetic state and no warning below the cap.

### Step 5: Add tests and docs

Tests must cover:

- every profile's exact directives;
- no dynamic-only directives in ondemand;
- legacy/new default distinction;
- profile preservation on app update;
- invalid env/state profile failure;
- status aggregate warning;
- transactional render rollback on malformed profile through Plan 005.

Docs must explain latency/memory trade-offs and provide selection examples. Do not give universal RAM numbers without measurement; recommend observing worker RSS and workload latency.

**Verify**: focused tests, `make check`, and available `php-fpm -tt` pass.

## Test plan

Use temporary render roots from Plan 005. Model parser/handler tests after Plan 002. If Docker CI can cheaply validate generated pool syntax for PHP 8.4 and 8.5, add it to the existing smoke job rather than creating a separate workflow.

## Done criteria

- [ ] New apps default to validated `ondemand` unless configured otherwise.
- [ ] Existing apps without metadata preserve current dynamic behavior as `balanced`.
- [ ] Pool output is syntactically mode-correct.
- [ ] App create, wizard, list/status expose profile clearly.
- [ ] Aggregate capacity warning exists.
- [ ] No raw arbitrary FPM directive injection is introduced.
- [ ] Focused tests, `make check`, and available Docker FPM validation pass.
- [ ] Plan 009 is marked DONE.

## STOP conditions

- PHP 8.4 and 8.5 require materially different pool directives for these profiles.
- Existing state cannot distinguish a legacy app from a newly created app safely.
- Changing global process max requires rebuilding unrelated services or removing a safety cap.
- Measured/production requirements demand arbitrary per-app numeric tuning rather than bounded profiles; report a profile-catalog design.

## Maintenance notes

Keep profile definitions centralized and test every profile against all shipped PHP versions. A future local profile catalog should be an ignored validated data file, not arbitrary template fragments. Reviewers should examine cold-start latency before changing the default idle timeout.
