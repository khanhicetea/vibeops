/** Minimal path helpers (POSIX-focused for Linux control plane). */

export function join(...parts: string[]): string {
  if (parts.length === 0) return ".";
  const joined = parts.filter((p) => p !== "").join("/");
  return normalize(joined);
}

export function dirname(path: string): string {
  if (path === "") return ".";
  const normalized = path.replace(/\/+$/, "") || "/";
  const idx = normalized.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return normalized.slice(0, idx);
}

export function basename(path: string): string {
  const normalized = path.replace(/\/+$/, "") || "/";
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function normalize(path: string): string {
  if (path === "") return ".";
  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") stack.pop();
      else if (!absolute) stack.push("..");
      continue;
    }
    stack.push(part);
  }
  const out = (absolute ? "/" : "") + stack.join("/");
  return out || (absolute ? "/" : ".");
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  let absolute = false;
  for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
    const p = parts[i];
    if (!p) continue;
    resolved = resolved ? `${p}/${resolved}` : p;
    absolute = p.startsWith("/");
  }
  if (!absolute) {
    resolved = resolved ? `${Deno.cwd()}/${resolved}` : Deno.cwd();
  }
  return normalize(resolved);
}

export function relative(from: string, to: string): string {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  const ups = fromParts.slice(i).map(() => "..");
  const downs = toParts.slice(i);
  const rel = [...ups, ...downs].join("/");
  return rel || ".";
}

export function fromFileUrl(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "file:") throw new TypeError("not a file URL");
  // file:///path on unix
  return decodeURIComponent(u.pathname);
}
