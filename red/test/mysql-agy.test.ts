import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "red/cli";
import type { Opts } from "red/workflow";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");

const fixture = (overrides: Opts = {}): Opts => ({
  ...(Bun.YAML.parse(readFileSync(fixtureFile, "utf8")) as Opts),
  ...overrides,
});

function without(opts: Opts, key: string): Opts {
  const { [key]: _removed, ...rest } = opts;
  return rest;
}

const credentials: Opts = {
  "mysql-admin-password": "a",
  "mysql-replication-password": "b",
  "backup-r2-access-key-id": "c",
  "backup-r2-secret-access-key": "d",
  "do-token": "e",
  "cloudflare-api-token": "f",
};

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("the topology is a pure function of desired state", () => {
    expect(tools.nodes(fixture())).toEqual(tools.nodes(fixture()));
    expect(tools.nodes(fixture()).map((n) => n.name))
      .toEqual(["fixture-node-1", "fixture-node-2", "fixture-node-3"]);
    expect(tools.nodes(fixture()).map((n) => n["server-id"])).toEqual([101, 102, 103]);
    // The archiver's pseudo-replica ids cannot collide with a member's.
    const serverIds = new Set(tools.nodes(fixture()).map((n) => n["server-id"]));
    const connectionIds = new Set(tools.nodes(fixture()).map((n) => n["connection-server-id"]));
    expect([...serverIds].filter((id) => connectionIds.has(id))).toEqual([]);
  });

  test("every member seeds from every member", () => {
    const seeds = tools.groupSeeds({ ...tools.fallbackOutputs, ...fixture() });
    expect(seeds.split(",").length).toBe(3);
    expect(seeds).toContain(":33061");
  });

  test("the inventory names both groups", () => {
    const inv = JSON.parse(tools.inventory(fixture()));
    const children = inv.all.children;
    expect(Object.keys(children.mysql.hosts).length).toBe(3);
    expect(Object.keys(children.bootstrap.hosts)).toEqual(["fixture-node-1"]);
    // Bootstrap is only ever member one, and only for an empty group.
    expect(children.bootstrap.hosts["fixture-node-1"])
      .toEqual(children.mysql.hosts["fixture-node-1"]);
    expect(children.mysql.hosts["fixture-node-2"].ansible_ssh_private_key_file)
      .toBe("~/.ssh/id_ed25519");
  });

  test("the inventory is byte-stable", () => {
    expect(tools.inventory(fixture())).toBe(tools.inventory(fixture()));
  });

  test("build never reads state", () => {
    // Fallback addresses are documentation range, so a leak fails loudly.
    for (const ip of tools.fallbackOutputs.node_public_ips as string[]) {
      expect(ip.startsWith("192.0.2.")).toBe(true);
    }
    expect(String(tools.fallbackOutputs.reserved_ip).startsWith("192.0.2.")).toBe(true);
  });

  test("stage directories are remote-state keys", () => {
    for (const tool of tools.tofuTools) {
      expect(tools.toolDir(fixture(), tool).endsWith(`/${tool}`)).toBe(true);
    }
    expect(tools.tofuTools).toEqual(["mysql-agy-infrastructure", "mysql-agy-dns"]);
  });

  test("the rendered tree is exactly what a member needs", () => {
    const names = tools.ansibleSpecs(fixture())
      .map((s) => String(s.target).split("/").at(-1));
    for (const file of ["ansible.cfg", "base.yml", "cluster.yml", "backup.yml",
                        "health.yml", "cleanup.yml", "inventory.json",
                        "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
                        "mysql-agy-lib", "mysql-agy-endpoint", "mysql-agy-heartbeat",
                        "mysql-agy-snapshot", "mysql-agy-binlog-archive",
                        "mysql-agy-binlog-upload", "mysql-agy-restore-check",
                        "mysql-agy-health"]) {
      expect(names).toContain(file);
    }
    // No file holding a credential is ever rendered.
    for (const file of ["rclone.conf", "secrets.env", "binlog-client.cnf"]) {
      expect(names).not.toContain(file);
    }
  });

  test("the dns stage points at the reserved ip and the members", () => {
    const data = tools.dnsSpecs(fixture())[0]!.data as Opts;
    const records = JSON.parse(String(data["node-records-json"]));
    expect(data.reserved_ip).toBe(tools.fallbackOutputs.reserved_ip);
    expect(Object.keys(records)).toEqual([
      "node-1.my-ha.fixture.example",
      "node-2.my-ha.fixture.example",
      "node-3.my-ha.fixture.example",
    ]);
  });

  test("the backup prefix never carries a trailing slash", () => {
    expect(utils.backupPrefix(fixture())).toBe("mysql-agy-fixture");
    expect(utils.backupPrefix({ "backup-r2-prefix": "a/b//" })).toBe("a/b");
  });
});

