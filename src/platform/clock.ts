import type { Clock } from "./interfaces.ts";

export function createClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
    nowIso(): string {
      return new Date().toISOString();
    },
  };
}

export function createFixedClock(iso: string): Clock {
  const d = new Date(iso);
  return {
    now(): Date {
      return new Date(d.getTime());
    },
    nowIso(): string {
      return d.toISOString();
    },
  };
}
