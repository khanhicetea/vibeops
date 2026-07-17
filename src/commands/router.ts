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
  materializeAppHome,
  provisionApp,
} from "../services/app.ts";
import { addPhpVersion, buildCliExec, listPhpVersions, removePhpVersion } from "../services/php.ts";
import {
  addMysqlVersion,
  applyRotatedMysqlPassword,
  assertShellPlanSecretsOffArgv,
  buildMysqlShellPlan,
  createAppDatabaseLive,
  listMysqlVersions,
  queryDatabaseSizes,
  queryProcesslist,
  removeMysqlVersion,
  resolveMysqlServices,
  rotateAppPassword,
  runBackup,
  runRestore,
} from "../services/mysql.ts";
import { loadRedisPassword, requireMysqlRootPassword } from "../services/stack_env.ts";
import { createProxy } from "../services/proxy.ts";
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
  type TemplateKind,
} from "../services/customization.ts";
import { registerHostMaintenance, runStackMaintenance } from "../services/maintenance.ts";
import { buildStatus, formatStatus, statusToJson } from "../services/status.ts";
import { checkPermissions, formatPermReport, repairPermissions } from "../services/permissions.ts";
import { assertSafeComposeArgs, composeArgs, resolveComposeFiles } from "../services/compose.ts";
import { ensureAcmeWebroot, tlsOperatorDocs, validateExternalTlsPaths } from "../services/tls.ts";
import { printTable, redact } from "../ui/output.ts";
import type { TlsMode } from "../domain/state.ts";
import { runWizard } from "./wizard.ts";

type RunState = { code: number };
// deno-lint-ignore no-explicit-any
type YargsBuilder = Argv<any>;

class EarlyExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "EarlyExit";
  }
}

type AnyArgv = Record<string, unknown> & { _: Array<string | number> };

function wantsNoApply(argv: AnyArgv): boolean {
  return argv["no-apply"] === true || argv.noApply === true;
}

function noApplyOption(y: YargsBuilder): YargsBuilder {
  return y.option("no-apply", {
    type: "boolean",
    default: false,
    describe: "Mutate desired state only; skip render/apply (use `bento apply` later)",
  });
}

/** Drop command-path tokens from argv._ to recover passthrough args (after --). */
function trailing(argv: AnyArgv, drop: number): string[] {
  return argv._.slice(drop).map(String);
}

function bind(
  state: RunState,
  handler: (argv: AnyArgv, ctx: CliContext) => Promise<number>,
): (argv: AnyArgv) => Promise<void> {
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

function withGlobals<T>(y: Argv<T>): Argv<T> {
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
      "halt-at-non-option": false,
    });
}

