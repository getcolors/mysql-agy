// The lifecycle graph, preflight, and the backend advice each OpenTofu stage
// runs behind — the port of io.github.getcolors.mysql-agy.workflow.
//
// Create forks after the infrastructure: Cloudflare and apt have nothing to say
// to each other, so `dns` and `base` run in parallel and join at `cluster`.
// Joining DNS there rather than leaving it dangling means a bad zone or a
// missing token surfaces before any data-plane work starts.
//
// Delete and health both begin by adopting the cluster out of remote state,
// because neither can re-derive it. The state is read once, in preflight, so
// the Compute Provider Standard's switch guard runs before the credentials are
// checked; the read is handed to `load-infrastructure` rather than repeated.

import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-backend": "local",
  workdir: ".colors",
};

// Events that reach a provider and therefore need credentials. `build` is
// deliberately absent: a fresh checkout with an empty environment must render.
export const credentialEvents = ["create", "delete", "health"];

const realCredentialEvent = ({ event, real }: PreflightContext): boolean =>
  real && credentialEvents.includes(String(event));

// Preflight. On a real create, delete or health the compute state is read
// once through `reader` — the package's `tools.stateOutput` unless a test
// injects another — on the same defaulted and overlaid opts the validators
// see, and only once desired state itself has passed, so the reader never
// renders an invalid colors.yml. The read feeds the switch guard here and
// travels on under `mysql-agy/state` for `load-infrastructure` to adopt.
export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  reader: compute.StateReader = tools.stateOutput,
): Promise<Opts> {
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const context: PreflightContext = {
    event: typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined,
    real: !overlaid["red/dry-run"],
  };
  const state: compute.StateRead =
    realCredentialEvent(context)
      && validate.envErrors(env).length === 0
      && validate.stateErrors(overlaid).length === 0
      ? await computeCluster.readState(overlaid, reader)
      : {};
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Standard §4 before the credentials: a recorded provider that differs
      // from the selected one reports the actionable error, not a missing
      // token for the provider that was just selected.
      (current, _environment, ctx) => (realCredentialEvent(ctx)
        ? computeCluster.providerValidator(validate.spec, current, state.params, () => validate.secretErrors(current))
        : []),
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    afterValidate: (current, _environment, ctx) => (realCredentialEvent(ctx)
      ? { ...current, "red/exit": 0, "mysql-agy/state": state }
      : { ...current, "red/exit": 0 }),
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

// The state backend of one OpenTofu stage: `tools.backendAdvice`, which the
// state reader also runs, so a delete from a fresh clone finds its state.
export function backendAdvice(tool: string) {
  return tools.backendAdvice(tool);
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
  // `load-infrastructure` runs `tofu init` in the infrastructure stage's
  // own directory, so it needs that stage's backend written first — the
  // same advice, targeted at a different step.
  return adviceAdd(wf, "mysql-agy/load-infrastructure", "before",
    "io.github.getcolors.mysql-agy.workflow/backend-load-infrastructure",
    backendAdvice(tools.infrastructureTool));
}

export const mysqlAgyWorkflow = create();
