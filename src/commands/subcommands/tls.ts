import type { TlsMode } from "../../domain/state.ts";
import {
  ensureAcmeWebroot,
  tlsOperatorDocs,
  validateExternalTlsPaths,
} from "../../services/tls.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith } from "../args.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerTlsCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
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
        .recommendCommands());
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