function buildParser(state: RunState) {
  // deno-lint-ignore no-explicit-any
  let parser: Argv<any> = yargs()
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
    .fail((msg: string | undefined, err: Error | undefined) => {
      if (err) throw err;
      if (msg) {
        console.error(`error: ${msg}`);
        console.error("");
        parser.showHelp("error");
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
        .demandCommand(1, "Specify an app subcommand: create|list|show")
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
          "password <app>",
          "Rotate app MySQL password (printed once)",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdMysqlPassword),
        )
        .command(
          "shell",
          "Open MySQL shell (password staged via stdin; never host argv)",
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
        .demandCommand(
          1,
          "Specify a mysql subcommand: add|list|db|password|shell|size|processlist",
        )
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
                  describe: "Command string (prefer -- argv form)",
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
      "Ephemeral CLI as app identity (command after --)",
      (y: YargsBuilder) =>
        y
          .positional("app", { type: "string", demandOption: true })
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
  // Preserve historical short-circuits for version / bare help.
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
    if (a === "--json") continue;
    rest.push(a);
  }
  return rest;
}

// --- command handlers -------------------------------------------------------

async function cmdTui(_argv: AnyArgv, ctx: CliContext): Promise<number> {
  return await runWizard(ctx);
}

async function cmdInit(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const force = argv.force === true;
  const state = await ctx.store.init(force);
  ctx.log.info(`initialized state at ${ctx.platform.paths.paths.stateFile}`);
  ctx.log.info(
    `defaults: php=${state.defaults.phpVersion} mysql=${state.defaults.mysqlVersion}`,
  );
  return 0;
}

async function cmdRender(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdApply(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const renderOnly = argv["render-only"] === true || argv.renderOnly === true;
  const skipValidate = argv["skip-validate"] === true || argv.skipValidate === true;
  const preview = argv.preview === true;
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

async function cmdStatus(_argv: AnyArgv, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const report = await buildStatus(ctx.platform, state);
  if (ctx.json) ctx.log.out(statusToJson(report));
  else ctx.log.out(formatStatus(report));
  return 0;
}

async function cmdAppList(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdAppShow(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.slug ?? "");
  if (!slug) {
    ctx.log.error("usage: bento app show <slug>");
    return 2;
  }
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

async function cmdAppCreate(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.slug ?? "");
  const domain = argv.domain ? String(argv.domain) : "";
  if (!slug || !domain) {
    ctx.log.error(
      "usage: bento app create <slug> --domain <domain> [--php 8.5] [--fpm small] [--docroot public] [--legacy] [--db] [--alias a,b]",
    );
    return 2;
  }
  const aliases = argv.alias ? String(argv.alias).split(",").filter(Boolean) : [];
  const noApply = wantsNoApply(argv);
  const skipValidate = argv["skip-validate"] === true || argv.skipValidate === true;
  const explicitDb = argv.db === true;
  const result = await ctx.store.withExclusive(async (state) => {
    const provisioned = provisionApp(ctx.platform, state, {
      slug,
      domain,
      aliases,
      documentRoot: argv.docroot ? String(argv.docroot) : undefined,
      entrypointMode: argv.legacy === true
        ? "legacy"
        : argv.front === true
        ? "front-controller"
        : undefined,
      phpVersion: argv.php ? String(argv.php) : undefined,
      fpmProfile: argv.fpm ? String(argv.fpm) : undefined,
      mysqlVersion: argv.mysql ? String(argv.mysql) : undefined,
      createDatabase: explicitDb,
      databaseName: argv.database ? String(argv.database) : undefined,
      accessLog: argv["access-log"] === true || argv.accessLog === true,
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

async function cmdPhpList(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdPhpAdd(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const version = String(argv.version ?? "");
  if (!version) {
    ctx.log.error("usage: bento php add <version>");
    return 2;
  }
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

async function cmdPhpRemove(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const version = String(argv.version ?? "");
  if (!version) {
    ctx.log.error("usage: bento php remove <version>");
    return 2;
  }
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

async function cmdMysqlList(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdMysqlAdd(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const version = String(argv.version ?? "");
  if (!version) {
    ctx.log.error("usage: bento mysql add <version>");
    return 2;
  }
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

async function cmdMysqlRemove(argv: AnyArgv, ctx: CliContext): Promise<number> {
  removeMysqlVersion(await ctx.store.load(), String(argv.version ?? ""));
  return 10;
}

async function cmdMysqlDb(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  const dbName = String(argv.database ?? "");
  if (!slug || !dbName) {
    ctx.log.error("usage: bento mysql db <app> <database>");
    return 2;
  }
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

async function cmdMysqlPassword(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) {
    ctx.log.error("usage: bento mysql password <app>");
    return 2;
  }
  const result = await ctx.store.withExclusive(async (state) => {
    const rotated = rotateAppPassword(ctx.platform, state, slug);
    const app = rotated.state.apps[slug]!;
    const rootPassword = await requireMysqlRootPassword(ctx.platform).catch(() => undefined);
    const applied = await applyRotatedMysqlPassword(
      ctx.platform,
      app,
      rootPassword,
    );
    const redisShared = await loadRedisPassword(ctx.platform);
    await materializeAppHome(ctx.platform, app, {
      recursivePerms: false,
      redisSharedPassword: redisShared,
    });
    await ctx.store.save(rotated.state);
    return { ...rotated, applied };
  });
  // Password is intentionally printed once for the operator (not status/list).
  ctx.log.out(result.password);
  ctx.log.info(
    result.applied
      ? `rotated MySQL password for ${slug} (shown once above; applied to live MySQL)`
      : `rotated MySQL password for ${slug} (shown once above; live MySQL apply deferred — retry when MySQL is up)`,
  );
  return 0;
}

async function cmdMysqlShell(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const asRoot = argv.root === true;
  const appSlug = argv.app ? String(argv.app) : "";
  if (asRoot === Boolean(appSlug)) {
    ctx.log.error("usage: bento mysql shell --root [--service mysql84] | --app <slug>");
    return 2;
  }
  const state = await ctx.store.load();
  const database = argv.database ? String(argv.database) : undefined;
  const printOnly = argv.print === true;

  let plan;
  if (asRoot) {
    const services = resolveMysqlServices(state, {
      service: argv.service ? String(argv.service) : undefined,
    });
    const service = services[0];
    if (!service) {
      ctx.log.error("no MySQL service managed");
      return 3;
    }
    const password = await requireMysqlRootPassword(ctx.platform);
    plan = buildMysqlShellPlan(ctx.platform, { kind: "root", service, password }, {
      database,
      interactive: !printOnly,
    });
    assertShellPlanSecretsOffArgv(plan, [password]);
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
          stage: plan.stage.command,
          open: plan.open.command,
          cleanup: plan.cleanup.command,
        },
        null,
        2,
      ));
    } else {
      ctx.log.out(`stage: ${plan.stage.command.join(" ")}`);
      ctx.log.out(`open:  ${plan.open.command.join(" ")}`);
      ctx.log.out(`cleanup: ${plan.cleanup.command.join(" ")}`);
    }
    return 0;
  }

  // Stage option file (password on stdin only).
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
    await ctx.platform.process.run(plan.cleanup.command, {
      cwd: ctx.stackRoot,
      timeoutMs: 10_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  }
}

async function cmdMysqlSize(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rootPassword = await requireMysqlRootPassword(ctx.platform);
  const services = resolveMysqlServices(state, {
    service: argv.service ? String(argv.service) : undefined,
    app: argv.app ? String(argv.app) : undefined,
  });
  const allRows: Array<{ service: string; database: string; sizeMb: string; tables: string }> = [];
  for (const service of services) {
    let databases: string[] = [];
    if (argv.app) {
      const app = state.apps[String(argv.app)];
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

async function cmdMysqlProcesslist(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rootPassword = await requireMysqlRootPassword(ctx.platform);
  const services = resolveMysqlServices(state, {
    service: argv.service ? String(argv.service) : undefined,
    app: argv.app ? String(argv.app) : undefined,
  });
  for (const service of services) {
    const { stdout } = await queryProcesslist(ctx.platform, service, rootPassword);
    if (services.length > 1) ctx.log.out(`-- ${service} --`);
    ctx.log.out(stdout.trimEnd() || "(no processes)");
  }
  return 0;
}

async function cmdProxyList(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdProxyCreate(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const name = String(argv.name ?? "");
  if (!name || !argv.domain || !argv.upstream) {
    ctx.log.error(
      "usage: bento proxy create <name> --domain <domain> --upstream http://127.0.0.1:3000",
    );
    return 2;
  }
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const result = createProxy(state, {
      name,
      domain: String(argv.domain),
      upstream: String(argv.upstream),
      aliases: argv.alias ? String(argv.alias).split(",") : [],
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

async function cmdDeployEnable(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) {
    ctx.log.error("usage: bento deploy enable <app>");
    return 2;
  }
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

async function cmdDeployDisable(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) return 2;
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

async function cmdDeployRotate(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) return 2;
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

async function cmdDeployStatus(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) return 2;
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

async function cmdDeployDrain(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) return 2;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app) return 3;
  const home = ctx.platform.paths.appHome(slug);
  const job = await drainDeploy(ctx.platform, app, home);
  if (!job) ctx.log.info("no job drained");
  else ctx.log.info(`drained ${job.id} -> ${job.status}`);
  return 0;
}

async function cmdDeployInstructions(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) return 2;
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

async function cmdCronList(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const app = argv.app ? String(argv.app) : undefined;
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

async function cmdCronAdd(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const app = argv.app ? String(argv.app) : "";
  const name = argv.name ? String(argv.name) : "";
  const schedule = argv.schedule ? String(argv.schedule) : "";
  const cmd = argv.cmd ? String(argv.cmd).split(/\s+/).filter(Boolean) : trailing(argv, 2);
  if (!app || !name || !schedule || cmd.length === 0) {
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
      timezone: argv.timezone ? String(argv.timezone) : undefined,
      lock: argv.lock ? String(argv.lock) : undefined,
      timeoutSec: argv.timeout != null ? Number(argv.timeout) : undefined,
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

async function cmdCronRemove(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const app = String(argv.app ?? "");
  const name = String(argv.name ?? "");
  if (!app || !name) return 2;
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

async function cmdWorkerList(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const app = argv.app ? String(argv.app) : undefined;
  const rows = listWorkers(state, app).map((w) => [
    w.app,
    w.name,
    w.command.join(" "),
    w.enabled ? "yes" : "no",
  ]);
  ctx.log.out(printTable(["app", "name", "command", "enabled"], rows));
  return 0;
}

async function cmdWorkerAdd(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const app = argv.app ? String(argv.app) : "";
  const name = argv.name ? String(argv.name) : "";
  const cmd = argv.cmd ? String(argv.cmd).split(/\s+/).filter(Boolean) : trailing(argv, 2);
  if (!app || !name || cmd.length === 0) {
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

async function cmdWorkerRemove(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const app = String(argv.app ?? "");
  const name = String(argv.name ?? "");
  if (!app || !name) return 2;
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
  argv: AnyArgv,
  ctx: CliContext,
  action: WorkerControlAction,
): Promise<number> {
  const app = String(argv.app ?? "");
  const name = String(argv.name ?? "");
  if (!app || !name) {
    ctx.log.error(`usage: bento worker ${action} <app> <name>`);
    return 2;
  }
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

async function cmdWorkerStart(argv: AnyArgv, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "start");
}
async function cmdWorkerStop(argv: AnyArgv, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "stop");
}
async function cmdWorkerRestart(argv: AnyArgv, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "restart");
}
async function cmdWorkerInspect(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const app = String(argv.app ?? "");
  const name = String(argv.name ?? "");
  if (!app || !name) {
    ctx.log.error("usage: bento worker inspect <app> <name>");
    return 2;
  }
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

async function cmdExec(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) {
    ctx.log.error("usage: bento exec <app> -- <command...>");
    return 2;
  }
  const cmd = trailing(argv, 1);
  const state = await ctx.store.load();
  const plan = buildCliExec(ctx.platform, state, slug, cmd.length ? cmd : ["bash"]);
  const compose = await composeArgs(ctx.platform, state, [
    "run",
    "--rm",
    "-u",
    plan.user,
    "-w",
    plan.workdir,
    ...Object.entries(plan.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    plan.service,
    ...plan.argv,
  ]);
  if (argv.print === true) {
    ctx.log.out(compose.join(" "));
    return 0;
  }
  const result = await ctx.platform.process.run(compose, {
    cwd: ctx.stackRoot,
  });
  if (result.stdout) await Deno.stdout.write(new TextEncoder().encode(result.stdout));
  if (result.stderr) await Deno.stderr.write(new TextEncoder().encode(result.stderr));
  return result.code;
}

async function cmdCompose(argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdPermissionsCheck(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) {
    ctx.log.error("usage: bento permissions check|repair <app> [--recursive] [--dry-run]");
    return 2;
  }
  const state = await ctx.store.load();
  const report = await checkPermissions(ctx.platform, state, slug, {
    recursive: argv.recursive === true,
  });
  ctx.log.out(formatPermReport(report));
  return report.issues.length ? 1 : 0;
}

async function cmdPermissionsRepair(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = String(argv.app ?? "");
  if (!slug) {
    ctx.log.error("usage: bento permissions check|repair <app> [--recursive] [--dry-run]");
    return 2;
  }
  const state = await ctx.store.load();
  const recursive = argv.recursive === true;
  const result = await repairPermissions(ctx.platform, state, slug, {
    dryRun: argv["dry-run"] === true || argv.dryRun === true,
    recursive,
    shallow: argv.shallow === true || !recursive,
  });
  for (const a of result.actions) ctx.log.info(a);
  ctx.log.out(formatPermReport(result.report));
  return 0;
}

async function cmdBackup(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const rootPassword = Deno.env.get("MYSQL_ROOT_PASSWORD");
  if (!rootPassword) {
    ctx.log.error("MYSQL_ROOT_PASSWORD must be set in the environment for backup");
    return 9;
  }
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
      slug: argv.app ? String(argv.app) : undefined,
      database: argv.database ? String(argv.database) : undefined,
      compress: argv.gzip === true ? "gzip" : argv.none === true ? "none" : "zstd",
    }, rootPassword);
    for (const a of artifacts) {
      ctx.log.info(`backup ${a.database} -> ${a.path} (${a.bytes} bytes)`);
    }
    return 0;
  } catch (e) {
    ctx.log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function cmdRestore(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const file = argv.file ? String(argv.file) : "";
  const app = argv.app ? String(argv.app) : "";
  const target = argv.target ? String(argv.target) : argv.database ? String(argv.database) : "";
  if (!file || !app || !target) {
    ctx.log.error(
      "usage: bento restore --file <path> --app <app> --target <db> [--replace <exact-name>]",
    );
    return 2;
  }
  if (argv.replace && String(argv.replace) !== target) {
    ctx.log.error("replace confirmation must exactly match target database name");
    return 10;
  }
  ctx.log.warn(
    "restore is not object-level atomic; a failed import can leave a partial destination",
  );
  const rootPassword = Deno.env.get("MYSQL_ROOT_PASSWORD");
  if (!rootPassword) {
    ctx.log.error("MYSQL_ROOT_PASSWORD must be set");
    return 9;
  }
  const state = await ctx.store.load();
  await runRestore(ctx.platform, state, {
    file,
    slug: app,
    targetDatabase: target,
    replaceOriginal: argv.replace ? String(argv.replace) : undefined,
  }, rootPassword);
  ctx.log.info(`restore completed into ${target}`);
  return 0;
}

async function cmdTlsSet(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const mode = String(argv.mode ?? "");
  let tls: TlsMode;
  if (mode === "boot") tls = { kind: "boot" };
  else if (mode === "acme") {
    tls = { kind: "acme", ...(argv.email ? { email: String(argv.email) } : {}) };
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
        String(argv.cert),
        String(argv.key),
      );
    } catch (e) {
      ctx.log.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
    tls = { kind: "external", certPath: String(argv.cert), keyPath: String(argv.key) };
  } else {
    ctx.log.error("mode must be boot|acme|external");
    ctx.log.info(tlsOperatorDocs());
    return 2;
  }

  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const now = ctx.platform.clock.nowIso();
    let next = state;
    if (argv.app) {
      const slug = String(argv.app);
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
      const name = String(argv.proxy);
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

async function cmdComposeFiles(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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

async function cmdLogsAccessEnable(argv: AnyArgv, ctx: CliContext): Promise<number> {
  return await mutateAccessLog(argv, ctx, true);
}

async function cmdLogsAccessDisable(argv: AnyArgv, ctx: CliContext): Promise<number> {
  return await mutateAccessLog(argv, ctx, false);
}

async function mutateAccessLog(
  argv: AnyArgv,
  ctx: CliContext,
  enabled: boolean,
): Promise<number> {
  const slug = argv.app ? String(argv.app) : "";
  if (!slug) {
    ctx.log.error(`usage: bento logs access ${enabled ? "enable" : "disable"} --app <slug>`);
    return 2;
  }
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

async function cmdLogsAccessRotate(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = argv.app ? String(argv.app) : "";
  if (!slug) {
    ctx.log.error("usage: bento logs access rotate --app <slug>");
    return 2;
  }
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

async function cmdLogsAccessReport(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = argv.app ? String(argv.app) : "";
  if (!slug) {
    ctx.log.error("usage: bento logs access report --app <slug> [--dry-run]");
    return 2;
  }
  const state = await ctx.store.load();
  const dryRun = argv["dry-run"] === true || argv.dryRun === true;
  const result = await generateAccessReport(ctx.platform, state, slug, {
    output: argv.output ? String(argv.output) : undefined,
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

async function cmdTemplateSelect(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = argv.app ? String(argv.app) : "";
  const kind = String(argv.kind ?? "") as TemplateKind;
  const source = argv.source ? String(argv.source) : "";
  if (!slug || (kind !== "vhost" && kind !== "pool") || !source) {
    ctx.log.error(
      "usage: bento template select --app <slug> --kind vhost|pool --source <path>",
    );
    return 2;
  }
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const selected = await selectCustomTemplate(ctx.platform, state, {
      slug,
      kind,
      sourcePath: source,
      copy: !(argv["no-copy"] === true || argv.noCopy === true),
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

async function cmdTemplateReturn(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const slug = argv.app ? String(argv.app) : "";
  const kind = String(argv.kind ?? "") as TemplateKind;
  if (!slug || (kind !== "vhost" && kind !== "pool")) {
    ctx.log.error("usage: bento template return --app <slug> --kind vhost|pool");
    return 2;
  }
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

async function cmdTemplateDrift(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const drifts = await detectTemplateDrift(
    ctx.platform,
    state,
    argv.app ? String(argv.app) : undefined,
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

async function cmdMaintenanceRun(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const retainDays = argv["retain-days"] != null
    ? Number(argv["retain-days"])
    : argv.retainDays != null
    ? Number(argv.retainDays)
    : 14;
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

async function cmdMaintenanceRegister(argv: AnyArgv, ctx: CliContext): Promise<number> {
  const result = await registerHostMaintenance(ctx.platform, {
    action: "install",
    schedule: argv.schedule ? String(argv.schedule) : undefined,
    bentoBin: argv.bin ? String(argv.bin) : undefined,
    stackRoot: ctx.stackRoot,
  });
  ctx.log.info(
    result.action === "installed"
      ? "registered host maintenance cron (unrelated entries preserved)"
      : "host maintenance cron already registered",
  );
  return 0;
}

async function cmdMaintenanceUnregister(_argv: AnyArgv, ctx: CliContext): Promise<number> {
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
