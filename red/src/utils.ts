// Launcher contract, node topology, and shared derivations — the port of
// io.github.getcolors.mysql-agy.utils.

import { stageDir } from "red/cli";
import type { Opts } from "red/workflow";

// Minimum mysql-agy contract a standalone launcher must find.
export const contract = 1;

export function nodeCount(opts: Opts): number {
  const n = opts["cluster-nodes"];
  return typeof n === "number" && Number.isInteger(n) ? n : 3;
}

export function ordinals(opts: Opts): number[] {
  return Array.from({ length: nodeCount(opts) }, (_, i) => i + 1);
}

// MySQL server_id derived from the ordinal.
export function serverId(ordinal: number): number {
  return 100 + ordinal;
}

// The pseudo-replica id mysqlbinlog registers with.
export function connectionServerId(ordinal: number): number {
  return 200 + ordinal;
}

// Per-member administrative FQDN.
export function nodeHost(opts: Opts, ordinal: number): string {
  return `node-${ordinal}.${opts["cluster-host"] ?? ""}`;
}

// Cloudflare DNS record name without trailing dot.
export function recordName(host: unknown): string {
  return String(host ?? "").replace(/\.$/, "");
}

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "mysql-agy" });
}

// Object-key prefix inside the backup bucket, without trailing slashes.
export function backupPrefix(opts: Opts): string {
  return String(opts["backup-r2-prefix"] ?? "").replace(/\/+$/, "");
}

const durationRe = /^[0-9]+(?:ms|s|m|h|min|d)$/;

export function duration(x: unknown): boolean {
  return typeof x === "string" && durationRe.test(x);
}
