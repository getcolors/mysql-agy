import re
from pathlib import Path

from blue.cli import run_cli
from conftest import CREDENTIALS, ROOT, fixture
from package_mysql_agy_blue import tools, workflow

CREATE = {"blue/event": "create"}
BUILD = {"blue/event": "build"}
DELETE = {"blue/event": "delete"}
HEALTH = {"blue/event": "health"}


def nexts(step: str, run_opts: dict) -> list[str]:
    decl = workflow.wire_fn(step, run_opts)
    return list(decl[1:]) if decl else []


def test_create_forks_at_the_infrastructure_and_joins_at_the_cluster():
    assert nexts("mysql-agy/start", CREATE) == ["mysql-agy/infrastructure"]
    assert nexts("mysql-agy/infrastructure", CREATE) == \
        ["mysql-agy/dns", "mysql-agy/base"]
    # Both branches converge on one step, so the engine joins them once.
    assert nexts("mysql-agy/dns", CREATE) == ["mysql-agy/cluster"]
    assert nexts("mysql-agy/base", CREATE) == ["mysql-agy/cluster"]
    assert nexts("mysql-agy/cluster", CREATE) == ["mysql-agy/backup"]
    assert nexts("mysql-agy/backup", CREATE) == ["mysql-agy/health"]
    assert nexts("mysql-agy/health", CREATE) == []


def test_build_walks_the_same_graph_as_create():
    for step in ["mysql-agy/start", "mysql-agy/infrastructure", "mysql-agy/dns",
                 "mysql-agy/base", "mysql-agy/cluster", "mysql-agy/backup"]:
        assert nexts(step, BUILD) == nexts(step, CREATE)


def test_delete_reads_state_first_and_destroys_in_reverse():
    assert nexts("mysql-agy/start", DELETE) == ["mysql-agy/load-infrastructure"]
    assert nexts("mysql-agy/load-infrastructure", DELETE) == ["mysql-agy/cleanup"]
    assert nexts("mysql-agy/cleanup", DELETE) == ["mysql-agy/dns"]
    assert nexts("mysql-agy/dns", DELETE) == ["mysql-agy/infrastructure"]
    assert nexts("mysql-agy/infrastructure", DELETE) == []


def test_health_changes_nothing():
    assert nexts("mysql-agy/start", HEALTH) == ["mysql-agy/load-infrastructure"]
    assert nexts("mysql-agy/load-infrastructure", HEALTH) == ["mysql-agy/health"]
    assert workflow.wire_fn("mysql-agy/health", HEALTH)[0] is tools.health_step
    # No stage that converges anything is reachable from health.
    for decl in [workflow.wire_fn("mysql-agy/load-infrastructure", HEALTH),
                 workflow.wire_fn("mysql-agy/health", HEALTH)]:
        assert decl[0] not in (tools.infrastructure_step, tools.dns_step,
                               tools.cluster_step)


async def test_a_build_needs_no_credential():
    result = await workflow.start_step(fixture({"blue/event": "build"}), {})
    assert result["blue/exit"] == 0


async def test_a_real_run_refuses_without_credentials():
    result = await workflow.start_step(fixture({"blue/event": "create"}), {})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_MYSQL_ADMIN_PASSWORD" in result["blue/err"]


async def test_a_dry_run_needs_no_credential():
    result = await workflow.start_step(
        fixture({"blue/event": "create", "blue/dry-run": True}), {})
    assert result["blue/exit"] == 0


async def test_the_profile_parameter_is_refused_before_anything_else():
    result = await workflow.start_step(fixture({"blue/event": "build"}),
                                       {"COLORS_PAR_PROFILE": "elsewhere"})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_PROFILE" in result["blue/err"]


async def test_the_destroy_guard_holds():
    result = await workflow.start_step(
        fixture({"blue/event": "delete", **CREDENTIALS}), {})
    assert result["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in result["blue/err"]
    # And lifts for exactly one run.
    lifted = await workflow.start_step(
        fixture({"blue/event": "delete", "compute-prevent-destroy": False,
                 **CREDENTIALS}), {})
    assert lifted["blue/exit"] == 0


def test_defaults_do_not_quietly_permit_destruction():
    assert workflow.DEFAULTS["compute-prevent-destroy"] is True


def test_every_side_effecting_step_is_skipped_by_dry_run():
    for event in ["create", "delete", "health"]:
        wired = [step for step in workflow.side_effecting
                 if workflow.wire_fn(step, {"blue/event": event})]
        assert all(step in workflow.side_effecting for step in wired)


async def test_a_whole_build_renders_every_stage():
    state = ROOT / "test" / "fixtures" / "colors.yml"
    result = await run_cli(workflow.mysql_agy_workflow, ["build", "-f", str(state)])
    assert result["blue/exit"] == 0
    root = ROOT / "test" / "fixtures" / ".colors" / "mysql-agy-fixture"
    for stage in ["mysql-agy-infrastructure", "mysql-agy-dns", "mysql-agy-ansible"]:
        assert (root / stage).is_dir(), stage
    # The backend is written by advice, before the stage runs.
    assert (root / "mysql-agy-infrastructure" / "backend.tf.json").is_file()
    assert (root / "mysql-agy-dns" / "backend.tf.json").is_file()
    # Nothing that looks like a credential is written.
    for file in [p for p in root.rglob("*") if p.is_file()]:
        assert not re.search(r"REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY",
                             file.read_text()), file