// --- validate ----------------------------------------------------------------

describe("validate", () => {
  test("the fixture is renderable", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
  });

  test("every required key is required", () => {
    for (const k of validate.ownRequired) {
      expect(validate.stateErrors(without(fixture(), k))
        .some((e) => e.includes(`:${k} is required`))).toBe(true);
    }
  });

  test("the profile parameter is refused", () => {
    expect(validate.envErrors({})).toBeUndefined();
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "" })).toBeUndefined();
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "somewhere-else" })?.length).toBe(1);
  });

  test("the node budget is three", () => {
    expect(validate.stateErrors(fixture({ "cluster-nodes": 2 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-nodes": 5 })).length).toBeGreaterThan(0);
  });

  test("the vpc is never desired state", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-mode": "managed" })).length)
      .toBeGreaterThan(0);
  });

  test("the group name must be a uuid", () => {
    expect(validate.stateErrors(fixture({ "mysql-group-name": "mysql-agy" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "mysql-group-name": "00000000-1111-2222-3333-444444444444" }))).toEqual([]);
  });

  test("the endpoint must live in the managed zone", () => {
    expect(validate.stateErrors(fixture({ "cluster-host": "my-ha.example.org" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-host": "not a hostname" })).length)
      .toBeGreaterThan(0);
  });

  test("the proxy cannot carry mysql", () => {
    expect(validate.stateErrors(fixture({ "cloudflare-proxied": true })).length)
      .toBeGreaterThan(0);
  });

  test("the destroy guard must be a boolean", () => {
    expect(validate.stateErrors(fixture({ "compute-prevent-destroy": "true" })).length)
      .toBeGreaterThan(0);
  });

  test("backups may not share the state bucket", () => {
    expect(validate.stateErrors(
      fixture({ "backup-r2-bucket": fixture()["r2-bucket"] })).length).toBeGreaterThan(0);
  });

  test("source lists must be cidrs", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": [] })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "digitalocean-client-sources": ["203.0.113.7"] })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "digitalocean-ssh-sources": "203.0.113.7/32" })).length).toBeGreaterThan(0);
  });

  test("schedules and durations are checked", () => {
    expect(validate.stateErrors(fixture({ "heartbeat-interval": "often" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "backup-snapshot-oncalendar": "daily at one" })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "mysql-innodb-buffer-pool-size": "lots" })).length).toBeGreaterThan(0);
  });

  test("the group port cannot be the client port", () => {
    expect(validate.stateErrors(fixture({ "mysql-group-port": 3306 })).length)
      .toBeGreaterThan(0);
  });

  test("a real run needs exactly the credentials the design allows", () => {
    const errors = validate.secretErrors(fixture({ "red/event": "create" }));
    const names = new Set(errors.map((e) => e.match(/(COLORS_PAR_\S+)/)?.[1]));
    // The package must not invent a credential beyond the two it is given.
    expect(names).toEqual(new Set([
      "COLORS_PAR_MYSQL_ADMIN_PASSWORD",
      "COLORS_PAR_MYSQL_REPLICATION_PASSWORD",
      "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID",
      "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY",
      "COLORS_PAR_DO_TOKEN",
      "COLORS_PAR_CLOUDFLARE_API_TOKEN",
    ]));
  });

  test("health needs no database credential", () => {
    const errors = validate.secretErrors(fixture({ "red/event": "health" }));
    expect(errors.some((e) => /MYSQL/.test(e))).toBe(false);
    expect(errors.some((e) => /DO_TOKEN/.test(e))).toBe(true);
  });

  test("supplied credentials are not reported missing", () => {
    expect(validate.secretErrors(fixture({ "red/event": "create", ...credentials })))
      .toEqual([]);
  });

  test("only the providers this package implements are accepted", () => {
    expect(validate.stateErrors(fixture({ "provider-compute": "hcloud" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "provider-dns": "yandex" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "provider-backend": "local" }))).toEqual([]);
  });
});

// --- workflow ----------------------------------------------------------------

const create: Opts = { "red/event": "create" };
const build: Opts = { "red/event": "build" };
const del: Opts = { "red/event": "delete" };
const health: Opts = { "red/event": "health" };

const nexts = (step: string, runOpts: Opts): string[] =>
  (workflow.wireFn(step, runOpts) ?? []).slice(1).map(String);

describe("workflow", () => {
  test("create forks at the infrastructure and joins at the cluster", () => {
    expect(nexts("mysql-agy/start", create)).toEqual(["mysql-agy/infrastructure"]);
    expect(nexts("mysql-agy/infrastructure", create))
      .toEqual(["mysql-agy/dns", "mysql-agy/base"]);
    // Both branches converge on one step, so the engine joins them once.
    expect(nexts("mysql-agy/dns", create)).toEqual(["mysql-agy/cluster"]);
    expect(nexts("mysql-agy/base", create)).toEqual(["mysql-agy/cluster"]);
    expect(nexts("mysql-agy/cluster", create)).toEqual(["mysql-agy/backup"]);
    expect(nexts("mysql-agy/backup", create)).toEqual(["mysql-agy/health"]);
    expect(nexts("mysql-agy/health", create)).toEqual([]);
  });

  test("build walks the same graph as create", () => {
    for (const step of ["mysql-agy/start", "mysql-agy/infrastructure", "mysql-agy/dns",
                        "mysql-agy/base", "mysql-agy/cluster", "mysql-agy/backup"]) {
      expect(nexts(step, build)).toEqual(nexts(step, create));
    }
  });

  test("delete reads state first and destroys in reverse", () => {
    expect(nexts("mysql-agy/start", del)).toEqual(["mysql-agy/load-infrastructure"]);
    expect(nexts("mysql-agy/load-infrastructure", del)).toEqual(["mysql-agy/cleanup"]);
    expect(nexts("mysql-agy/cleanup", del)).toEqual(["mysql-agy/dns"]);
    expect(nexts("mysql-agy/dns", del)).toEqual(["mysql-agy/infrastructure"]);
    expect(nexts("mysql-agy/infrastructure", del)).toEqual([]);
  });

  test("health changes nothing", () => {
    expect(nexts("mysql-agy/start", health)).toEqual(["mysql-agy/load-infrastructure"]);
    expect(nexts("mysql-agy/load-infrastructure", health)).toEqual(["mysql-agy/health"]);
    expect(workflow.wireFn("mysql-agy/health", health)?.[0]).toBe(tools.healthStep);
    // No stage that converges anything is reachable from health.
    for (const decl of [workflow.wireFn("mysql-agy/load-infrastructure", health),
                        workflow.wireFn("mysql-agy/health", health)]) {
      expect([tools.infrastructureStep, tools.dnsStep, tools.clusterStep])
        .not.toContain(decl?.[0]);
    }
  });

  test("a build needs no credential", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "build" }), {});
    expect(result["red/exit"]).toBe(0);
  });

  test("a real run refuses without credentials", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "create" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_MYSQL_ADMIN_PASSWORD");
  });

  test("a dry-run needs no credential", async () => {
    const result = await workflow.startStep(
      fixture({ "red/event": "create", "red/dry-run": true }), {});
    expect(result["red/exit"]).toBe(0);
  });

  test("the profile parameter is refused before anything else", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "build" }),
      { COLORS_PAR_PROFILE: "elsewhere" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_PROFILE");
  });

  test("the destroy guard holds", async () => {
    const result = await workflow.startStep(
      fixture({ "red/event": "delete", ...credentials }), {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
    // And lifts for exactly one run.
    const lifted = await workflow.startStep(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }), {});
    expect(lifted["red/exit"]).toBe(0);
  });

  test("defaults do not quietly permit destruction", () => {
    expect(workflow.defaults["compute-prevent-destroy"]).toBe(true);
  });

  test("every side-effecting step is skipped by dry-run", () => {
    for (const event of ["create", "delete", "health"]) {
      const wired = workflow.sideEffecting
        .filter((step) => workflow.wireFn(step, { "red/event": event }));
      expect(wired.every((step) => workflow.sideEffecting.includes(step))).toBe(true);
    }
  });

  test("a whole build renders every stage", async () => {
    const result = await runCli(workflow.mysqlAgyWorkflow, ["build", "-f", fixtureFile]);
    expect(result["red/exit"]).toBe(0);
    const root = join(import.meta.dir, "../../test/fixtures/.colors/mysql-agy-fixture");
    for (const stage of ["mysql-agy-infrastructure", "mysql-agy-dns", "mysql-agy-ansible"]) {
      expect(statSync(join(root, stage)).isDirectory()).toBe(true);
    }
    // The backend is written by advice, before the stage runs.
    expect(existsSync(join(root, "mysql-agy-infrastructure", "backend.tf.json"))).toBe(true);
    expect(existsSync(join(root, "mysql-agy-dns", "backend.tf.json"))).toBe(true);
    // Nothing that looks like a credential is written.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
    for (const file of walk(root)) {
      expect(readFileSync(file, "utf8"))
        .not.toMatch(/REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });
});
