"""Provider registry and desired-state validation rules — the port of
io.github.getcolors.mysql-agy.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue import providers as provider_ops
from blue.cli import par_name

from . import utils

# Provider slot -> provider name -> what that choice implies.
providers = {
    "provider-compute": {
        "digitalocean": {
            "required": ["digitalocean-name", "digitalocean-region",
                         "digitalocean-size", "digitalocean-image",
                         "digitalocean-ssh-keys", "digitalocean-vpc-mode"],
            "secrets": ["do-token"],
            "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
        },
    },

    "provider-dns": {
        "cloudflare": {
            "required": ["cloudflare-zone"],
            "secrets": ["cloudflare-api-token"],
            "tofu-env": {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"},
        },
    },

    "provider-backend": {
        "local": {"required": [], "secrets": [], "tofu-env": {}},
        "s3": {"required": ["s3-bucket", "s3-region"], "secrets": [], "tofu-env": {}},
        "r2": {
            "required": ["r2-bucket", "r2-endpoint"],
            "secrets": ["r2-access-key-id", "r2-secret-access-key"],
            "tofu-env": {"r2-access-key-id": "AWS_ACCESS_KEY_ID",
                         "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY"},
        },
    },
}

slots = ["provider-compute", "provider-dns", "provider-backend"]

own_required = [
    "profile", "workdir",
    "cluster-host", "cluster-nodes",
    "digitalocean-ssh-private-key", "digitalocean-ssh-sources",
    "digitalocean-client-sources",
    "cloudflare-proxied",
    "mysql-port", "mysql-group-port", "mysql-group-name",
    "mysql-admin-user", "mysql-replication-user",
    "mysql-innodb-buffer-pool-size",
    "backup-r2-bucket", "backup-r2-endpoint", "backup-r2-region", "backup-r2-prefix",
    "backup-snapshot-oncalendar", "backup-restore-check-oncalendar",
    "backup-binlog-upload-interval", "backup-retention-days",
    "backup-restore-max-lag-seconds",
    "heartbeat-interval", "endpoint-poll-interval",
]

own_secrets = [
    "mysql-admin-password", "mysql-replication-password",
    "backup-r2-access-key-id", "backup-r2-secret-access-key",
]


def placeholder(x: object) -> bool:
    return provider_ops.placeholder(x)


profile_par = par_name("profile")


def env_errors(env: dict) -> list[str] | None:
    """`COLORS_PAR_PROFILE` keys this deployment's remote state. Overlaying it
    can only point one deployment at another's, so it is refused rather than
    honoured."""
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set. mysql-agy takes profile from colors.yml only."]
    return None


def _slot_keys(opts: dict, field: str) -> list[str]:
    return provider_ops.slot_keys(providers, opts, slots, field)


def _missing(opts: dict, keys: list[str]) -> list[str]:
    return provider_ops.missing_keys(opts, keys)


host_re = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
uuid_re = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
cidr_re = re.compile(r"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}/[0-9]{1,2}$")
buffer_pool_re = re.compile(r"^[0-9]+[KMG]$")
oncalendar_re = re.compile(r"^[-*0-9]+-[-*0-9]+-[-*0-9]+ [:0-9*/]+$")


def _positive_int(x: object) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _pr_str(value: object) -> str:
    """pr-str, for messages that print an offending value the way green does:
    strings are quoted, nil renders bare, booleans render lowercase."""
    if value is None:
        return "nil"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return str(value)


def _cidr_list_errors(opts: dict, k: str) -> list[str]:
    v = opts.get(k)
    if placeholder(v):
        return []
    if not isinstance(v, (list, tuple)):
        return [f":{k} must be a list of CIDRs"]
    if len(v) == 0:
        return [f":{k} must list at least one CIDR"]
    return [f":{k} entry {_pr_str(c)} is not a CIDR"
            for c in v
            if not cidr_re.fullmatch("" if c is None else str(c))]


def state_errors(opts: dict) -> list[str]:
    """Validates desired state."""
    errors: list[str] = []
    for k in _missing(opts, [*own_required, *_slot_keys(opts, "required")]):
        errors.append(f":{k} is required")
    for slot in slots:
        if provider_ops.entry(providers, opts, slot) is None:
            errors.append(f"unsupported :{slot} {_pr_str(opts.get(slot))}")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    if not isinstance(opts.get("cloudflare-proxied"), bool):
        errors.append(":cloudflare-proxied must be true or false")
    if opts.get("cloudflare-proxied") is True:
        errors.append(":cloudflare-proxied must be false; Cloudflare's proxy does not carry the MySQL protocol")
    if not (placeholder(opts.get("cluster-host"))
            or host_re.fullmatch(str(opts.get("cluster-host")))):
        errors.append(":cluster-host must be a fully qualified hostname")
    if not (placeholder(opts.get("cluster-host"))
            or placeholder(opts.get("cloudflare-zone"))
            or str(opts.get("cluster-host")).endswith("." + str(opts.get("cloudflare-zone")))):
        errors.append(":cluster-host must sit inside :cloudflare-zone")
    if opts.get("cluster-nodes") != 3:
        errors.append(":cluster-nodes must be 3; a Group Replication majority needs an odd group and the budget is three droplets")
    if opts.get("digitalocean-vpc-mode") != "default":
        errors.append(":digitalocean-vpc-mode must be default; the VPC is discovered at run time and is never desired state")
    if not (placeholder(opts.get("mysql-group-name"))
            or uuid_re.fullmatch(str(opts.get("mysql-group-name")))):
        errors.append(":mysql-group-name must be a UUID; MySQL rejects anything else as a group name")
    for k in ["mysql-port", "mysql-group-port", "backup-retention-days",
              "backup-restore-max-lag-seconds"]:
        if not _positive_int(opts.get(k)):
            errors.append(f":{k} must be a positive integer")
    if opts.get("mysql-port") == opts.get("mysql-group-port"):
        errors.append(":mysql-group-port must differ from :mysql-port")
    if not (placeholder(opts.get("mysql-innodb-buffer-pool-size"))
            or buffer_pool_re.fullmatch(str(opts.get("mysql-innodb-buffer-pool-size")))):
        errors.append(":mysql-innodb-buffer-pool-size must be a size such as 1G")
    for k in ["heartbeat-interval", "endpoint-poll-interval",
              "backup-binlog-upload-interval"]:
        if not placeholder(opts.get(k)) and not utils.duration(opts.get(k)):
            errors.append(f":{k} must be a systemd duration such as 10s or 1min")
    for k in ["backup-snapshot-oncalendar", "backup-restore-check-oncalendar"]:
        if not placeholder(opts.get(k)) and not oncalendar_re.fullmatch(str(opts.get(k))):
            errors.append(f":{k} must be a systemd OnCalendar expression such as *-*-* 01:00:00")
    if (not placeholder(opts.get("backup-r2-bucket"))
            and not placeholder(opts.get("r2-bucket"))
            and str(opts.get("backup-r2-bucket")) == str(opts.get("r2-bucket"))):
        errors.append(":backup-r2-bucket must not be the state bucket")
    errors.extend(_cidr_list_errors(opts, "digitalocean-ssh-sources"))
    errors.extend(_cidr_list_errors(opts, "digitalocean-client-sources"))
    return errors


def secret_errors(opts: dict) -> list[str]:
    """Credentials a real run needs that no `COLORS_PAR_*` variable supplied."""
    keys = (_slot_keys(opts, "secrets")
            if opts.get("blue/event") == "health"
            else [*_slot_keys(opts, "secrets"), *own_secrets])
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(_missing(opts, keys))]
