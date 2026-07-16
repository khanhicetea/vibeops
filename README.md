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

- Deno **2.9.x** (development / source mode)
- Linux with Docker Engine + Docker Compose v2 (data plane)
- No Python, Node.js, or `npm install` required to run the control plane

## Quick start (source mode)

```bash
# pin/check runtime
deno --version

# format, lint, typecheck, test
deno task fmt
deno task lint
deno task check
deno task test

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

## Compile

```bash
mkdir -p dist
deno task compile          # native
deno task compile:amd64    # Linux x86_64
deno task compile:arm64    # Linux aarch64
```

The compiled `bento` executable needs no Deno/Python/Node on the target host. Pass an explicit stack root:

```bash
./dist/bento --stack /var/lib/bento status
```

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
| Bootstrap | `init`, `render`, `apply`, `status` |
| Apps | `app create\|list\|show` |
| PHP | `php add\|remove\|list` |
| MySQL | `mysql add\|list\|db\|password` (version removal blocked) |
| Proxy | `proxy create\|list` |
| TLS | `tls set --app\|--proxy --mode boot\|acme\|external` |
| Background | `cron …`, `worker …` |
| Deploy | `deploy enable\|disable\|rotate\|status\|drain\|instructions` |
| Exec | `exec <app> -- <cmd>` |
| Compose | `compose -- <args>` (refuses `down -v`) |
| Safety | `permissions check\|repair`, `backup`, `restore` |

Global flags: `--stack PATH` (or `BENTO_STACK_ROOT`), `--json`.

## Specs and acceptance

Product, architecture, and reimplementation contract live in:

1. [`specs/01-product-spec.md`](specs/01-product-spec.md)
2. [`specs/02-system-architecture.md`](specs/02-system-architecture.md)
3. [`specs/03-reimplementation-contract.md`](specs/03-reimplementation-contract.md)

Unit and contract tests cover state validation, domain uniqueness, render rollback, compose safety, deploy HMAC/queue policies, and CLI smoke flows.

## Project layout

```text
src/
  main.ts                 # entrypoint
  domain/                 # branded types, state model, errors, reload plans
  schemas/                # runtime validation + migrations boundary
  platform/               # Deno adapters (fs, lock, process, assets, paths)
  services/               # app, php, mysql, render, deploy, …
  commands/               # CLI router
  ui/                     # operator output helpers
templates/                # immutable nginx/php/helpers assets
tests/                    # unit + contract suites
specs/                    # product specifications
```

## Security notes

- Only Nginx is public in the base topology.
- Database and webhook secrets are not printed in ordinary status output.
- MySQL passwords are not passed on host process argv for admin SQL.
- Deploy HMAC secrets live in desired state / FastCGI params, not app-writable secret files.
- Deno permissions are explicit in `deno.json` tasks (not `-A` by default).

## License

Operator-owned deployments: you own the server, state, app files, volumes, certificates, and backups.
