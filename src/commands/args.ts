import type { TlsMode } from "../domain/state.ts";
import type { TemplateKind } from "../services/customization.ts";

type StringArgName =
  | "alias"
  | "app"
  | "bin"
  | "cert"
  | "cmd"
  | "database"
  | "docroot"
  | "domain"
  | "email"
  | "file"
  | "fpm"
  | "key"
  | "lock"
  | "mysql"
  | "name"
  | "output"
  | "php"
  | "proxy"
  | "replace"
  | "repoRoot"
  | "schedule"
  | "service"
  | "signal"
  | "slug"
  | "source"
  | "target"
  | "timezone"
  | "version"
  | "workdir";

type BooleanArgName =
  | "accessLog"
  | "all"
  | "attach"
  | "db"
  | "dryRun"
  | "fifo"
  | "force"
  | "front"
  | "gzip"
  | "keep"
  | "legacy"
  | "noApply"
  | "noCopy"
  | "none"
  | "preview"
  | "print"
  | "recursive"
  | "renderOnly"
  | "root"
  | "shallow"
  | "skipBuild"
  | "skipHttp"
  | "skipValidate";

type NumberArgName = "retainDays" | "scheduleWaitSec" | "timeout" | "timeoutSec";

/** Canonical camelCase shape emitted by the configured yargs parser. */
export type CliArgs =
  & {
    _: Array<string | number>;
    $0: string;
    stack: string;
    json: boolean;
    kind?: TemplateKind;
    mode?: TlsMode["kind"];
    upstream?: string | string[];
  }
  & Partial<Record<StringArgName, string>>
  & Partial<Record<BooleanArgName, boolean>>
  & Partial<Record<NumberArgName, number>>;

/** Marks options guaranteed by a command's demandOption/default declaration. */
export type ArgsWith<K extends keyof CliArgs> =
  & CliArgs
  & {
    [P in K]-?: NonNullable<CliArgs[P]>;
  };
