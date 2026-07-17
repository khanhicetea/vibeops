/**
 * CLI command router backed by yargs + cliui.
 * Scriptable operations; interactive wizard via `bento tui`.
 */

import yargs from "yargs";
import type { Argv } from "yargs";
import { isBentoError } from "../domain/errors.ts";
import { BENTO_VERSION, DENO_TARGET_VERSION, versionBanner } from "../version.ts";
import { describeReloadPlan } from "../domain/reload.ts";
import { type CliContext, contextFromArgv, defaultStackRoot } from "./context.ts";
import {
  applyAppDataPlane,
  capacityWarnings,
  deleteApp,
  materializeAppHome,
  provisionApp,
} from "../services/app.ts";
import {
  addPhpVersion,
  buildCliExec,
  cliRunComposeCommand,
  listPhpVersions,
  removePhpVersion,
} from "../services/php.ts";
import {
  addMysqlVersion,
  assertShellPlanSecretsOffArgv,
  buildMysqlShellPlan,
  createAppDatabaseLive,
  listMysqlVersions,
  queryDatabaseSizes,
  queryProcesslist,
  removeMysqlVersion,
  resolveMysqlServices,
  runBackup,
  runRestore,
} from "../services/mysql.ts";
import { loadRedisPassword, requireMysqlRootPassword } from "../services/stack_env.ts";
import { createProxy, deleteProxy } from "../services/proxy.ts";
import {
  deployWebhookInstructions,
  disableDeploy,
  drainDeploy,
  enableDeploy,
  loadQueue,
  rotateDeploySecret,
} from "../services/deploy.ts";
import { addCronJob, listCronJobs, removeCronJob } from "../services/cron.ts";
import {
  addWorker,
  buildWorkerControlPlan,
  controlWorker,
  inspectWorker,
  listWorkers,
  removeWorker,
  type WorkerControlAction,
} from "../services/worker.ts";
import {
  generateAccessReport,
  isNginxOnlyReloadPlan,
  rotateAccessLog,
  setAppAccessLog,
} from "../services/access_log.ts";
import {
  detectTemplateDrift,
  formatDriftWarnings,
  returnToUpstreamTemplate,
  selectCustomTemplate,
} from "../services/customization.ts";
import { registerHostMaintenance, runStackMaintenance } from "../services/maintenance.ts";
import { buildStatus, formatStatus, statusToJson } from "../services/status.ts";
import { checkPermissions, formatPermReport, repairPermissions } from "../services/permissions.ts";
import { assertSafeComposeArgs, composeArgs, resolveComposeFiles } from "../services/compose.ts";
import { ensureAcmeWebroot, tlsOperatorDocs, validateExternalTlsPaths } from "../services/tls.ts";
import {
  DEFAULT_SCHEDULE_WAIT_SEC,
  DEFAULT_TEST_STACK_NAME,
  formatTestStackReport,
  resolveTestStackOptions,
  runTestStack,
} from "../services/test_stack.ts";
import { printTable, redact } from "../ui/output.ts";
import type { TlsMode } from "../domain/state.ts";
import type { ArgsWith, CliArgs } from "./args.ts";
import { runWizard } from "./wizard.ts";

type RunState = { code: number };

type YargsBuilder = Argv<CliArgs>;

class EarlyExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "EarlyExit";
  }
}

function wantsNoApply(argv: CliArgs): boolean {
  return argv.noApply === true;
}

function noApplyOption<T>(y: Argv<T>) {
  return y.option("no-apply", {
    type: "boolean",
    default: false,
    describe: "Mutate desired state only; skip render/apply (use `bento apply` later)",
  });
}

/** Drop command-path tokens from argv._ to recover passthrough args (after --). */
function trailing(argv: CliArgs, drop: number): string[] {
  return argv._.slice(drop).map(String);
}

function bind<A extends CliArgs>(
  state: RunState,
  handler: (argv: A, ctx: CliContext) => Promise<number>,
): (argv: A) => Promise<void> {
  return async (argv) => {
    const ctx = contextFromArgv(argv);
    try {
      state.code = await handler(argv, ctx);
    } catch (err) {
      if (err instanceof EarlyExit) {
        state.code = err.code;
        return;
      }
      if (isBentoError(err)) {
        ctx.log.error(redact(err.message));
        if (err.recovery) ctx.log.info(`recovery: ${err.recovery}`);
        state.code = err.exitCode;
        return;
      }
      ctx.log.error(redact(err instanceof Error ? err.message : String(err)));
      state.code = 1;
    }
  };
}

function printVersion(): void {
  console.log(versionBanner());
  console.log(`bento ${BENTO_VERSION}`);
  console.log(`deno-target ${DENO_TARGET_VERSION}`);
}

function withGlobals<T>(y: Argv<T>) {
  return y
    .option("stack", {
      // Note: do not alias as --root; that flag is reserved for `mysql shell --root`.
      type: "string",
      default: defaultStackRoot(),
      describe: "Stack root (mutable state); env BENTO_STACK_ROOT",
      global: true,
    })
    .option("json", {
      type: "boolean",
      default: false,
      describe: "Emit machine-readable diagnostics where supported",
      global: true,
    })
    .option("repo-root", {
      type: "string",
      describe: "Repository root override (tests / source mode)",
      global: true,
    })
    .parserConfiguration({
      "boolean-negation": false,
      "camel-case-expansion": true,
      "strip-dashed": true,
      "halt-at-non-option": false,
    });
}

