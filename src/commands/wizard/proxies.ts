import { createProxy } from "../../services/proxy.ts";
import { type MenuChoice, WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState, handleError, pcDim } from "./shared.ts";

export async function sectionProxies(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Manage reverse proxies");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const state = await ctx.store.load();
    const choices: MenuChoice<string>[] = Object.values(state.proxies)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((proxy) => ({
        label: proxy.name,
        value: proxy.name,
        hint: `${proxy.mainDomain} · ${proxy.upstreams.length} upstream${
          proxy.upstreams.length === 1 ? "" : "s"
        }`,
      }));
    choices.push({ label: "Create reverse proxy…", value: "__create" });

    const name = await ui.menu("Select reverse proxy", choices);
    if (!name) return;
    if (name === "__create") {
      await wizardProxyCreate(ui, ctx);
      continue;
    }

    const proxy = (await ctx.store.load()).proxies[name];
    if (!proxy) continue;
    ui.blank();
    ui.table(
      ["field", "value"],
      [
        ["name", proxy.name],
        ["domain", proxy.mainDomain],
        ["aliases", proxy.aliases.join(", ") || "-"],
        ["upstreams", proxy.upstreams.join("\n")],
        ["keepalive", "5 connections"],
        ["tls", proxy.tls.kind],
        ["access-log", proxy.accessLog ? "enabled" : "disabled"],
      ],
    );
    await ui.pause();
  }
}

async function wizardProxyCreate(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.blank();
  ui.message(pcDim("Create a reverse-proxy site with one or more upstream servers."));

  const name = await ui.prompt("Proxy name", { required: true });
  if (name === null) return;
  const domain = await ui.prompt("Primary domain", { required: true });
  if (domain === null) return;
  const aliasRaw = await ui.prompt("Domain aliases (comma-separated)", { default: "" });
  if (aliasRaw === null) return;
  const aliases = aliasRaw.split(",").map((value) => value.trim()).filter(Boolean);

  const upstreams: string[] = [];
  while (true) {
    const upstream = await ui.prompt(
      upstreams.length === 0 ? "Upstream URL" : "Additional upstream URL",
      {
        required: true,
        default: upstreams.length === 0 ? "http://127.0.0.1:3000" : undefined,
      },
    );
    if (upstream === null) return;
    upstreams.push(upstream);
    if (!(await ui.confirm("Add another upstream server?", { defaultYes: false }))) break;
  }

  const accessLog = await ui.confirm("Enable access logs?", { defaultYes: false });
  const noApply = !(await ui.confirm("Render & apply after save?", { defaultYes: true }));

  ui.blank();
  ui.table(
    ["field", "value"],
    [
      ["name", name],
      ["domain", domain],
      ["aliases", aliases.join(", ") || "-"],
      ["upstreams", upstreams.join("\n")],
      ["nginx upstream", `upstream_${name}`],
      ["keepalive", "5 connections"],
      ["access-log", accessLog ? "yes" : "no"],
      ["apply", noApply ? "skip" : "yes"],
    ],
  );

  if (!(await ui.confirm("Proceed?", { defaultYes: true }))) {
    ui.info("Cancelled.");
    await ui.pause();
    return;
  }

  try {
    const result = await ctx.store.withExclusive(async (state) => {
      const created = createProxy(state, {
        name,
        domain,
        aliases,
        upstreams,
        accessLog,
      }, ctx.platform.clock.nowIso());
      await ctx.store.save(created.state);
      if (!noApply) {
        await ctx.render.apply(created.state, {
          reloadPlan: created.reloadPlan,
          skipValidate: false,
          alreadyLocked: true,
        });
      }
      return created;
    });
    ui.success(
      `Created proxy ${result.proxy.name}`,
      `${result.proxy.mainDomain} · ${result.proxy.upstreams.length} upstream${
        result.proxy.upstreams.length === 1 ? "" : "s"
      }`,
    );
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}
