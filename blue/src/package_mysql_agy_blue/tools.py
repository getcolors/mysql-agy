"""OpenTofu and Ansible stages for the three-member Group Replication cluster —
the port of io.github.getcolors.mysql-agy.tools."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_step, ansible_with_spec
from blue.providers import tool_env
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed

from . import utils, validate

infrastructure_tool = "mysql-agy-infrastructure"
dns_tool = "mysql-agy-dns"
ansible_tool = "mysql-agy-ansible"
tofu_tools = [infrastructure_tool, dns_tool]

ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return utils.tool_dir(opts, tool)


def template(path: str, file: str) -> dict:
    name = f"tools/{path.replace('.', '/')}/{file}"
    target = ROOT / name
    if not target.is_file():
        raise StepError(f"template not found: {name}")
    return {"name": name, "content": target.read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def credential_env(opts: dict, *slot_names: str) -> dict[str, str] | None:
    return tool_env(validate.providers, opts, [*slot_names, "provider-backend"])


# ---------------------------------------------------------------------------
# deterministic JSON — cheshire's bytes, exactly


def _java_double(x: float) -> str:
    """Java's Double.toString, which is what Green's cheshire JSON emits for
    floats: decimal between 1e-3 and 1e7, `d.dddE±e` scientific outside it.
    Python's own repr disagrees exactly where scientific notation starts
    (0.0001 -> "1.0E-4"), and the goldens carry the Java form."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    negative = math.copysign(1.0, x) < 0
    magnitude = abs(x)
    if magnitude == 0.0:
        return "-0.0" if negative else "0.0"
    _sign, digits, exponent = Decimal(repr(magnitude)).as_tuple()
    digit_str = "".join(map(str, digits)).rstrip("0") or "0"
    dec_exp = exponent + len(digits) - 1
    if -3 <= dec_exp < 7:
        if dec_exp >= 0:
            whole = digit_str[:dec_exp + 1].ljust(dec_exp + 1, "0")
            frac = digit_str[dec_exp + 1:] or "0"
        else:
            whole = "0"
            frac = "0" * (-dec_exp - 1) + digit_str
        rendered = f"{whole}.{frac}"
    else:
        mantissa = digit_str[0] + "." + (digit_str[1:] or "0")
        rendered = f"{mantissa}E{dec_exp}"
    return ("-" if negative else "") + rendered


def json_compact(value) -> str:
    """Cheshire's compact printer: no whitespace, floats in Java notation."""
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(json_compact(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(str(k))}:{json_compact(v)}"
                              for k, v in value.items()) + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


def json_pretty(value, indent=0) -> str:
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, (list, tuple)):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(json_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {json_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


# ---------------------------------------------------------------------------
# infrastructure

fallback_outputs = {
    "node_public_ips": ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
    "node_private_ips": ["10.110.0.11", "10.110.0.12", "10.110.0.13"],
    "node_droplet_ids": [100000001, 100000002, 100000003],
    "reserved_ip": "192.0.2.10",
    "vpc_id": "00000000-0000-0000-0000-000000000000",
    "vpc_ip_range": "10.110.0.0/20",
}


def infrastructure_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, infrastructure_tool)
    data = {**opts,
            "node-count": utils.node_count(opts),
            "digitalocean-ssh-sources-json":
            json_compact(opts.get("digitalocean-ssh-sources")),
            "digitalocean-client-sources-json":
            json_compact(opts.get("digitalocean-client-sources"))}
    return [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf", data)]


def _outputs_map(result: dict) -> dict:
    return result.get("mysql-agy/outputs") or {}


async def infrastructure_step(opts: dict) -> dict:
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=tool_dir(opts, infrastructure_tool),
        env=credential_env(opts, "provider-compute"),
        output_key="mysql-agy/outputs")
    if failed(result):
        return result
    if opts.get("blue/event") == "delete":
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_outputs}
    return {**result, **fallback_outputs, **_outputs_map(result)}


def process_result(opts: dict, label: str, result) -> dict:
    if result.exit == 0:
        return {**opts, "blue/exit": 0}
    return {**opts,
            "blue/exit": max(1, result.exit),
            "blue/err": f"{label} failed: {result.err or result.out or '(no output)'}"}


async def load_infrastructure_step(opts: dict) -> dict:
    """Read node addresses out of remote state without planning or changing
    anything."""
    dir = tool_dir(opts, infrastructure_tool)
    rendered = {**scaffold({**opts, "blue/event": "build"}, infrastructure_specs(opts)),
                "blue/event": opts.get("blue/event")}
    # runtime.exec overlays this on the whole process environment, which is the
    # same merge green performs explicitly with System/getenv.
    env = credential_env(opts, "provider-compute")
    init = await runtime.exec(
        ["tofu", f"-chdir={dir}", "init", "-input=false", "-no-color"], env=env)
    if init.exit != 0:
        return process_result(rendered, "infrastructure state initialization", init)
    try:
        outputs = await tofu.outputs(dir, env)
        return {**rendered, **fallback_outputs, **outputs,
                "mysql-agy/infrastructure-present?": "reserved_ip" in outputs}
    except Exception as t:  # noqa: BLE001 — any failure is this stage's outcome
        return {**rendered, "blue/exit": 1,
                "blue/err": f"infrastructure state output failed: {t or type(t).__name__}"}


# ---------------------------------------------------------------------------
# shared template data


