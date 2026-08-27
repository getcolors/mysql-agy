// OpenTofu and Ansible stages for the three-member Group Replication cluster —
// the port of io.github.getcolors.mysql-agy.tools.

import * as ansible from "red/ansible";
import { toolEnv } from "red/providers";
import { runtime } from "red/runtime";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleBackup from "../resources/tools/ansible/backup.yml" with { type: "text" };
import ansibleBase from "../resources/tools/ansible/base.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCluster from "../resources/tools/ansible/cluster.yml" with { type: "text" };
import ansibleHealth from "../resources/tools/ansible/health.yml" with { type: "text" };
import filesApparmorLocal from "../resources/tools/ansible/files/apparmor-local" with { type: "text" };
import filesBinlogArchive from "../resources/tools/ansible/files/mysql-agy-binlog-archive" with { type: "text" };
import filesBinlogUpload from "../resources/tools/ansible/files/mysql-agy-binlog-upload" with { type: "text" };
import filesEndpoint from "../resources/tools/ansible/files/mysql-agy-endpoint" with { type: "text" };
import filesHealth from "../resources/tools/ansible/files/mysql-agy-health" with { type: "text" };
import filesHeartbeat from "../resources/tools/ansible/files/mysql-agy-heartbeat" with { type: "text" };
import filesLib from "../resources/tools/ansible/files/mysql-agy-lib" with { type: "text" };
import filesRestoreCheck from "../resources/tools/ansible/files/mysql-agy-restore-check" with { type: "text" };
import filesSnapshot from "../resources/tools/ansible/files/mysql-agy-snapshot" with { type: "text" };
import filesMysqldCnf from "../resources/tools/ansible/files/mysqld.cnf" with { type: "text" };
import filesNodeEnv from "../resources/tools/ansible/files/node.env" with { type: "text" };
import filesVerifyCnf from "../resources/tools/ansible/files/verify.cnf" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

export const infrastructureTool = "mysql-agy-infrastructure";
export const dnsTool = "mysql-agy-dns";
export const ansibleTool = "mysql-agy-ansible";
export const tofuTools = [infrastructureTool, dnsTool];

const templateOpts = PRESERVE_JINJA_DELIMITERS;

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible/ansible.cfg": ansibleCfg,
  "ansible/backup.yml": ansibleBackup,
  "ansible/base.yml": ansibleBase,
  "ansible/cleanup.yml": ansibleCleanup,
  "ansible/cluster.yml": ansibleCluster,
  "ansible/health.yml": ansibleHealth,
  "ansible/files/apparmor-local": filesApparmorLocal,
  "ansible/files/mysql-agy-binlog-archive": filesBinlogArchive,
  "ansible/files/mysql-agy-binlog-upload": filesBinlogUpload,
  "ansible/files/mysql-agy-endpoint": filesEndpoint,
  "ansible/files/mysql-agy-health": filesHealth,
  "ansible/files/mysql-agy-heartbeat": filesHeartbeat,
  "ansible/files/mysql-agy-lib": filesLib,
  "ansible/files/mysql-agy-restore-check": filesRestoreCheck,
  "ansible/files/mysql-agy-snapshot": filesSnapshot,
  "ansible/files/mysqld.cnf": filesMysqldCnf,
  "ansible/files/node.env": filesNodeEnv,
  "ansible/files/verify.cnf": filesVerifyCnf,
  "dns/main.tf": dnsMainTf,
  "infrastructure/main.tf": infrastructureMainTf,
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new StepError(`template not found: ${name}`);
  return { name, content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function toolDir(opts: Opts, tool: string): string {
  return utils.toolDir(opts, tool);
}

export function credentialEnv(opts: Opts, ...slotNames: string[]): Record<string, string> | undefined {
  return toolEnv(validate.providers, opts, [...slotNames, "provider-backend"]);
}

// ---------------------------------------------------------------------------
// deterministic JSON — cheshire's bytes, exactly

// Java's Double.toString, which is what Cheshire renders floats through and
// therefore what green's committed bytes would carry. Integral numbers print
// as longs. JS's shortest-round-trip digits are the same digits Java chooses;
// only the layout differs.
function javaNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const negative = value < 0;
  const [mantissa, exponentPart] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentPart);
  const digits = mantissa!.replace(".", "");
  let body: string;
  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const intPart = digits.padEnd(exponent + 1, "0").slice(0, exponent + 1);
      const fracPart = digits.slice(exponent + 1);
      body = `${intPart}.${fracPart.length > 0 ? fracPart : "0"}`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const rest = digits.slice(1);
    body = `${digits[0]}.${rest.length > 0 ? rest : "0"}E${exponent}`;
  }
  return negative ? `-${body}` : body;
}

