// Lifecycle graph, preflight, and backend advice — the port of
// io.github.getcolors.mysql-agy.workflow.

import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": "digitalocean",
  "provider-dns": "cloudflare",
  "provider-backend": "local",
  workdir: ".colors",
};

// Events that reach a provider and therefore need credentials.
export const credentialEvents = ["create", "delete", "health"];

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && credentialEvents.includes(String(event))
          ? validate.secretErrors(current)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "mysql-agy/start": [startStep, "mysql-agy/load-infrastructure"],
      "mysql-agy/load-infrastructure": [tools.loadInfrastructureStep, "mysql-agy/cleanup"],
      "mysql-agy/cleanup": [tools.cleanupStep, "mysql-agy/dns"],
      "mysql-agy/dns": [tools.dnsStep, "mysql-agy/infrastructure"],
      "mysql-agy/infrastructure": [tools.infrastructureStep],
    };
    return graph[step];
  }
  if (runOpts["red/event"] === "health") {
    const graph: Record<string, WireDecl> = {
      "mysql-agy/start": [startStep, "mysql-agy/load-infrastructure"],
      "mysql-agy/load-infrastructure": [tools.loadInfrastructureStep, "mysql-agy/health"],
      "mysql-agy/health": [tools.healthStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "mysql-agy/start": [startStep, "mysql-agy/infrastructure"],
    "mysql-agy/infrastructure": [tools.infrastructureStep, "mysql-agy/dns", "mysql-agy/base"],
    "mysql-agy/dns": [tools.dnsStep, "mysql-agy/cluster"],
    "mysql-agy/base": [tools.baseStep, "mysql-agy/cluster"],
    "mysql-agy/cluster": [tools.clusterStep, "mysql-agy/backup"],
    "mysql-agy/backup": [tools.backupStep, "mysql-agy/health"],
    "mysql-agy/health": [tools.healthStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "mysql-agy/infrastructure", "mysql-agy/load-infrastructure", "mysql-agy/dns",
  "mysql-agy/base", "mysql-agy/cluster", "mysql-agy/backup", "mysql-agy/health",
  "mysql-agy/cleanup",
];

function create() {
  let wf = workflow({ start: "mysql-agy/start", wireFn });
  wf = progress.advise(wf);
  wf = dryRun.advise(wf, sideEffecting);
  for (const tool of tools.tofuTools) {
    wf = adviceAdd(wf, `mysql-agy/${tool.slice("mysql-agy-".length)}`, "before",
      `io.github.getcolors.mysql-agy.workflow/backend-${tool}`, backendAdvice(tool));
  }
  return adviceAdd(wf, "mysql-agy/load-infrastructure", "before",
    "io.github.getcolors.mysql-agy.workflow/backend-load-infrastructure",
    backendAdvice(tools.infrastructureTool));
}

export const mysqlAgyWorkflow = create();