function buildParser(state: RunState) {
  let parser = yargs()
    .scriptName("bento")
    .usage(
      "bento — single-server PHP application operations\n\nUsage: $0 [options] <command> [args]\n\nTip: $0 tui opens the interactive wizard.",
    )
    .strict()
    .help()
    .alias("h", "help")
    .version(false)
    .exitProcess(false)
    .recommendCommands()
    .wrap(Math.min(100, yargs().terminalWidth()))
    .epilogue("Environment:\n  BENTO_STACK_ROOT     Default stack root (mutable state)")
    .fail((msg: string | undefined, err: Error | undefined, failedYargs: Argv) => {
      if (err) throw err;
      if (msg) {
        console.error(`error: ${msg}`);
        console.error("");
        failedYargs.showHelp("error");
      }
      throw new EarlyExit(2);
    });

  parser = withGlobals(parser);

  parser = parser
    .command(
      "version",
      "Show bento and deno target versions",
      () => {},
      () => {
        printVersion();
        state.code = 0;
      },
    )
    .command(
      "tui",
      "Interactive wizard (numbered menus for common operations)",
      () => {},
      bind(state, cmdTui),
    )
    .command(
      "init",
      "Initialize empty desired state",
      (y: YargsBuilder) =>
        y.option("force", {
          type: "boolean",
          default: false,
          describe: "Overwrite existing state",
        }),
      bind(state, cmdInit),
    )
    .command(
      "render",
      "Render generated config (no reload)",
      () => {},
      bind(state, cmdRender),
    )
    .command(
      "apply",
      "Render, validate, and reload targeted services",
      (y: YargsBuilder) =>
        y
          .option("render-only", {
            type: "boolean",
            default: false,
            describe: "Write files without signaling services",
          })
          .option("skip-validate", {
            type: "boolean",
            default: false,
            describe: "Skip config validators before reload",
          })
          .option("preview", {
            type: "boolean",
            default: false,
            describe: "Show pending reload plan without applying",
          }),
      bind(state, cmdApply),
    )
    .command(
      "status",
      "Show stack/app/runtime status",
      () => {},
      bind(state, cmdStatus),
    )
    .command(
      "test-stack [name]",
      "Real Docker multi-chain harness (apps, db, domains, cron/worker, permissions; ACME skipped)",
      (y: YargsBuilder) =>
        y
          .positional("name", {
            type: "string",
            default: DEFAULT_TEST_STACK_NAME,
            describe:
              `Compose project / stack directory name (default: ${DEFAULT_TEST_STACK_NAME})`,
          })
          .option("keep", {
            type: "boolean",
            default: false,
            describe: "Leave containers running after the run",
          })
          .option("skip-build", {
            type: "boolean",
            default: false,
            describe: "Skip docker compose build (reuse existing images)",
          })
          .option("skip-http", {
            type: "boolean",
            default: false,
            describe: "Skip host-network nginx HTTP probe",
          })
          .option("timeout-sec", {
            type: "number",
            default: 180,
            describe: "Per-service wait timeout in seconds",
          })
          .option("schedule-wait-sec", {
            type: "number",
            default: DEFAULT_SCHEDULE_WAIT_SEC,
            describe:
              `Seconds to wait for * * * * * cron + worker output (default: ${DEFAULT_SCHEDULE_WAIT_SEC})`,
          }),
      bind(state, cmdTestStack),
    )
    .command("app", "Provision and inspect applications", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List applications",
          () => {},
          bind(state, cmdAppList),
        )
        .command(
          "show <slug>",
          "Show one application (secrets redacted)",
          (y2: YargsBuilder) => y2.positional("slug", { type: "string", demandOption: true }),
          bind(state, cmdAppShow),
        )
        .command(
          "create <slug>",
          "Create or update an application",
          (y2: YargsBuilder) =>
            y2
              .positional("slug", { type: "string", demandOption: true })
              .option("domain", {
                type: "string",
                demandOption: true,
                describe: "Primary domain",
              })
              .option("alias", {
                type: "string",
                describe: "Comma-separated domain aliases",
              })
              .option("docroot", {
                type: "string",
                describe: "Document root relative to app home",
              })
              .option("php", { type: "string", describe: "PHP version" })
              .option("fpm", { type: "string", describe: "FPM capacity profile" })
              .option("mysql", { type: "string", describe: "MySQL version/service" })
              .option("database", { type: "string", describe: "Initial database name" })
              .option("db", {
                type: "boolean",
                default: false,
                describe: "Create a database for the app",
              })
              .option("legacy", {
                type: "boolean",
                default: false,
                describe: "Allow direct PHP file execution",
              })
              .option("front", {
                type: "boolean",
                default: false,
                describe: "Force front-controller routing",
              })
              .option("access-log", {
                type: "boolean",
                default: false,
                describe: "Enable per-app access logs",
              })
              .option("no-apply", {
                type: "boolean",
                default: false,
                describe: "Skip render/apply after state mutation",
              })
              .option("skip-validate", {
                type: "boolean",
                default: false,
                describe: "Skip validators when applying",
              }),
          bind(state, cmdAppCreate),
        )
        .command(
          "update <slug>",
          "Update an application (same options as create)",
          (y2: YargsBuilder) =>
            y2
              .positional("slug", { type: "string", demandOption: true })
              .option("domain", { type: "string", demandOption: true })
              .option("alias", { type: "string" })
              .option("docroot", { type: "string" })
              .option("php", { type: "string" })
              .option("fpm", { type: "string" })
              .option("mysql", { type: "string" })
              .option("database", { type: "string" })
              .option("db", { type: "boolean", default: false })
              .option("legacy", { type: "boolean", default: false })
              .option("front", { type: "boolean", default: false })
              .option("access-log", { type: "boolean", default: false })
              .option("no-apply", { type: "boolean", default: false })
              .option("skip-validate", { type: "boolean", default: false }),
          bind(state, cmdAppCreate),
        )
        .command(
          "delete <slug>",
          "Blocked: automatic app teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("slug", { type: "string", demandOption: true }),
          bind(state, cmdAppDelete),
        )
        .command(
          "remove <slug>",
          "Blocked: automatic app teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("slug", { type: "string", demandOption: true }),
          bind(state, cmdAppDelete),
        )
        .command(
          "shell <slug>",
          "Attach interactive app CLI shell (ephemeral PHP identity)",
          (y2: YargsBuilder) =>
            y2
              .positional("slug", { type: "string", demandOption: true })
              .option("workdir", {
                type: "string",
                describe: "Working directory inside app home",
              })
              .option("php", {
                type: "string",
                describe: "Managed PHP version override",
              })
              .option("print", {
                type: "boolean",
                default: false,
                describe: "Print compose argv instead of attaching",
              }),
          bind(state, cmdAppShell),
        )
        .demandCommand(1, "Specify an app subcommand: create|list|show|update|shell")
        .recommendCommands())
    .command("php", "Manage PHP versions", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List PHP versions",
          () => {},
          bind(state, cmdPhpList),
        )
        .command(
          "add <version>",
          "Add a PHP version (fpm+runner+cli)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("version", { type: "string", demandOption: true }),
            ),
          bind(state, cmdPhpAdd),
        )
        .command(
          "remove <version>",
          "Remove an unused non-default PHP version",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("version", { type: "string", demandOption: true }),
            ),
          bind(state, cmdPhpRemove),
        )
        .demandCommand(1, "Specify a php subcommand: add|remove|list")
        .recommendCommands())
    .command("mysql", "Manage MySQL (add-only versions)", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List MySQL versions",
          () => {},
          bind(state, cmdMysqlList),
        )
        .command(
          "add <version>",
          "Add a MySQL version service",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("version", { type: "string", demandOption: true }),
            ),
          bind(state, cmdMysqlAdd),
        )
        .command(
          "remove <version>",
          "Blocked: MySQL version removal is unavailable",
          (y2: YargsBuilder) => y2.positional("version", { type: "string", demandOption: true }),
          bind(state, cmdMysqlRemove),
        )
        .command(
          "db <app> <database>",
          "Record a namespaced database for an app",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("database", { type: "string", demandOption: true }),
          bind(state, cmdMysqlDb),
        )
        .command(
          "shell",
          "Open MySQL shell (protected option file; never host argv)",
          (y2: YargsBuilder) =>
            y2
              .option("root", {
                type: "boolean",
                default: false,
                describe: "Connect as MySQL root",
              })
              .option("app", {
                type: "string",
                describe: "Connect as app MySQL user",
              })
              .option("service", {
                type: "string",
                describe: "MySQL service/version (root mode)",
              })
              .option("database", {
                type: "string",
                describe: "Default database",
              })
              .option("print", {
                type: "boolean",
                default: false,
                describe: "Print planned argv (secrets redacted) instead of opening",
              }),
          bind(state, cmdMysqlShell),
        )
        .command(
          "size",
          "Show database sizes (no secrets)",
          (y2: YargsBuilder) =>
            y2
              .option("app", { type: "string", describe: "Limit to one app's databases" })
              .option("service", {
                type: "string",
                describe: "MySQL service/version",
              }),
          bind(state, cmdMysqlSize),
        )
        .command(
          "processlist",
          "Show active MySQL processes (no secrets)",
          (y2: YargsBuilder) =>
            y2.option("service", {
              type: "string",
              describe: "MySQL service/version",
            }).option("app", {
              type: "string",
              describe: "Resolve service from app",
            }),
          bind(state, cmdMysqlProcesslist),
        )
        .demandCommand(1, "Specify a mysql subcommand: add|list|db|shell|size|processlist")
        .recommendCommands())
    .command("proxy", "Reverse-proxy sites", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List reverse proxies",
          () => {},
          bind(state, cmdProxyList),
        )
        .command(
          "create <name>",
          "Create a reverse-proxy site",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("name", { type: "string", demandOption: true })
                .option("domain", {
                  type: "string",
                  demandOption: true,
                  describe: "Primary domain",
                })
                .option("upstream", {
                  type: "string",
                  demandOption: true,
                  describe: "Upstream URL (e.g. http://127.0.0.1:3000)",
                })
                .option("alias", {
                  type: "string",
                  describe: "Comma-separated domain aliases",
                }),
            ),
          bind(state, cmdProxyCreate),
        )
        .command(
          "delete <name>",
          "Blocked: automatic proxy teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("name", { type: "string", demandOption: true }),
          bind(state, cmdProxyDelete),
        )
        .command(
          "remove <name>",
          "Blocked: automatic proxy teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("name", { type: "string", demandOption: true }),
          bind(state, cmdProxyDelete),
        )
        .demandCommand(1, "Specify a proxy subcommand: create|list")
        .recommendCommands())
    .command("deploy", "Webhook deploys for an app", (y: YargsBuilder) =>
      y
        .command(
          "enable <app>",
          "Enable webhook deploy for an app",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("app", { type: "string", demandOption: true })
                .option("fifo", {
                  type: "boolean",
                  default: false,
                  describe: "Use FIFO queue policy (default: latest)",
                }),
            ),
          bind(state, cmdDeployEnable),
        )
        .command(
          "disable <app>",
          "Disable webhook deploy",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("app", { type: "string", demandOption: true }),
            ),
          bind(state, cmdDeployDisable),
        )
        .command(
          "rotate <app>",
          "Rotate deploy HMAC secret (printed once)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("app", { type: "string", demandOption: true }),
            ),
          bind(state, cmdDeployRotate),
        )
        .command(
          "status <app>",
          "Show deploy queue status",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployStatus),
        )
        .command(
          "history <app>",
          "Show deploy history (alias of status)",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployStatus),
        )
        .command(
          "drain <app>",
          "Drain one queued deploy job",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployDrain),
        )
        .command(
          "instructions <app>",
          "Print webhook instructions",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployInstructions),
        )
        .demandCommand(
          1,
          "Specify a deploy subcommand: enable|disable|rotate|status|drain|instructions",
        )
        .recommendCommands())
    .command("cron", "Scheduled jobs", (y: YargsBuilder) =>
      y
        .command(
          "list [app]",
          "List cron jobs",
          (y2: YargsBuilder) => y2.positional("app", { type: "string" }),
          bind(state, cmdCronList),
        )
        .command(
          "add",
          "Add a cron job (command after --)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("name", { type: "string", demandOption: true })
                .option("schedule", {
                  type: "string",
                  demandOption: true,
                  describe: "Cron expression",
                })
                .option("timezone", { type: "string" })
                .option("lock", { type: "string" })
                .option("timeout", { type: "number", describe: "Timeout seconds" })
                .option("cmd", {
                  type: "string",
                  describe: "Shell command string (supports redirects and pipelines)",
                }),
            ),
          bind(state, cmdCronAdd),
        )
        .command(
          "remove <app> <name>",
          "Remove a cron job",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("app", { type: "string", demandOption: true })
                .positional("name", { type: "string", demandOption: true }),
            ),
          bind(state, cmdCronRemove),
        )
        .demandCommand(1, "Specify a cron subcommand: add|remove|list")
        .recommendCommands())
    .command("worker", "Long-running workers", (y: YargsBuilder) =>
      y
        .command(
          "list [app]",
          "List workers",
          (y2: YargsBuilder) => y2.positional("app", { type: "string" }),
          bind(state, cmdWorkerList),
        )
        .command(
          "add",
          "Add a worker (command after --)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("name", { type: "string", demandOption: true })
                .option("cmd", {
                  type: "string",
                  describe: "Command string (prefer -- argv form)",
                }),
            ),
          bind(state, cmdWorkerAdd),
        )
        .command(
          "remove <app> <name>",
          "Remove a worker",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("app", { type: "string", demandOption: true })
                .positional("name", { type: "string", demandOption: true }),
            ),
          bind(state, cmdWorkerRemove),
        )
        .command(
          "start <app> <name>",
          "Start one worker (scoped supervisorctl)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerStart),
        )
        .command(
          "stop <app> <name>",
          "Stop one worker (scoped supervisorctl)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerStop),
        )
        .command(
          "restart <app> <name>",
          "Restart one worker (scoped supervisorctl)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerRestart),
        )
        .command(
          "inspect <app> <name>",
          "Inspect one worker (supervisor status)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerInspect),
        )
        .demandCommand(
          1,
          "Specify a worker subcommand: add|remove|list|start|stop|restart|inspect",
        )
        .recommendCommands())
    .command(
      "exec <app>",
      "Ephemeral CLI as app identity (shell when no command; args after --)",
      (y: YargsBuilder) =>
        y
          .positional("app", { type: "string", demandOption: true })
          .option("workdir", {
            type: "string",
            describe: "Working directory inside app home",
          })
          .option("php", {
            type: "string",
            describe: "Managed PHP version override",
          })
          .option("print", {
            type: "boolean",
            default: false,
            describe: "Print compose argv instead of running",
          }),
      bind(state, cmdExec),
    )
    .command(
      "compose",
      "Safe docker compose wrapper (args after --)",
      (y: YargsBuilder) =>
        y
          .command(
            "files",
            "List merged Compose files in deterministic order",
            (y2: YargsBuilder) => y2,
            bind(state, cmdComposeFiles),
          )
          .option("print", {
            type: "boolean",
            default: false,
            describe: "Print full docker compose argv",
          }),
      bind(state, cmdCompose),
    )
    .command("permissions", "Filesystem permission check/repair", (y: YargsBuilder) =>
      y
        .command(
          "check <app>",
          "Check permission policy",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .option("recursive", { type: "boolean", default: false }),
          bind(state, cmdPermissionsCheck),
        )
        .command(
          "repair <app>",
          "Repair permission policy",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .option("recursive", { type: "boolean", default: false })
              .option("shallow", { type: "boolean", default: false })
              .option("dry-run", { type: "boolean", default: false }),
          bind(state, cmdPermissionsRepair),
        )
        .demandCommand(1, "Specify a permissions subcommand: check|repair")
        .recommendCommands())
    .command(
      "backup",
      "Logical MySQL backup",
      (y: YargsBuilder) =>
        y
          .option("app", { type: "string", describe: "App slug" })
          .option("database", { type: "string", describe: "Single database" })
          .option("all", {
            type: "boolean",
            default: false,
            describe: "Backup all managed databases",
          })
          .option("gzip", { type: "boolean", default: false, describe: "gzip compress" })
          .option("none", {
            type: "boolean",
            default: false,
            describe: "No compression",
          }),
      bind(state, cmdBackup),
    )
    .command(
      "restore",
      "Logical MySQL restore",
      (y: YargsBuilder) =>
        y
          .option("file", { type: "string", demandOption: true, describe: "Dump path" })
          .option("app", { type: "string", demandOption: true })
          .option("target", {
            type: "string",
            demandOption: true,
            describe: "Target database name",
            alias: "database",
          })
          .option("replace", {
            type: "string",
            describe: "Exact target name confirmation for replacement",
          }),
      bind(state, cmdRestore),
    )
    .command("tls", "TLS mode management", (y: YargsBuilder) =>
      y
        .command(
          "set",
          "Set TLS mode for app or proxy",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", describe: "App slug" })
                .option("proxy", { type: "string", describe: "Proxy name" })
                .option("mode", {
                  type: "string",
                  demandOption: true,
                  choices: ["boot", "acme", "external"] as const,
                })
                .option("email", { type: "string", describe: "ACME contact email" })
                .option("cert", { type: "string", describe: "External certificate path" })
                .option("key", { type: "string", describe: "External private key path" }),
            ),
          bind(state, cmdTlsSet),
        )
        .demandCommand(1, "Specify a tls subcommand: set")
        .recommendCommands())
    .command("logs", "Access log control and reports", (y: YargsBuilder) =>
      y
        .command(
          "access",
          "Per-app access logs (enable|disable|rotate|report)",
          (y2: YargsBuilder) =>
            y2
              .command(
                "enable",
                "Enable access logs for an app (nginx-only reload)",
                (y3: YargsBuilder) =>
                  noApplyOption(
                    y3.option("app", { type: "string", demandOption: true }),
                  ),
                bind(state, cmdLogsAccessEnable),
              )
              .command(
                "disable",
                "Disable access logs (preserves existing files)",
                (y3: YargsBuilder) =>
                  noApplyOption(
                    y3.option("app", { type: "string", demandOption: true }),
                  ),
                bind(state, cmdLogsAccessDisable),
              )
              .command(
                "rotate",
                "Rotate access log and reopen nginx (not config reload)",
                (y3: YargsBuilder) => y3.option("app", { type: "string", demandOption: true }),
                bind(state, cmdLogsAccessRotate),
              )
              .command(
                "report",
                "One-shot GoAccess HTML report",
                (y3: YargsBuilder) =>
                  y3
                    .option("app", { type: "string", demandOption: true })
                    .option("output", { type: "string", describe: "Report HTML path" })
                    .option("dry-run", {
                      type: "boolean",
                      default: false,
                      describe: "Print planned docker run argv",
                    }),
                bind(state, cmdLogsAccessReport),
              )
              .demandCommand(1, "Specify: enable|disable|rotate|report")
              .recommendCommands(),
          () => {
            /* nested */
          },
        )
        .demandCommand(1, "Specify a logs subcommand: access")
        .recommendCommands())
    .command("template", "App vhost/pool template customization", (y: YargsBuilder) =>
      y
        .command(
          "select",
          "Activate a custom vhost or pool template",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("kind", {
                  type: "string",
                  demandOption: true,
                  choices: ["vhost", "pool"] as const,
                })
                .option("source", {
                  type: "string",
                  demandOption: true,
                  describe: "Path to operator-owned template source",
                })
                .option("no-copy", {
                  type: "boolean",
                  default: false,
                  describe: "Record source path in-place (do not copy into custom/)",
                }),
            ),
          bind(state, cmdTemplateSelect),
        )
        .command(
          "return",
          "Return to upstream template (keeps custom source on disk)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("kind", {
                  type: "string",
                  demandOption: true,
                  choices: ["vhost", "pool"] as const,
                }),
            ),
          bind(state, cmdTemplateReturn),
        )
        .command(
          "drift",
          "Report upstream template drift for custom apps",
          (y2: YargsBuilder) => y2.option("app", { type: "string" }),
          bind(state, cmdTemplateDrift),
        )
        .demandCommand(1, "Specify a template subcommand: select|return|drift")
        .recommendCommands())
    .command("maintenance", "Host/stack maintenance", (y: YargsBuilder) =>
      y
        .command(
          "run",
          "On-demand log retention (in-runner logrotate is separate)",
          (y2: YargsBuilder) =>
            y2.option("retain-days", {
              type: "number",
              default: 14,
              describe: "Delete rotated logs older than N days",
            }),
          bind(state, cmdMaintenanceRun),
        )
        .command(
          "register",
          "Register host cron entry (preserves unrelated crontab lines)",
          (y2: YargsBuilder) =>
            y2
              .option("schedule", {
                type: "string",
                default: "15 3 * * *",
                describe: "Cron schedule",
              })
              .option("bin", {
                type: "string",
                describe: "bento executable path (default: bento on PATH)",
              }),
          bind(state, cmdMaintenanceRegister),
        )
        .command(
          "unregister",
          "Remove host cron entry (preserves unrelated crontab lines)",
          () => {},
          bind(state, cmdMaintenanceUnregister),
        )
        .demandCommand(1, "Specify a maintenance subcommand: run|register|unregister")
        .recommendCommands())
    .demandCommand(1, "Specify a command")
    .recommendCommands();

  return parser;
}