def nodes(opts: dict) -> list[dict]:
    """One map per member, in ordinal order, merging desired state with
    infrastructure outputs."""
    data = {**fallback_outputs, **opts}

    def nth(key: str, idx: int):
        values = data.get(key) or []
        return values[idx] if idx < len(values) else None

    return [{"ordinal": ordinal,
             "name": utils.node_name(opts, ordinal),
             "host": utils.node_host(opts, ordinal),
             "public-ip": nth("node_public_ips", ordinal - 1),
             "private-ip": nth("node_private_ips", ordinal - 1),
             "droplet-id": nth("node_droplet_ids", ordinal - 1),
             "server-id": utils.server_id(ordinal),
             "connection-server-id": utils.connection_server_id(ordinal)}
            for ordinal in utils.ordinals(opts)]


def group_seeds(opts: dict) -> str:
    """`group_replication_group_seeds`: every member's private address on the
    group port."""
    return ",".join(f"{node['private-ip']}:{opts.get('mysql-group-port')}"
                    for node in nodes(opts))


def data_fn(opts: dict) -> dict:
    data = {**fallback_outputs, **opts}
    return {**data,
            "node-count": utils.node_count(opts),
            "backup-prefix": utils.backup_prefix(opts),
            "group-seeds": group_seeds(data),
            "cluster-record": utils.record_name(opts.get("cluster-host"))}


def inventory(opts: dict) -> str:
    """Ansible inventory as JSON."""
    data = data_fn(opts)
    key_file = str(data.get("digitalocean-ssh-private-key") or "")
    hosts = {node["name"]: {
        # Sorted the way green's nested sorted-map emits its keys.
        "ansible_host": node["public-ip"],
        "ansible_ssh_private_key_file": key_file,
        "ansible_user": "root",
        "connection_server_id": node["connection-server-id"],
        "droplet_id": node["droplet-id"],
        "node_host": node["host"],
        "node_ordinal": node["ordinal"],
        "private_ip": node["private-ip"],
        "server_id": node["server-id"],
    } for node in nodes(data)}
    sorted_hosts = {name: hosts[name] for name in sorted(hosts)}
    bootstrap_name = utils.node_name(opts, 1)
    return json_pretty(
        {"all": {"children": {
            "mysql": {"hosts": sorted_hosts},
            "bootstrap": {"hosts": ({bootstrap_name: sorted_hosts[bootstrap_name]}
                                    if bootstrap_name in sorted_hosts else {})}}}})


# ---------------------------------------------------------------------------
# dns


def dns_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, dns_tool)
    base = data_fn(opts)
    records = {utils.record_name(node["host"]): node["public-ip"]
               for node in nodes(base)}
    data = {**base,
            "node-records-json":
            json_compact({name: records[name] for name in sorted(records)})}
    return [spec(template("dns", "main.tf"), f"{dir}/main.tf", data)]


async def dns_step(opts: dict) -> dict:
    return await tofu.tofu_with_spec(opts, dns_specs(opts),
                                     dir=tool_dir(opts, dns_tool),
                                     env=credential_env(opts, "provider-dns"),
                                     output_key="mysql-agy/dns-outputs")


# ---------------------------------------------------------------------------
# ansible

_playbooks = ["base.yml", "cluster.yml", "backup.yml", "health.yml", "cleanup.yml"]

_node_files = [
    "mysql-agy-lib", "mysql-agy-endpoint", "mysql-agy-heartbeat", "mysql-agy-snapshot",
    "mysql-agy-binlog-archive", "mysql-agy-binlog-upload", "mysql-agy-restore-check",
    "mysql-agy-health", "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = data_fn(opts)
    return [spec(template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            *[spec(template("ansible", file), f"{dir}/{file}", data)
              for file in _playbooks],
            *[spec(template("ansible.files", file), f"{dir}/files/{file}", data)
              for file in _node_files],
            raw_spec(f"{dir}/inventory.json", inventory(opts))]


def _ansible_config(opts: dict, playbook: str, recap_key: str) -> dict:
    return {"dir": tool_dir(opts, ansible_tool),
            "inventory": "inventory.json",
            "playbooks": {"create": playbook, "delete": playbook},
            "host_key_checking": False,
            "recap_key": recap_key}


def ansible_render_step(opts: dict) -> dict:
    """Render the whole Ansible directory once."""
    return scaffold(opts, ansible_specs(opts))


async def _playbook_step(opts: dict, playbook: str, recap_key: str) -> dict:
    if opts.get("blue/event") == "build":
        return scaffold(opts, ansible_specs(opts))
    return await ansible_step(
        scaffold({**opts, "blue/event": "create"}, ansible_specs(opts)),
        **_ansible_config(opts, playbook, recap_key))


async def base_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "base.yml", "mysql-agy/base-recap")),
            "blue/event": opts.get("blue/event")}


async def cluster_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "cluster.yml", "mysql-agy/cluster-recap")),
            "blue/event": opts.get("blue/event")}


async def backup_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "backup.yml", "mysql-agy/backup-recap")),
            "blue/event": opts.get("blue/event")}


async def health_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "health.yml", "mysql-agy/health-recap")),
            "blue/event": opts.get("blue/event")}


async def cleanup_step(opts: dict) -> dict:
    """Stop the managed units before the droplets are destroyed."""
    if opts.get("mysql-agy/infrastructure-present?") is False:
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        **_ansible_config(opts, "cleanup.yml", "mysql-agy/cleanup-recap"))
