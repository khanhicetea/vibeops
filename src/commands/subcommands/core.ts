import { describeReloadPlan } from "../../domain/reload.ts";
import { detectTemplateDrift, formatDriftWarnings } from "../../services/customization.ts";
import { createSupportBundle, formatDoctor, runDoctor } from "../../services/doctor.ts";
import { buildStatus, formatStatus, statusToJson } from "../../services/status.ts";
import {
  DEFAULT_SCHEDULE_WAIT_SEC,
  DEFAULT_TEST_STACK_NAME,
  formatTestStackReport,
  resolveTestStackOptions,
  runTestStack,
} from "../../services/test_stack.ts";
import { runWizard } from "../wizard.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, printVersion, type RunState, type YargsBuilder } from "../shared.ts";

export function registerCoreCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
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
      "doctor",
      "Validate host, network, storage, TLS, services, and stack safety",
      () => {},
      bind(state, cmdDoctor),
    )
    .command(
      "support-bundle [output]",
      "Create a redacted diagnostic .tar.gz archive",
      (y: YargsBuilder) =>
        y.positional("output", {
          type: "string",
          describe: "Archive path (default: under the stack root)",
        }),
      bind(state, cmdSupportBundle),
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
    );
}

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

async function cmdDoctor(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const report = await runDoctor(ctx.platform, await ctx.store.load());
  ctx.log.out(ctx.json ? JSON.stringify(report, null, 2) + "\n" : formatDoctor(report));
  return report.ok ? 0 : 1;
}

async function cmdSupportBundle(argv: CliArgs, ctx: CliContext): Promise<number> {
  const stamp = ctx.platform.clock.nowIso().replace(/[:.]/g, "-");
  const output = argv.output ?? `${ctx.stackRoot}/bento-support-${stamp}.tar.gz`;
  const path = await createSupportBundle(ctx.platform, await ctx.store.load(), output);
  if (ctx.json) ctx.log.out(JSON.stringify({ archive: path, redacted: true }, null, 2));
  else ctx.log.out(`Redacted support bundle: ${path}\n`);
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
