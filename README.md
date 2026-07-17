# Bento

Bento is a self-hosted operations layer for running multiple isolated PHP applications and reverse-proxied services on one Linux server using Docker Compose.

This repository is a **Deno 2.9 / TypeScript** reimplementation of the Bento host control plane. It preserves the product model described in [`specs/`](specs/):

- one operator-owned Linux host
- host-network Nginx as the only public service
- per-app Linux identity, home, PHP-FPM pool, and Unix socket
- version-shared PHP FPM / singleton runner / ephemeral CLI roles
- private MySQL (per managed version) and Redis
- desired-state rendering with staged, validated, recoverable apply
- schedules, workers, webhook deploys, backups, and diagnostics

## Requirements

- Deno **2.9.3** (pinned 2.9.x line — see `src/version.ts` `DENO_TARGET_VERSION` and release notes)
- Linux with Docker Engine + Docker Compose v2 (data plane)
- No Python, Node.js, or `npm install` required to run the control plane (JSR/npm packages resolve through Deno + `deno.lock`)

Install or switch the runtime with the official installer / package pin, for example:

```bash
curl -fsSL https://deno.land/install.sh | sh -s v2.9.3
deno --version   # should report 2.9.3
```

## Quick start (source mode)

```bash
# pin/check runtime
deno --version   # expect 2.9.x (CI uses 2.9.3)

# format, lint, typecheck, test
deno task fmt
deno task lint
deno task check
deno task test
deno task test:integration   # soft-skips Docker-only steps when daemon is down

# initialize a stack root and render
deno task run --stack ./my-stack init
deno task run --stack ./my-stack render
deno task run --stack ./my-stack status

# create an application
deno task run --stack ./my-stack app create demo \
  --domain demo.example.test \
  --docroot public \
  --db

# apply (validate + scoped reload when services are up)
deno task run --stack ./my-stack apply
```

Stack roots are **external** mutable state (desired state, homes, certs, backups, generated output). Immutable templates ship with the repository or compiled binary.

## Compile and distribution parity

```bash
mkdir -p dist
deno task compile          # native host arch
deno task compile:amd64    # Linux x86_64 (release)
deno task compile:arm64    # Linux aarch64 (release)
```

The compiled `bento` executable needs no Deno/Python/Node on the target host. Immutable templates are embedded with `--include=templates` and materialize into a digest-addressed cache under the stack root (`.asset-cache/<digest>/`) before publishing stable Compose paths (`docker/`, `helpers/`). Mutable operator state always lives under an explicit external stack root — never next to the binary.

```bash
./dist/bento --stack /var/lib/bento init
./dist/bento --stack /var/lib/bento render
./dist/bento --stack /var/lib/bento status
./dist/bento version   # reports bento version + pinned Deno target (2.9.x)
```

### Parity smoke (F-29 / F-30)

Source mode and the compiled binary must produce byte-equivalent generated files, equal state transitions/exit codes, and equivalent normalized diagnostics for identical inputs:

```bash
deno task test:parity      # compile + require binary parity suite
# or, with an existing binary:
BENTO_BIN=$PWD/dist/bento deno task test
```

Release CI (`.github/workflows/ci.yml`) runs:

1. `fmt:check`, `lint`, `check`
2. `deno install --frozen=true` (fail on lockfile / resolution drift)
3. `deno task test` (unit + contract)
4. `deno task test:integration` (soft-skips when Docker unavailable)
5. `compile` + binary smoke (`init`/`render`/`status`) + `test:parity`
6. `compile:amd64` and `compile:arm64` artifacts

Pin Deno **2.9.3** for source and compile. Documented operator paths use the explicit permission set in `deno.json` tasks (`--allow-read --allow-write --allow-env --allow-run --allow-net --allow-sys`). **Do not use unrestricted `-A` as the supported default.**

Host-level system scenarios (contract §8 fourteen scenarios) are tracked in [`scripts/system-scenarios.md`](scripts/system-scenarios.md).

## Architecture (short)

```text
Operator CLI (Deno/TS)
   -> desired state (state.json)
   -> complete candidate generation
   -> lock / stage / promote / validate / reload

Internet -> host-network Nginx -> per-app PHP-FPM sockets
                                 -> private MySQL / Redis

PHP runner (one per version) -> per-app supercronic + flat Supervisor workers
```

Apps share containers by PHP version and isolate through UID/GID, pools, filesystem policy, DB grants, and optional Redis ACL — not one container per app.