// Cheshire's compact printer: no whitespace, floats in Java notation.
export function jsonCompact(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => jsonCompact(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, nested]) => `${JSON.stringify(key)}:${jsonCompact(nested)}`)
      .join(",")}}`;
  }
  if (typeof value === "number") return javaNumber(value);
  return JSON.stringify(value ?? null);
}

// Cheshire's pretty printer, byte for byte: spaces around colons, arrays
// inline, nested objects newline-indented, floats in Java notation.
export function jsonPretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => jsonPretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${jsonPretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  if (typeof value === "number") return javaNumber(value);
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// infrastructure

export const fallbackOutputs: Opts = {
  node_public_ips: ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
  node_private_ips: ["10.110.0.11", "10.110.0.12", "10.110.0.13"],
  node_droplet_ids: [100000001, 100000002, 100000003],
  reserved_ip: "192.0.2.10",
  vpc_id: "00000000-0000-0000-0000-000000000000",
  vpc_ip_range: "10.110.0.0/20",
};

export function infrastructureSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, infrastructureTool);
  const data: Opts = {
    ...opts,
    "node-count": utils.nodeCount(opts),
    "digitalocean-ssh-sources-json": jsonCompact(opts["digitalocean-ssh-sources"]),
    "digitalocean-client-sources-json": jsonCompact(opts["digitalocean-client-sources"]),
  };
  return [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`, data)];
}

function outputsMap(result: Opts): Opts {
  return (result["mysql-agy/outputs"] as Opts | undefined) ?? {};
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const result = await tofu.tofuWithSpec(opts, infrastructureSpecs(opts), {
    dir: toolDir(opts, infrastructureTool),
    env: credentialEnv(opts, "provider-compute"),
    outputKey: "mysql-agy/outputs",
  });
  if (failed(result)) return result;
  if (opts["red/event"] === "delete") return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackOutputs };
  return { ...result, ...fallbackOutputs, ...outputsMap(result) };
}

export function processResult(
  opts: Opts, label: string, { exit, out, err }: { exit: number; out: string; err: string },
): Opts {
  if (exit === 0) return { ...opts, "red/exit": 0 };
  return {
    ...opts,
    "red/exit": Math.max(1, exit),
    "red/err": `${label} failed: ${err || out || "(no output)"}`,
  };
}

