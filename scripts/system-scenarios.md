# System-level acceptance scenarios (Phase F3)

Contract §8 lists fourteen end-to-end scenarios that must pass on a disposable
Linux host before declaring the reimplementation complete. Automated coverage
lives in `tests/unit`, `tests/contract`, and `tests/integration`. This document
tracks **host-level** runs (manual or CI-on-metal).

## How to run

```bash
# Control-plane gates (always)
deno task fmt:check && deno task lint && deno task check
deno task test
deno task test:integration   # soft-skips when Docker unavailable
deno task test:parity        # compile + F-29/F-30

# Real live data-plane harness (Docker required)
# Creates ./testbento by default, brings compose up, creates an app with DB,
# checks PHP version + MySQL + Redis connectivity. TLS ACME issuance is skipped.
deno task test:stack
# or:
deno task run --test-stack              # default name: testbento
deno task run test-stack mylab --keep   # leave stack running
deno task run --test-stack=lab --skip-build --skip-http

# Optional manual live data-plane
export BENTO_STACK_ROOT=/var/lib/bento-scenario
deno task run --stack "$BENTO_STACK_ROOT" init
deno task run --stack "$BENTO_STACK_ROOT" render
# then compose up via bento compose -- up -d  (operator path; no -A)
```

Pin **Deno 2.9.x** (see `src/version.ts` `DENO_TARGET_VERSION` and README).

## Scenario checklist

| #  | Scenario                                                       | Automated proxy                                                              | Host run |
| -- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| 1  | Bootstrap; recreate containers without losing Redis/MySQL data | F2 bootstrap + compose config; durable volumes are named (compose templates) | [ ]      |
| 2  | Two apps same PHP version; isolation proof                     | F2 two-apps isolation; unit F-02                                             | [ ]      |
| 3  | Second PHP version; migrate one app end-to-end                 | F2 PHP add/move; unit F-06/F-07                                              | [ ]      |
| 4  | Front-controller + legacy + reverse-proxy sites                | F2 routing + proxy; unit E2/F-04                                             | [ ]      |
| 5  | Boot TLS → real cert mode without disturbing PHP/workers       | F2 TLS external; unit E1; nginx-only plan                                    | [ ]      |
| 6  | DBs for two apps; refuse cross-MySQL; rotate one password      | F2 MySQL isolation; unit F1 rotate; Phase A live grants                      | [ ]      |
| 7  | Redis shared + ACL cross-app denial                            | F2 redis materialize; unit F-11 ACL rules                                    | [ ]      |
| 8  | Schedules with locks/timeouts; independent worker restart      | F2 cron/worker; unit Phase B worker control                                  | [ ]      |
| 9  | Deploy valid/invalid/burst/FIFO/skip/fail/timeout; OPcache     | unit deploy_test + F1 prune/interrupt; F2 deploy surface                     | [ ]      |
| 10 | Inject render/promote/validate/reload/dump/restore failures    | Phase C unit R-01–R-10; F2 validation rollback                               | [ ]      |
| 11 | Access logs enable/rotate/report without runtime reload        | F2 access logs; unit Phase B                                                 | [ ]      |
| 12 | Custom vhost/pool; upstream drift; return to upstream          | F2 template; unit Phase B                                                    | [ ]      |
| 13 | Source + compiled amd64/arm64 parity smoke                     | `test:parity` + CI compile:amd64/arm64                                       | [ ]      |
| 14 | Corrupt each external boundary; reject before side effects     | F2 corrupt boundaries; unit F-31 validators                                  | [ ]      |

Mark host-run boxes when executed on a disposable Linux host with Docker.
Record date/operator in `specs/todo.md` progress log.

## Residual host-only items

- Live MySQL grants and Redis ACL `ACL SETUSER` against real containers
- GoAccess report image pull
- ACME issuance against public DNS
- Multi-process file-lock stress across two OS processes
- Cross-arch binary **execution** (CI produces artifacts; run on matching arch)