## Command surface

| Area | Commands |
|------|----------|
| Interactive | `tui` (wizard: menus, tables, alerts for common ops) |
| Bootstrap | `init`, `render`, `apply`, `status` |
| Apps | `app create\|list\|show` |
| PHP | `php add\|remove\|list` |
| MySQL | `mysql add\|list\|db\|password` (version removal blocked) |
| Proxy | `proxy create\|list` |
| TLS | `tls set --app\|--proxy --mode boot\|acme\|external` (see TLS notes below) |
| Background | `cron …`, `worker …` |
| Deploy | `deploy enable\|disable\|rotate\|status\|drain\|instructions` |
| Exec | `exec <app> -- <cmd>` |
| Compose | `compose files`, `compose -- <args>` (refuses `down -v`) |
| Safety | `permissions check\|repair [--shallow\|--recursive] [--dry-run]`, `backup`, `restore` |

### TLS modes (F-12)

| Mode | Behavior |
|------|----------|
| `boot` | Self-signed starter cert under `certs/boot.{crt,key}` (created on materialize / nginx entrypoint). **No** HTTP→HTTPS redirect. |
| `acme` | Real certs expected at `certs/acme/<domain>/{fullchain,privkey}.pem`. HTTP-01 webroot is `certs/acme-www` (container `/var/www/acme`). Generated vhosts expose `/.well-known/acme-challenge/` and enable HTTPS redirect. **DNS A/AAAA for the site must point at this host before issuance.** Example: `certbot certonly --webroot -w ./certs/acme-www -d example.com`. |
| `external` | Operator-managed cert+key under stack `certs/` (paths validated; private key must not be world-readable, mode `0600`). HTTPS redirect on. |

TLS changes reload **Nginx only** (PHP/runners stay up).

### Permissions (product §6.9)

- `permissions check <app>` — policy issues without changes
- `permissions repair <app> --dry-run` — print planned fixes
- `permissions repair <app>` / `--shallow` — fix core dirs only (default repair path)
- `permissions repair <app> --recursive` — bounded walk; **never follows symlink targets**
- App create may apply recursive policy while the home tree is still small; routine startup/apply paths use shallow repairs only.

Global flags: `--stack PATH` (or `BENTO_STACK_ROOT`), `--json`. Command parsing and help use **yargs**; table layout uses **cliui**; colorized operator output uses **picocolors**. Desired-state and CLI input validation use **zod**; cron schedules use **cron-parser**; PHP/MySQL version ordering uses **semver**; config templates use **mustache**. Standard library helpers come from official `@std/*` packages (path, yaml, encoding, assert).

## Specs and acceptance

Product, architecture, and reimplementation contract live in:

1. [`specs/01-product-spec.md`](specs/01-product-spec.md)
2. [`specs/02-system-architecture.md`](specs/02-system-architecture.md)
3. [`specs/03-reimplementation-contract.md`](specs/03-reimplementation-contract.md)

Unit, contract, and integration tests cover state validation, domain uniqueness, render rollback, compose safety, deploy HMAC/queue policies, CLI smoke flows, multi-app isolation, TLS/routing modes, and corrupt-boundary rejection (Phase F acceptance matrix).

## Project layout

```text
src/
  main.ts                 # entrypoint
  domain/                 # branded types, state model, errors, reload plans
  schemas/                # runtime validation + migrations boundary
  platform/               # Deno adapters (fs, lock, process, assets, paths)
  services/               # app, php, mysql, render, deploy, …
  commands/               # CLI router
  ui/                     # operator output + interactive TUI helpers
templates/                # immutable nginx/php/helpers assets
tests/
  unit/                   # domain + render + deploy unit suites
  contract/               # CLI smoke + source/binary parity
  integration/            # stack bootstrap / multi-app / boundary suite
scripts/system-scenarios.md  # contract §8 host checklist
specs/                    # product specifications
.github/workflows/ci.yml  # release gates
```

## Security notes

- Only Nginx is public in the base topology.
- Database and webhook secrets are not printed in ordinary status output.
- MySQL passwords are not passed on host process argv for admin SQL.
- Deploy HMAC secrets live in desired state / FastCGI params, not app-writable secret files.
- Deno permissions are explicit in `deno.json` tasks (not `-A` by default).

## License

Operator-owned deployments: you own the server, state, app files, volumes, certificates, and backups.