// Read node addresses out of remote state without planning or changing
// anything.
export async function loadInfrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const rendered: Opts = {
    ...scaffold({ ...opts, "red/event": "build" }, infrastructureSpecs(opts)),
    "red/event": opts["red/event"],
  };
  // runtime.exec overlays this on the whole process environment, which is the
  // same merge green performs explicitly with System/getenv.
  const env = credentialEnv(opts, "provider-compute");
  const init = await runtime.exec(
    ["tofu", `-chdir=${dir}`, "init", "-input=false", "-no-color"], { env });
  if (init.exit !== 0) {
    return processResult(rendered, "infrastructure state initialization", init);
  }
  try {
    const outputs = await tofu.outputs(dir, env);
    return {
      ...rendered,
      ...fallbackOutputs,
      ...outputs,
      "mysql-agy/infrastructure-present?": "reserved_ip" in outputs,
    };
  } catch (t) {
    return {
      ...rendered,
      "red/exit": 1,
      "red/err": `infrastructure state output failed: ${
        t instanceof Error ? t.message || t.constructor.name : String(t)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// shared template data

export interface Node {
  ordinal: number;
  name: string;
  host: string;
  "public-ip": unknown;
  "private-ip": unknown;
  "droplet-id": unknown;
  "server-id": number;
  "connection-server-id": number;
}

// One map per member, in ordinal order, merging desired state with
// infrastructure outputs.
export function nodes(opts: Opts): Node[] {
  const data = { ...fallbackOutputs, ...opts };
  return utils.ordinals(opts).map((ordinal) => {
    const idx = ordinal - 1;
    return {
      ordinal,
      name: utils.nodeName(opts, ordinal),
      host: utils.nodeHost(opts, ordinal),
      "public-ip": (data.node_public_ips as unknown[])?.[idx] ?? null,
      "private-ip": (data.node_private_ips as unknown[])?.[idx] ?? null,
      "droplet-id": (data.node_droplet_ids as unknown[])?.[idx] ?? null,
      "server-id": utils.serverId(ordinal),
      "connection-server-id": utils.connectionServerId(ordinal),
    };
  });
}

// `group_replication_group_seeds`: every member's private address on the group
// port.
export function groupSeeds(opts: Opts): string {
  return nodes(opts)
    .map((node) => `${node["private-ip"]}:${opts["mysql-group-port"]}`)
    .join(",");
}

export function dataFn(opts: Opts): Opts {
  const data = { ...fallbackOutputs, ...opts };
  return {
    ...data,
    "node-count": utils.nodeCount(opts),
    "backup-prefix": utils.backupPrefix(opts),
    "group-seeds": groupSeeds(data),
    "cluster-record": utils.recordName(opts["cluster-host"]),
  };
}

// Ansible inventory as JSON.
export function inventory(opts: Opts): string {
  const data = dataFn(opts);
  const keyFile = String(data["digitalocean-ssh-private-key"] ?? "");
  const hosts: Record<string, Opts> = {};
  for (const node of nodes(data)) {
    // Sorted the way green's nested sorted-map emits its keys.
    hosts[node.name] = {
      ansible_host: node["public-ip"],
      ansible_ssh_private_key_file: keyFile,
      ansible_user: "root",
      connection_server_id: node["connection-server-id"],
      droplet_id: node["droplet-id"],
      node_host: node.host,
      node_ordinal: node.ordinal,
      private_ip: node["private-ip"],
      server_id: node["server-id"],
    };
  }
  const sortedHosts = Object.fromEntries(
    Object.keys(hosts).sort().map((name) => [name, hosts[name]!]));
  const bootstrapName = utils.nodeName(opts, 1);
  return jsonPretty({
    all: {
      children: {
        mysql: { hosts: sortedHosts },
        bootstrap: {
          hosts: bootstrapName in sortedHosts
            ? { [bootstrapName]: sortedHosts[bootstrapName] }
            : {},
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// dns

export function dnsSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, dnsTool);
  const base = dataFn(opts);
  const records: Record<string, unknown> = {};
  for (const node of nodes(base)) {
    records[utils.recordName(node.host)] = node["public-ip"];
  }
  const data: Opts = {
    ...base,
    "node-records-json": jsonCompact(Object.fromEntries(
      Object.keys(records).sort().map((name) => [name, records[name]]))),
  };
  return [spec(template("dns", "main.tf"), `${dir}/main.tf`, data)];
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  return tofu.tofuWithSpec(opts, dnsSpecs(opts), {
    dir: toolDir(opts, dnsTool),
    env: credentialEnv(opts, "provider-dns"),
    outputKey: "mysql-agy/dns-outputs",
  });
}

// ---------------------------------------------------------------------------
// ansible

const playbooks = ["base.yml", "cluster.yml", "backup.yml", "health.yml", "cleanup.yml"];

const nodeFiles = [
  "mysql-agy-lib", "mysql-agy-endpoint", "mysql-agy-heartbeat", "mysql-agy-snapshot",
  "mysql-agy-binlog-archive", "mysql-agy-binlog-upload", "mysql-agy-restore-check",
  "mysql-agy-health", "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
];

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = dataFn(opts);
  return [
    spec(template("ansible", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    ...playbooks.map((file) => spec(template("ansible", file), `${dir}/${file}`, data)),
    ...nodeFiles.map((file) => spec(template("ansible.files", file), `${dir}/files/${file}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(opts)),
  ];
}

function ansibleConfig(opts: Opts, playbook: string, recapKey: string): ansible.AnsibleConfig {
  return {
    dir: toolDir(opts, ansibleTool),
    inventory: "inventory.json",
    playbooks: { create: playbook, delete: playbook },
    hostKeyChecking: false,
    recapKey,
  };
}

// Render the whole Ansible directory once.
export function ansibleRenderStep(opts: Opts): Opts {
  return scaffold(opts, ansibleSpecs(opts));
}

async function playbookStep(opts: Opts, playbook: string, recapKey: string): Promise<Opts> {
  if (opts["red/event"] === "build") return scaffold(opts, ansibleSpecs(opts));
  return ansible.ansibleStep(
    scaffold({ ...opts, "red/event": "create" }, ansibleSpecs(opts)),
    ansibleConfig(opts, playbook, recapKey));
}

export async function baseStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "base.yml", "mysql-agy/base-recap")),
           "red/event": opts["red/event"] };
}

export async function clusterStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "cluster.yml", "mysql-agy/cluster-recap")),
           "red/event": opts["red/event"] };
}

export async function backupStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "backup.yml", "mysql-agy/backup-recap")),
           "red/event": opts["red/event"] };
}

export async function healthStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "health.yml", "mysql-agy/health-recap")),
           "red/event": opts["red/event"] };
}

// Stop the managed units before the droplets are destroyed.
export async function cleanupStep(opts: Opts): Promise<Opts> {
  if (opts["mysql-agy/infrastructure-present?"] === false) {
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(
    opts, ansibleConfig(opts, "cleanup.yml", "mysql-agy/cleanup-recap"), ansibleSpecs(opts));
}
