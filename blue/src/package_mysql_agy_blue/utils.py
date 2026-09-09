"""Launcher contract, node topology, and shared derivations — the port of
io.github.getcolors.mysql-agy.utils."""

from __future__ import annotations

import re

from blue.cli import stage_dir

# Minimum mysql-agy contract a standalone launcher must find.
CONTRACT = 1


def node_count(opts: dict) -> int:
    n = opts.get("cluster-nodes")
    return n if isinstance(n, int) and not isinstance(n, bool) else 3


def ordinals(opts: dict) -> list[int]:
    return list(range(1, node_count(opts) + 1))


def server_id(ordinal: int) -> int:
    """MySQL server_id derived from the ordinal."""
    return 100 + ordinal


def connection_server_id(ordinal: int) -> int:
    """The pseudo-replica id mysqlbinlog registers with."""
    return 200 + ordinal


def node_host(opts: dict, ordinal: int) -> str:
    """Per-member administrative FQDN."""
    host = opts.get("cluster-host")
    return f"node-{ordinal}.{'' if host is None else host}"


def record_name(host: object) -> str:
    """Cloudflare DNS record name without trailing dot."""
    return re.sub(r"\.$", "", "" if host is None else str(host))


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="mysql-agy")


def backup_prefix(opts: dict) -> str:
    """Object-key prefix inside the backup bucket, without trailing slashes."""
    prefix = opts.get("backup-r2-prefix")
    return re.sub(r"/+$", "", "" if prefix is None else str(prefix))


_DURATION_RE = re.compile(r"^[0-9]+(?:ms|s|m|h|min|d)$")


def duration(x: object) -> bool:
    return isinstance(x, str) and bool(_DURATION_RE.fullmatch(x))
