/** Scoped reload targets for narrow blast radius. */

export type ReloadTarget =
  | { kind: "nginx" }
  | { kind: "php-fpm"; service: string }
  | { kind: "php-runner"; service: string }
  | { kind: "none" };

export type ReloadPlan = {
  nginx: boolean;
  phpFpm: Set<string>;
  phpRunner: Set<string>;
  /** Per-runner Supercronic programs whose mounted crontabs must be reloaded. */
  cronSchedulers?: Map<string, Set<string>>;
};

export function emptyReloadPlan(): ReloadPlan {
  return { nginx: false, phpFpm: new Set(), phpRunner: new Set() };
}

export function mergeReloadPlans(...plans: ReloadPlan[]): ReloadPlan {
  const result = emptyReloadPlan();
  for (const plan of plans) {
    if (plan.nginx) result.nginx = true;
    for (const s of plan.phpFpm) result.phpFpm.add(s);
    for (const s of plan.phpRunner) result.phpRunner.add(s);
    for (const [runner, apps] of plan.cronSchedulers ?? []) {
      const merged = result.cronSchedulers?.get(runner) ?? new Set<string>();
      for (const app of apps) merged.add(app);
      (result.cronSchedulers ??= new Map()).set(runner, merged);
    }
  }
  return result;
}

export function reloadPlanForDomainChange(): ReloadPlan {
  return { nginx: true, phpFpm: new Set(), phpRunner: new Set() };
}

export function reloadPlanForPoolChange(phpService: string): ReloadPlan {
  return {
    nginx: true,
    phpFpm: new Set([phpService]),
    phpRunner: new Set(),
  };
}

export function reloadPlanForRunnerChange(phpService: string): ReloadPlan {
  return {
    nginx: false,
    phpFpm: new Set(),
    phpRunner: new Set([phpService]),
  };
}

/** Reload runner config and signal one app's Supercronic process to reread its crontab. */
export function reloadPlanForCronChange(runnerService: string, appSlug: string): ReloadPlan {
  return {
    nginx: false,
    phpFpm: new Set(),
    phpRunner: new Set([runnerService]),
    cronSchedulers: new Map([[runnerService, new Set([appSlug])]]),
  };
}

export function reloadPlanForFullApply(
  phpServices: string[],
  runnerServices: string[],
): ReloadPlan {
  return {
    nginx: true,
    phpFpm: new Set(phpServices),
    phpRunner: new Set(runnerServices),
  };
}

export function reloadPlanIsEmpty(plan: ReloadPlan): boolean {
  return !plan.nginx && plan.phpFpm.size === 0 && plan.phpRunner.size === 0 &&
    (plan.cronSchedulers?.size ?? 0) === 0;
}

export function describeReloadPlan(plan: ReloadPlan): string[] {
  const lines: string[] = [];
  if (plan.nginx) lines.push("nginx");
  for (const s of [...plan.phpFpm].sort()) lines.push(`php-fpm:${s}`);
  for (const s of [...plan.phpRunner].sort()) lines.push(`php-runner:${s}`);
  if (lines.length === 0) lines.push("(none)");
  return lines;
}