export async function runCli(argv: string[]): Promise<number> {
  // Preserve historical short-circuits for version / bare help / test-stack flag.
  const tokens = stripGlobalTokens(argv);
  if (tokens[0] === "version" || tokens[0] === "--version" || tokens[0] === "-V") {
    printVersion();
    return 0;
  }
  if (
    tokens.length === 0 ||
    tokens[0] === "help" ||
    tokens[0] === "--help" ||
    tokens[0] === "-h"
  ) {
    buildParser({ code: 0 }).showHelp();
    return 0;
  }

  // Global --test-stack [name] alias (default name: testbento).
  const flagIdx = argv.findIndex((a) => a === "--test-stack" || a.startsWith("--test-stack="));
  if (flagIdx >= 0) {
    const flag = argv[flagIdx]!;
    let name = DEFAULT_TEST_STACK_NAME;
    if (flag.startsWith("--test-stack=") && flag.length > "--test-stack=".length) {
      name = flag.slice("--test-stack=".length);
    } else {
      const next = argv[flagIdx + 1];
      if (next && !next.startsWith("-")) name = next;
    }
    // Re-enter as the subcommand so stack/json/repo-root flags still apply.
    const rest = argv.filter((_, i) => {
      if (i === flagIdx) return false;
      if (!flag.includes("=") && i === flagIdx + 1 && argv[i] === name) return false;
      return true;
    });
    return await runCli(["test-stack", name, ...rest]);
  }

  const state: RunState = { code: 0 };
  const parser = buildParser(state);
  try {
    await parser.parseAsync(argv);
    return state.code;
  } catch (err) {
    if (err instanceof EarlyExit) return err.code;
    if (isBentoError(err)) {
      console.error(`error: ${redact(err.message)}`);
      if (err.recovery) console.error(`recovery: ${err.recovery}`);
      return err.exitCode;
    }
    console.error(`error: ${redact(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

/** Remove known global flags so version/help short-circuits still work. */
function stripGlobalTokens(args: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--stack" || a === "--root" || a === "--repo-root") {
      i++;
      continue;
    }
    if (a.startsWith("--stack=") || a.startsWith("--root=")) continue;
    if (a === "--test-stack") {
      // Keep optional name token for the flag short-circuit above.
      rest.push(a);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        rest.push(next);
        i++;
      }
      continue;
    }
    if (a.startsWith("--test-stack=")) {
      rest.push(a);
      continue;
    }
    if (a === "--json") continue;
    rest.push(a);
  }
  return rest;
}

// --- command handlers -------------------------------------------------------

async function cmdTui(_argv: CliArgs, ctx: CliContext): Promise<number> {
  return await runWizard(ctx);
}

async function cmdInit(argv: ArgsWith<"force">, ctx: CliContext): Promise<number> {
  const { force } = argv;
  const state = await ctx.store.init(force);
  ctx.log.info(`initialized state at ${ctx.platform.paths.paths.stateFile}`);
  ctx.log.info(
    `defaults: php=${state.defaults.phpVersion} mysql=${state.defaults.mysqlVersion}`,
  );
  return 0;
}

async function cmdRender(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const result = await ctx.render.apply(state, {
    renderOnly: true,
    skipValidate: true,
  });
  ctx.log.info(
    `rendered ${result.files.length} files (render-only, no service signals)`,
  );
  if (ctx.json) {
    ctx.log.out(JSON.stringify({ files: result.managedManifest }, null, 2));
  }
  return 0;
}

async function cmdApply(
  argv: ArgsWith<"renderOnly" | "skipValidate" | "preview">,
  ctx: CliContext,
): Promise<number> {
  const { renderOnly, skipValidate, preview } = argv;
  const state = await ctx.store.load();

  // Surface template drift on apply/preview (F-24).
  const drifts = await detectTemplateDrift(ctx.platform, state);
  for (const w of formatDriftWarnings(drifts)) ctx.log.warn(w);

  if (preview) {
    const candidate = await ctx.render.renderCandidate(state);
    const plan = describeReloadPlan(candidate.reloadPlan);
    ctx.log.info(`preview: ${candidate.files.length} files; reload=${plan.join(",")}`);
    if (ctx.json) {
      ctx.log.out(JSON.stringify(
        {
          files: candidate.managedManifest,
          reloadPlan: plan,
          driftWarnings: formatDriftWarnings(drifts),
        },
        null,
        2,
      ));
    } else {
      ctx.log.out(plan.map((p) => `  - ${p}`).join("\n"));
    }
    return 0;
  }

  const result = await ctx.render.apply(state, { renderOnly, skipValidate });
  ctx.log.info(
    `applied ${result.files.length} files; reload=${
      describeReloadPlan(result.reloadPlan).join(",")
    }${renderOnly ? " (render-only)" : ""}`,
  );
  return 0;
}

async function cmdStatus(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const report = await buildStatus(ctx.platform, state);
  if (ctx.json) ctx.log.out(statusToJson(report));
  else ctx.log.out(formatStatus(report));
  return 0;
}

async function cmdTestStack(
  argv: ArgsWith<"name" | "keep" | "skipBuild" | "skipHttp" | "timeoutSec" | "scheduleWaitSec">,
  ctx: CliContext,
): Promise<number> {
  const { name } = argv;
  // Only honor --stack when the operator actually passed it (yargs always fills the default).
  const explicitStack = Deno.args.some((a) => a === "--stack" || a.startsWith("--stack="));
  const opts = resolveTestStackOptions({
    name,
    stack: explicitStack ? argv.stack : undefined,
    keep: argv.keep,
    skipBuild: argv.skipBuild,
    skipHttp: argv.skipHttp,
    timeoutSec: argv.timeoutSec,
    scheduleWaitSec: argv.scheduleWaitSec,
    repoRoot: argv.repoRoot,
    log: (level, msg) => {
      if (level === "error") ctx.log.error(msg);
      else if (level === "warn") ctx.log.warn(msg);
      else ctx.log.info(msg);
    },
  });
  ctx.log.info(
    `test-stack name=${opts.name} root=${opts.stackRoot} keep=${opts.keep} skipBuild=${opts.skipBuild} scheduleWait=${opts.scheduleWaitSec}s`,
  );
  const report = await runTestStack(opts);
  if (ctx.json) {
    ctx.log.out(JSON.stringify(report, null, 2));
  } else {
    ctx.log.out(formatTestStackReport(report));
  }
  return report.ok ? 0 : 1;
}

async function cmdAppList(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rows = Object.values(state.apps)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((a) => [
      a.slug,
      String(a.uid),
      a.mainDomain,
      a.phpVersion,
      a.fpmProfile,
      a.tls.kind,
      a.mysqlService,
    ]);
  ctx.log.out(
    printTable(
      ["slug", "uid", "domain", "php", "fpm", "tls", "mysql"],
      rows,
    ),
  );
  return 0;
}

async function cmdAppShow(argv: ArgsWith<"slug">, ctx: CliContext): Promise<number> {
  const { slug } = argv;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app) {
    ctx.log.error(`app not found: ${slug}`);
    return 3;
  }
  const safe = {
    ...app,
    mysqlPassword: "***",
    redis: {
      ...app.redis,
      password: app.redis.password ? "***" : undefined,
      aclPassword: app.redis.aclPassword ? "***" : undefined,
    },
    deploy: {
      ...app.deploy,
      hmacSecret: app.deploy.hmacSecret ? "***" : undefined,
    },
  };
  ctx.log.out(JSON.stringify(safe, null, 2));
  return 0;
}

async function cmdAppCreate(
  argv: ArgsWith<"slug" | "domain">,
  ctx: CliContext,
): Promise<number> {
  const { slug, domain } = argv;
  const aliases = argv.alias?.split(",").filter(Boolean) ?? [];
  const noApply = wantsNoApply(argv);
  const skipValidate = argv.skipValidate === true;
  const explicitDb = argv.db === true;
  const result = await ctx.store.withExclusive(async (state) => {
    const provisioned = provisionApp(ctx.platform, state, {
      slug,
      domain,
      aliases,
      documentRoot: argv.docroot,
      entrypointMode: argv.legacy === true
        ? "legacy"
        : argv.front === true
        ? "front-controller"
        : undefined,
      phpVersion: argv.php,
      fpmProfile: argv.fpm,
      mysqlVersion: argv.mysql,
      createDatabase: explicitDb,
      databaseName: argv.database,
      accessLog: argv.accessLog === true,
    });
    // Live MySQL/Redis side effects before recording state (explicit --db fails closed).
    const plane = await applyAppDataPlane(ctx.platform, provisioned.app, {
      explicitDatabase: explicitDb,
    });
    const redisShared = await loadRedisPassword(ctx.platform);
    await materializeAppHome(ctx.platform, provisioned.app, {
      recursivePerms: true,
      redisSharedPassword: redisShared,
    });
    await ctx.store.save(provisioned.state);
    if (!noApply) {
      await ctx.render.apply(provisioned.state, {
        reloadPlan: provisioned.reloadPlan,
        skipValidate,
        alreadyLocked: true,
      });
    }
    return { provisioned, plane };
  });
  ctx.log.info(
    `${
      result.provisioned.created ? "created" : "updated"
    } app ${result.provisioned.app.slug} uid=${result.provisioned.app.uid} domain=${result.provisioned.app.mainDomain}`,
  );
  for (const note of result.plane.deferredNotes) ctx.log.warn(note);
  for (const w of capacityWarnings(result.provisioned.state)) ctx.log.warn(w);
  return 0;
}

async function cmdAppDelete(argv: ArgsWith<"slug">, ctx: CliContext): Promise<number> {
  deleteApp(await ctx.store.load(), argv.slug);
  return 10;
}

async function cmdPhpList(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rows = listPhpVersions(state).map((v) => [
    v.version,
    v.service,
    `${v.service}-runner`,
    v.image,
    String(v.processCap),
  ]);
  ctx.log.out(printTable(["version", "fpm", "runner", "image", "cap"], rows));
  return 0;
}

async function cmdPhpAdd(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  const { version } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const next = addPhpVersion(state, version);
    await ctx.store.save(next);
    if (!noApply) {
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
    }
    return next;
  });
  ctx.log.info(
    noApply
      ? `added PHP ${version} (state only; run bento apply)`
      : `added PHP ${version} (fpm+runner+cli roles)`,
  );
  return 0;
}

async function cmdPhpRemove(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  const { version } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const next = removePhpVersion(state, version);
    await ctx.store.save(next);
    if (!noApply) {
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
    }
    return next;
  });
  ctx.log.info(
    noApply ? `removed PHP ${version} (state only; run bento apply)` : `removed PHP ${version}`,
  );
  return 0;
}

async function cmdMysqlList(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rows = listMysqlVersions(state).map((v) => [
    v.version,
    v.service,
    v.volume,
    v.image,
  ]);
  ctx.log.out(printTable(["version", "service", "volume", "image"], rows));
  return 0;
}

async function cmdMysqlAdd(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  const { version } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const next = addMysqlVersion(state, version);
    await ctx.store.save(next);
    if (!noApply) {
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
    }
    return next;
  });
  ctx.log.info(
    noApply ? `added MySQL ${version} (state only; run bento apply)` : `added MySQL ${version}`,
  );
  return 0;
}

async function cmdMysqlRemove(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  removeMysqlVersion(await ctx.store.load(), argv.version);
  return 10;
}

async function cmdMysqlDb(
  argv: ArgsWith<"app" | "database">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug, database: dbName } = argv;
  await ctx.store.withExclusive(async (state) => {
    const rootPassword = await requireMysqlRootPassword(ctx.platform);
    // Fail before recording when MySQL is unavailable or grants fail.
    const next = await createAppDatabaseLive(
      ctx.platform,
      state,
      slug,
      dbName,
      rootPassword,
    );
    const app = next.apps[slug]!;
    const redisShared = await loadRedisPassword(ctx.platform);
    await materializeAppHome(ctx.platform, app, {
      recursivePerms: false,
      redisSharedPassword: redisShared,
    });
    await ctx.store.save(next);
    return next;
  });
  ctx.log.info(`created database ${dbName} for app ${slug}`);
  return 0;
}

async function cmdMysqlShell(
  argv: ArgsWith<"root" | "print">,
  ctx: CliContext,
): Promise<number> {
  const asRoot = argv.root;
  const appSlug = argv.app ?? "";
  if (asRoot === Boolean(appSlug)) {
    ctx.log.error("usage: bento mysql shell --root [--service mysql84] | --app <slug>");
    return 2;
  }
  const state = await ctx.store.load();
  const database = argv.database;
  const printOnly = argv.print;

  let plan;
  if (asRoot) {
    const services = resolveMysqlServices(state, {
      service: argv.service,
    });
    const service = services[0];
    if (!service) {
      ctx.log.error("no MySQL service managed");
      return 3;
    }
    plan = buildMysqlShellPlan(ctx.platform, { kind: "root", service }, {
      database,
      interactive: !printOnly,
    });
  } else {
    const app = state.apps[appSlug];
    if (!app) {
      ctx.log.error(`app not found: ${appSlug}`);
      return 3;
    }
    plan = buildMysqlShellPlan(ctx.platform, { kind: "app", app }, {
      database,
      interactive: !printOnly,
    });
    assertShellPlanSecretsOffArgv(plan, [app.mysqlPassword]);
  }

  if (printOnly) {
    if (ctx.json) {
      ctx.log.out(JSON.stringify(
        {
          service: plan.service,
          user: plan.user,
          database: plan.database,
          stage: plan.stage?.command,
          open: plan.open.command,
          cleanup: plan.cleanup?.command,
        },
        null,
        2,
      ));
    } else {
      if (plan.stage) ctx.log.out(`stage: ${plan.stage.command.join(" ")}`);
      ctx.log.out(`open:  ${plan.open.command.join(" ")}`);
      if (plan.cleanup) ctx.log.out(`cleanup: ${plan.cleanup.command.join(" ")}`);
    }
    return 0;
  }

  // App sessions stage their option file; root uses the generated read-only file.
  if (plan.stage) {
    const staged = await ctx.platform.process.run(plan.stage.command, {
      cwd: ctx.stackRoot,
      stdin: plan.stage.stdin,
      timeoutMs: 15_000,
    });
    if (staged.code !== 0) {
      ctx.log.error(
        `failed to stage mysql option file: ${(staged.stderr || staged.stdout || "").trim()}`,
      );
      return 8;
    }
  }

  try {
    // Interactive attach — CLI layer may use Deno.Command with inherited stdio.
    const [cmd, ...args] = plan.open.command;
    const child = new Deno.Command(cmd!, {
      args,
      cwd: ctx.stackRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.output();
    return status.code;
  } finally {
    if (plan.cleanup) {
      await ctx.platform.process.run(plan.cleanup.command, {
        cwd: ctx.stackRoot,
        timeoutMs: 10_000,
      }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    }
  }
}

async function cmdMysqlSize(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rootPassword = await requireMysqlRootPassword(ctx.platform);
  const services = resolveMysqlServices(state, {
    service: argv.service,
    app: argv.app,
  });
  const allRows: Array<{ service: string; database: string; sizeMb: string; tables: string }> = [];
  for (const service of services) {
    let databases: string[] = [];
    if (argv.app) {
      const app = state.apps[argv.app];
      databases = app?.databases.map((d) => d.name) ?? [];
    }
    const { rows } = await queryDatabaseSizes(ctx.platform, service, rootPassword, databases);
    for (const r of rows) {
      allRows.push({ service, ...r });
    }
  }
  if (ctx.json) {
    ctx.log.out(JSON.stringify(allRows, null, 2));
  } else {
    ctx.log.out(
      printTable(
        ["service", "database", "size_mb", "tables"],
        allRows.map((r) => [r.service, r.database, r.sizeMb, r.tables]),
      ),
    );
  }
  return 0;
}

async function cmdMysqlProcesslist(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rootPassword = await requireMysqlRootPassword(ctx.platform);
  const services = resolveMysqlServices(state, {
    service: argv.service,
    app: argv.app,
  });
  for (const service of services) {
    const { stdout } = await queryProcesslist(ctx.platform, service, rootPassword);
    if (services.length > 1) ctx.log.out(`-- ${service} --`);
    ctx.log.out(stdout.trimEnd() || "(no processes)");
  }
  return 0;
}

async function cmdProxyList(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rows = Object.values(state.proxies).map((p) => [
    p.name,
    p.mainDomain,
    p.upstream,
    p.tls.kind,
  ]);
  ctx.log.out(printTable(["name", "domain", "upstream", "tls"], rows));
  return 0;
}

async function cmdProxyCreate(
  argv: ArgsWith<"name" | "domain" | "upstream">,
  ctx: CliContext,
): Promise<number> {
  const { name, domain, upstream } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const result = createProxy(state, {
      name,
      domain,
      upstream,
      aliases: argv.alias?.split(",") ?? [],
    }, ctx.platform.clock.nowIso());
    await ctx.store.save(result.state);
    if (!noApply) {
      await ctx.render.apply(result.state, {
        reloadPlan: result.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return result;
  });
  ctx.log.info(
    noApply ? `created proxy ${name} (state only; run bento apply)` : `created proxy ${name}`,
  );
  return 0;
}

async function cmdProxyDelete(argv: ArgsWith<"name">, ctx: CliContext): Promise<number> {
  deleteProxy(await ctx.store.load(), argv.name);
  return 10;
}

async function cmdDeployEnable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const policy = argv.fifo === true ? "fifo" as const : "latest" as const;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const enabled = enableDeploy(state, { slug, queuePolicy: policy }, ctx.platform);
    await materializeAppHome(ctx.platform, enabled.state.apps[slug]!, false);
    await ctx.store.save(enabled.state);
    if (!noApply) {
      await ctx.render.apply(enabled.state, {
        reloadPlan: enabled.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return enabled;
  });
  ctx.log.out(deployWebhookInstructions(result.state.apps[slug]!, result.secret));
  return 0;
}

async function cmdDeployDisable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = disableDeploy(state, slug, ctx.platform.clock.nowIso());
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`deploy disabled for ${slug}`);
  return 0;
}

async function cmdDeployRotate(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const r = rotateDeploySecret(state, slug, ctx.platform);
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.out(result.secret);
  ctx.log.info("rotated deploy secret (shown once above)");
  return 0;
}

async function cmdDeployStatus(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app) {
    ctx.log.error(`app not found: ${slug}`);
    return 3;
  }
  const home = ctx.platform.paths.appHome(slug);
  const queue = await loadQueue(ctx.platform, home);
  if (ctx.json) ctx.log.out(JSON.stringify(queue, null, 2));
  else {
    const rows = queue.jobs.map((j) => [
      j.id,
      j.status,
      j.receivedAt,
      j.finishedAt ?? "",
      j.error ?? "",
    ]);
    ctx.log.out(printTable(["id", "status", "received", "finished", "error"], rows));
  }
  return 0;
}

async function cmdDeployDrain(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app) return 3;
  const home = ctx.platform.paths.appHome(slug);
  const job = await drainDeploy(ctx.platform, app, home);
  if (!job) ctx.log.info("no job drained");
  else ctx.log.info(`drained ${job.id} -> ${job.status}`);
  return 0;
}

async function cmdDeployInstructions(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app?.deploy.enabled) {
    ctx.log.error("deploy not enabled");
    return 3;
  }
  ctx.log.out(
    deployWebhookInstructions(app, app.deploy.hmacSecret ? "<stored in state>" : ""),
  );
  return 0;
}

async function cmdCronList(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const app = argv.app;
  const rows = listCronJobs(state, app).map((j) => [
    j.app,
    j.name,
    j.schedule,
    j.command.join(" "),
    j.enabled ? "yes" : "no",
  ]);
  ctx.log.out(printTable(["app", "name", "schedule", "command", "enabled"], rows));
  return 0;
}

async function cmdCronAdd(
  argv: ArgsWith<"app" | "name" | "schedule">,
  ctx: CliContext,
): Promise<number> {
  const { app, name, schedule, cmd: shellCommand } = argv;
  const cmd = shellCommand !== undefined ? [shellCommand] : trailing(argv, 2);
  if (cmd.length === 0) {
    ctx.log.error(
      "usage: bento cron add --app <app> --name <name> --schedule '*/5 * * * *' -- <command...>",
    );
    return 2;
  }
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = addCronJob(state, {
      app,
      name,
      schedule,
      command: cmd,
      commandMode: shellCommand !== undefined ? "shell" : "argv",
      timezone: argv.timezone,
      lock: argv.lock,
      timeoutSec: argv.timeout,
    }, ctx.platform);
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`added cron ${name} for ${app}`);
  return 0;
}

async function cmdCronRemove(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = removeCronJob(state, app, name, ctx.platform.clock.nowIso());
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`removed cron ${name}`);
  return 0;
}

async function cmdWorkerList(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const app = argv.app;
  const rows = listWorkers(state, app).map((w) => [
    w.app,
    w.name,
    w.command.join(" "),
    w.enabled ? "yes" : "no",
  ]);
  ctx.log.out(printTable(["app", "name", "command", "enabled"], rows));
  return 0;
}

async function cmdWorkerAdd(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const cmd = argv.cmd?.split(/\s+/).filter(Boolean) ?? trailing(argv, 2);
  if (cmd.length === 0) {
    ctx.log.error(
      "usage: bento worker add --app <app> --name <name> -- <command...>",
    );
    return 2;
  }
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = addWorker(state, {
      app,
      name,
      command: cmd,
    }, ctx.platform);
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`added worker ${name} for ${app}`);
  return 0;
}

async function cmdWorkerRemove(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = removeWorker(state, app, name, ctx.platform.clock.nowIso());
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`removed worker ${name}`);
  return 0;
}

async function cmdWorkerControl(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
  action: WorkerControlAction,
): Promise<number> {
  const { app, name } = argv;
  const state = await ctx.store.load();
  const plan = buildWorkerControlPlan(state, app, name, action);
  const result = await controlWorker(ctx.platform, plan);
  if (result.stdout) ctx.log.out(result.stdout.trimEnd());
  if (result.stderr && result.code !== 0) {
    ctx.log.error(result.stderr.trim());
  }
  if (result.code === 0) {
    ctx.log.info(`${action} ${plan.program} on ${plan.runnerService}`);
  }
  return result.code === 0 ? 0 : 8;
}

async function cmdWorkerStart(argv: ArgsWith<"app" | "name">, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "start");
}
async function cmdWorkerStop(argv: ArgsWith<"app" | "name">, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "stop");
}
async function cmdWorkerRestart(argv: ArgsWith<"app" | "name">, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "restart");
}
async function cmdWorkerInspect(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const state = await ctx.store.load();
  const result = await inspectWorker(ctx.platform, state, app, name);
  if (ctx.json) {
    ctx.log.out(JSON.stringify(
      {
        app: result.worker.app,
        name: result.worker.name,
        program: result.plan.program,
        runner: result.plan.runnerService,
        command: result.worker.command,
        enabled: result.worker.enabled,
        supervisor: result.stdout.trim(),
      },
      null,
      2,
    ));
  } else {
    ctx.log.out(
      [
        `worker ${result.worker.app}/${result.worker.name}`,
        `  program: ${result.plan.program}`,
        `  runner:  ${result.plan.runnerService}`,
        `  command: ${result.worker.command.join(" ")}`,
        `  enabled: ${result.worker.enabled ? "yes" : "no"}`,
        `  status:  ${result.stdout.trim() || result.stderr.trim() || "(no output)"}`,
      ].join("\n"),
    );
  }
  return result.code === 0 ? 0 : 8;
}

async function cmdAppShell(argv: ArgsWith<"slug">, ctx: CliContext): Promise<number> {
  // Interactive shell alias under `app shell` (no trailing command).
  return await runCliExec(ctx, {
    slug: argv.slug,
    argv: [],
    workdir: argv.workdir,
    phpVersionOverride: argv.php,
    printOnly: argv.print === true,
  });
}

async function cmdExec(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const slug = argv.app;
  const cmd = trailing(argv, 1);
  return await runCliExec(ctx, {
    slug,
    argv: cmd,
    workdir: argv.workdir,
    phpVersionOverride: argv.php,
    printOnly: argv.print === true,
  });
}

/**
 * Ephemeral app CLI: interactive TTY attach for shells, inherited stdio for commands.
 * Uses the profile-gated `${phpService}-cli` service (F-06 / F-16).
 */
async function runCliExec(
  ctx: CliContext,
  opts: {
    slug: string;
    argv: string[];
    workdir?: string;
    phpVersionOverride?: string;
    printOnly: boolean;
  },
): Promise<number> {
  const state = await ctx.store.load();
  let plan;
  try {
    plan = buildCliExec(ctx.platform, state, opts.slug, opts.argv, {
      workdir: opts.workdir,
      phpVersionOverride: opts.phpVersionOverride,
    });
  } catch (err) {
    ctx.log.error(err instanceof Error ? err.message : String(err));
    return 3;
  }

  let tty = false;
  try {
    tty = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
  } catch {
    tty = false;
  }
  // --print always uses non-TTY form for stable scripted output.
  const composeCmd = cliRunComposeCommand(plan, { tty: !opts.printOnly && tty });
  const compose = await composeArgs(ctx.platform, state, composeCmd);

  if (opts.printOnly) {
    if (ctx.json) {
      ctx.log.out(JSON.stringify(
        {
          service: plan.service,
          profile: plan.profile,
          user: plan.user,
          workdir: plan.workdir,
          phpVersion: plan.phpVersion,
          argv: plan.argv,
          command: compose,
        },
        null,
        2,
      ));
    } else {
      ctx.log.out(compose.join(" "));
    }
    return 0;
  }

  // Interactive attach / inherited stdio — do not capture pipes (breaks shells).
  const [cmd, ...args] = compose;
  const child = new Deno.Command(cmd!, {
    args,
    cwd: ctx.stackRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  return status.code;
}

async function cmdCompose(argv: CliArgs, ctx: CliContext): Promise<number> {
  const command = trailing(argv, 1).filter((a) => a !== "--print");
  const printOnly = argv.print === true || trailing(argv, 1).includes("--print");
  assertSafeComposeArgs(command);
  const state = await ctx.store.load();
  const { materializeDockerAssets } = await import("../services/assets_materialize.ts");
  await materializeDockerAssets(
    ctx.platform,
    state.phpVersions.map((v) => String(v.version)),
  );
  const baseCompose = `${ctx.platform.paths.paths.composeDir}/docker-compose.base.yml`;
  if (!(await ctx.platform.fs.exists(baseCompose))) {
    await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
  } else {
    await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
  }
  const full = await composeArgs(ctx.platform, state, command);
  if (printOnly) {
    ctx.log.out(full.join(" "));
    return 0;
  }
  ctx.log.info(`running: docker compose ${command.join(" ")}`);
  const [cmd, ...cmdArgs] = full;
  const child = new Deno.Command(cmd!, {
    args: cmdArgs,
    cwd: ctx.stackRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  return status.code;
}

async function cmdPermissionsCheck(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const report = await checkPermissions(ctx.platform, state, slug, {
    recursive: argv.recursive === true,
  });
  ctx.log.out(formatPermReport(report));
  return report.issues.length ? 1 : 0;
}

async function cmdPermissionsRepair(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const recursive = argv.recursive === true;
  const result = await repairPermissions(ctx.platform, state, slug, {
    dryRun: argv.dryRun === true,
    recursive,
    shallow: argv.shallow === true || !recursive,
  });
  for (const a of result.actions) ctx.log.info(a);
  ctx.log.out(formatPermReport(result.report));
  return 0;
}

async function cmdBackup(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const scope = argv.all === true
    ? "all" as const
    : argv.database
    ? "database" as const
    : "app" as const;
  if (scope !== "all" && !argv.app) {
    ctx.log.error("usage: bento backup --app <app> [--database name] | --all");
    return 2;
  }
  try {
    const artifacts = await runBackup(ctx.platform, state, {
      scope,
      slug: argv.app,
      database: argv.database,
      compress: argv.gzip === true ? "gzip" : argv.none === true ? "none" : "zstd",
    });
    for (const a of artifacts) {
      ctx.log.info(`backup ${a.database} -> ${a.path} (${a.bytes} bytes)`);
    }
    return 0;
  } catch (e) {
    ctx.log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function cmdRestore(
  argv: ArgsWith<"file" | "app" | "target">,
  ctx: CliContext,
): Promise<number> {
  const { file, app, target } = argv;
  if (argv.replace && argv.replace !== target) {
    ctx.log.error("replace confirmation must exactly match target database name");
    return 10;
  }
  ctx.log.warn(
    "restore is not object-level atomic; a failed import can leave a partial destination",
  );
  const state = await ctx.store.load();
  await runRestore(ctx.platform, state, {
    file,
    slug: app,
    targetDatabase: target,
    replaceOriginal: argv.replace,
  });
  ctx.log.info(`restore completed into ${target}`);
  return 0;
}

async function cmdTlsSet(argv: ArgsWith<"mode">, ctx: CliContext): Promise<number> {
  const { mode } = argv;
  let tls: TlsMode;
  if (mode === "boot") tls = { kind: "boot" };
  else if (mode === "acme") {
    tls = { kind: "acme", ...(argv.email ? { email: argv.email } : {}) };
    await ensureAcmeWebroot(ctx.platform);
  } else if (mode === "external") {
    if (!argv.cert || !argv.key) {
      ctx.log.error("external TLS requires --cert and --key");
      ctx.log.info(tlsOperatorDocs());
      return 2;
    }
    try {
      await validateExternalTlsPaths(
        ctx.platform,
        argv.cert,
        argv.key,
      );
    } catch (e) {
      ctx.log.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    tls = { kind: "external", certPath: argv.cert, keyPath: argv.key };
  }

  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const now = ctx.platform.clock.nowIso();
    let next = state;
    if (argv.app) {
      const slug = argv.app;
      const app = state.apps[slug];
      if (!app) throw new Error(`app not found: ${slug}`);
      next = {
        ...state,
        apps: {
          ...state.apps,
          [slug]: { ...app, tls, updatedAt: now },
        },
        updatedAt: now,
      };
    } else if (argv.proxy) {
      const name = argv.proxy;
      const proxy = state.proxies[name];
      if (!proxy) throw new Error(`proxy not found: ${name}`);
      next = {
        ...state,
        proxies: {
          ...state.proxies,
          [name]: { ...proxy, tls, updatedAt: now },
        },
        updatedAt: now,
      };
    } else {
      throw new Error("provide --app or --proxy");
    }
    await ctx.store.save(next);
    if (!noApply) {
      // TLS/domain-only: nginx reload; never touch PHP/runner (F-12 / architecture §7.4).
      await ctx.render.apply(next, {
        reloadPlan: { nginx: true, phpFpm: new Set(), phpRunner: new Set() },
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return next;
  });
  ctx.log.info(
    noApply ? `tls mode set to ${mode} (state only; run bento apply)` : `tls mode set to ${mode}`,
  );
  if (mode === "acme") {
    ctx.log.info(
      "ACME: point DNS A/AAAA at this host; place certs under certs/acme/<domain>/; HTTP-01 webroot is certs/acme-www.",
    );
  }
  return 0;
}

async function cmdComposeFiles(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const files = await resolveComposeFiles(ctx.platform, state);
  if (ctx.json) {
    ctx.log.out(JSON.stringify({ files }, null, 2));
  } else {
    ctx.log.out(
      "Compose files (deterministic order):\n" + files.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
  }
  return 0;
}

// --- access logs (F-23) ------------------------------------------------------

async function cmdLogsAccessEnable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  return await mutateAccessLog(argv, ctx, true);
}

async function cmdLogsAccessDisable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  return await mutateAccessLog(argv, ctx, false);
}

async function mutateAccessLog(
  argv: ArgsWith<"app">,
  ctx: CliContext,
  enabled: boolean,
): Promise<number> {
  const { app: slug } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const mutation = setAppAccessLog(
      state,
      slug,
      enabled,
      ctx.platform.clock.nowIso(),
      ctx.platform,
    );
    if (!isNginxOnlyReloadPlan(mutation.reloadPlan)) {
      throw new Error("access log mutation must be nginx-only");
    }
    await ctx.store.save(mutation.state);
    if (!noApply) {
      await ctx.render.apply(mutation.state, {
        reloadPlan: mutation.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return mutation;
  });
  ctx.log.info(
    enabled
      ? `access logs enabled for ${slug}`
      : `access logs disabled for ${slug} (existing files preserved at ${result.preservedLogPath})`,
  );
  return 0;
}

async function cmdLogsAccessRotate(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const result = await rotateAccessLog(ctx.platform, state, slug);
  // Assert reopen path (not nginx -s reload).
  const joined = result.plan.reopenCommand.join(" ");
  if (!joined.includes("reopen") || joined.includes("reload")) {
    ctx.log.error("internal: rotate plan must use nginx -s reopen");
    return 1;
  }
  ctx.log.info(
    result.rotated
      ? `rotated ${result.plan.logPath} -> ${result.plan.rotatedPath}`
      : `no active log file at ${result.plan.logPath}; reopen ${
        result.reopened ? "ok" : "skipped (nginx unavailable)"
      }`,
  );
  return 0;
}

async function cmdLogsAccessReport(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const dryRun = argv.dryRun === true;
  const result = await generateAccessReport(ctx.platform, state, slug, {
    output: argv.output,
    dryRun,
  });
  if (dryRun) {
    if (ctx.json) ctx.log.out(JSON.stringify(result, null, 2));
    else ctx.log.out(result.command.join(" "));
    return 0;
  }
  ctx.log.info(`report written to ${result.reportPath}`);
  return 0;
}

// --- templates (F-24) --------------------------------------------------------

async function cmdTemplateSelect(
  argv: ArgsWith<"app" | "kind" | "source">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug, kind, source } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const selected = await selectCustomTemplate(ctx.platform, state, {
      slug,
      kind,
      sourcePath: source,
      copy: argv.noCopy !== true,
    });
    await ctx.store.save(selected.state);
    if (!noApply) {
      await ctx.render.apply(selected.state, {
        reloadPlan: selected.reloadPlan,
        skipValidate: false,
        alreadyLocked: true,
      });
    }
    return selected;
  });
  ctx.log.info(
    `activated custom ${kind} template for ${slug} -> ${result.recordedPath}`,
  );
  return 0;
}

async function cmdTemplateReturn(
  argv: ArgsWith<"app" | "kind">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug, kind } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const returned = returnToUpstreamTemplate(
      state,
      slug,
      kind,
      ctx.platform.clock.nowIso(),
    );
    await ctx.store.save(returned.state);
    if (!noApply) {
      await ctx.render.apply(returned.state, {
        reloadPlan: returned.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return returned;
  });
  if (result.preservedPath) {
    ctx.log.info(
      `returned ${slug} ${kind} to upstream; custom source preserved at ${result.preservedPath}`,
    );
  } else {
    ctx.log.info(`${slug} ${kind} already upstream`);
  }
  return 0;
}

async function cmdTemplateDrift(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const drifts = await detectTemplateDrift(
    ctx.platform,
    state,
    argv.app,
  );
  if (ctx.json) {
    ctx.log.out(JSON.stringify(drifts, null, 2));
  } else if (drifts.length === 0) {
    ctx.log.info("no custom templates");
  } else {
    const rows = drifts.map((d) => [
      d.slug,
      d.kind,
      d.drifted ? "DRIFT" : "ok",
      d.sourcePath,
    ]);
    ctx.log.out(printTable(["app", "kind", "status", "source"], rows));
    for (const w of formatDriftWarnings(drifts)) ctx.log.warn(w);
  }
  return drifts.some((d) => d.drifted) ? 1 : 0;
}

// --- maintenance (product §6.10) ---------------------------------------------

async function cmdMaintenanceRun(argv: ArgsWith<"retainDays">, ctx: CliContext): Promise<number> {
  const { retainDays } = argv;
  const result = await runStackMaintenance(ctx.platform, { retainDays });
  for (const n of result.notes) ctx.log.info(n);
  if (ctx.json) {
    ctx.log.out(JSON.stringify(result, null, 2));
  } else {
    ctx.log.info(`removed ${result.removed.length} file(s)`);
    for (const p of result.removed) ctx.log.out(`  removed ${p}`);
  }
  return 0;
}

async function cmdMaintenanceRegister(argv: CliArgs, ctx: CliContext): Promise<number> {
  const result = await registerHostMaintenance(ctx.platform, {
    action: "install",
    schedule: argv.schedule,
    bentoBin: argv.bin,
    stackRoot: ctx.stackRoot,
  });
  ctx.log.info(
    result.action === "installed"
      ? "registered host maintenance cron (unrelated entries preserved)"
      : "host maintenance cron already registered",
  );
  return 0;
}

async function cmdMaintenanceUnregister(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const result = await registerHostMaintenance(ctx.platform, {
    action: "remove",
    stackRoot: ctx.stackRoot,
  });
  ctx.log.info(
    result.action === "removed"
      ? "unregistered host maintenance cron (unrelated entries preserved)"
      : "no host maintenance cron entry found",
  );
  return 0;
}
