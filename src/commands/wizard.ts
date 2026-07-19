/**
 * Interactive wizard (TUI) for Bento operator workflows.
 * Guided numbered menus over the same services as scripted CLI commands.
 */

import { WizardUI } from "../ui/tui.ts";
import { BENTO_VERSION } from "../version.ts";
import type { CliContext } from "./context.ts";
import { sectionApps } from "./wizard/apps.ts";
import { sectionBootstrap } from "./wizard/bootstrap.ts";
import { sectionMysql } from "./wizard/mysql.ts";
import { sectionPhp } from "./wizard/php.ts";
import { handleError, pcDim } from "./wizard/shared.ts";
import { sectionStatus } from "./wizard/status.ts";

type WizardSection = "apps" | "mysql" | "php" | "status" | "bootstrap";
type SectionHandler = (ui: WizardUI, ctx: CliContext) => Promise<void>;

const SECTION_HANDLERS: Record<WizardSection, SectionHandler> = {
  apps: sectionApps,
  mysql: sectionMysql,
  php: sectionPhp,
  status: sectionStatus,
  bootstrap: sectionBootstrap,
};

export async function runWizard(ctx: CliContext): Promise<number> {
  const ui = new WizardUI();
  if (!ui.isInteractive()) {
    ctx.log.error(
      "tui requires an interactive terminal (stdin/stdout TTY). Use scripted commands instead.",
    );
    return 2;
  }

  showWelcome(ui, ctx);

  try {
    while (true) {
      const choice = await ui.menu<WizardSection>("Main menu", [
        {
          label: "Manage app",
          value: "apps",
          hint: "shell · databases · cron jobs · workers · domains · logs · templates",
        },
        {
          label: "Manage MySQL",
          value: "mysql",
          hint: "shell · versions · sizes · backup · restore",
        },
        { label: "Manage PHP", value: "php", hint: "add version · reload FPM" },
        { label: "Status / Diag", value: "status", hint: "stack · apps · capacity" },
        { label: "Bootstrap", value: "bootstrap", hint: "init · render · apply" },
      ], { cancelLabel: "Quit", allowCancel: true });

      if (choice === null) {
        ui.blank();
        ui.message(pcDim("Goodbye."));
        return 0;
      }

      ui.clear();
      try {
        await SECTION_HANDLERS[choice](ui, ctx);
      } catch (err) {
        handleError(ui, err);
        await ui.pause();
      }
      showMainHeader(ui, ctx);
    }
  } catch (err) {
    handleError(ui, err);
    return 1;
  }
}

function showWelcome(ui: WizardUI, ctx: CliContext): void {
  ui.clear();
  ui.header("Bento Wizard", `v${BENTO_VERSION}  ·  stack ${ctx.stackRoot}`);
  ui.message("Guided operator workflows. All actions map to scriptable CLI commands.");
  ui.note([
    "↑/↓ (or j/k) move highlight · Enter confirms · number/letter key selects instantly.",
    "0 / q / Esc goes back. Secrets are shown only when freshly generated/rotated.",
  ]);
  ui.blank();
}

function showMainHeader(ui: WizardUI, ctx: CliContext): void {
  ui.clear();
  ui.header("Bento Wizard", `stack ${ctx.stackRoot}`);
}
