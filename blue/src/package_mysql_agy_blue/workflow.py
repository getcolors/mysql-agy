"""Lifecycle graph, preflight, and backend advice — the port of
io.github.getcolors.mysql-agy.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, workflow

from . import tools, validate

DEFAULTS = {"compute-prevent-destroy": True,
            "provider-compute": "digitalocean",
            "provider-dns": "cloudflare",
            "provider-backend": "local",
            "workdir": ".colors"}

# Events that reach a provider and therefore need credentials.
CREDENTIAL_EVENTS = ("create", "delete", "health")


async def start_step(opts: dict, env: dict | None = None) -> dict:
    return await preflight(
        opts, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o)
                              if c["real"] and c["event"] in CREDENTIAL_EVENTS else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ])


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "mysql-agy/start": (start_step, "mysql-agy/load-infrastructure"),
            "mysql-agy/load-infrastructure": (tools.load_infrastructure_step,
                                              "mysql-agy/cleanup"),
            "mysql-agy/cleanup": (tools.cleanup_step, "mysql-agy/dns"),
            "mysql-agy/dns": (tools.dns_step, "mysql-agy/infrastructure"),
            "mysql-agy/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    if run_opts.get("blue/event") == "health":
        return {
            "mysql-agy/start": (start_step, "mysql-agy/load-infrastructure"),
            "mysql-agy/load-infrastructure": (tools.load_infrastructure_step,
                                              "mysql-agy/health"),
            "mysql-agy/health": (tools.health_step,),
        }.get(step)
    return {
        "mysql-agy/start": (start_step, "mysql-agy/infrastructure"),
        "mysql-agy/infrastructure": (tools.infrastructure_step,
                                     "mysql-agy/dns", "mysql-agy/base"),
        "mysql-agy/dns": (tools.dns_step, "mysql-agy/cluster"),
        "mysql-agy/base": (tools.base_step, "mysql-agy/cluster"),
        "mysql-agy/cluster": (tools.cluster_step, "mysql-agy/backup"),
        "mysql-agy/backup": (tools.backup_step, "mysql-agy/health"),
        "mysql-agy/health": (tools.health_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


side_effecting = ["mysql-agy/infrastructure", "mysql-agy/load-infrastructure",
                  "mysql-agy/dns", "mysql-agy/base", "mysql-agy/cluster",
                  "mysql-agy/backup", "mysql-agy/health", "mysql-agy/cleanup"]


def create_workflow():
    wf = workflow(start="mysql-agy/start", wire_fn=wire_fn)
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting)
    for tool in tools.tofu_tools:
        wf = advice_add(wf, f"mysql-agy/{tool[len('mysql-agy-'):]}", "before",
                        f"io.github.getcolors.mysql-agy.workflow/backend-{tool}",
                        backend_advice(tool))
    return advice_add(wf, "mysql-agy/load-infrastructure", "before",
                      "io.github.getcolors.mysql-agy.workflow/backend-load-infrastructure",
                      backend_advice(tools.infrastructure_tool))


mysql_agy_workflow = create_workflow()
