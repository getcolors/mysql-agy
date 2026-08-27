import re

from conftest import CREDENTIALS, fixture
from package_mysql_agy_blue import validate


def without(opts: dict, key: str) -> dict:
    return {k: v for k, v in opts.items() if k != key}


def test_the_fixture_is_renderable():
    assert validate.state_errors(fixture()) == []


def test_every_required_key_is_required():
    for k in validate.own_required:
        assert any(f":{k} is required" in e
                   for e in validate.state_errors(without(fixture(), k))), k


def test_the_profile_parameter_is_refused():
    assert validate.env_errors({}) is None
    assert validate.env_errors({"COLORS_PAR_PROFILE": ""}) is None
    assert validate.env_errors({"COLORS_PAR_PROFILE": "somewhere-else"})


def test_the_node_budget_is_three():
    assert validate.state_errors(fixture({"cluster-nodes": 2}))
    assert validate.state_errors(fixture({"cluster-nodes": 5}))


def test_the_vpc_is_never_desired_state():
    assert validate.state_errors(fixture({"digitalocean-vpc-mode": "managed"}))


def test_the_group_name_must_be_a_uuid():
    assert validate.state_errors(fixture({"mysql-group-name": "mysql-agy"}))
    assert validate.state_errors(
        fixture({"mysql-group-name": "00000000-1111-2222-3333-444444444444"})) == []


def test_the_endpoint_must_live_in_the_managed_zone():
    assert validate.state_errors(fixture({"cluster-host": "my-ha.example.org"}))
    assert validate.state_errors(fixture({"cluster-host": "not a hostname"}))


def test_the_proxy_cannot_carry_mysql():
    assert validate.state_errors(fixture({"cloudflare-proxied": True}))


def test_the_destroy_guard_must_be_a_boolean():
    assert validate.state_errors(fixture({"compute-prevent-destroy": "true"}))


def test_backups_may_not_share_the_state_bucket():
    assert validate.state_errors(
        fixture({"backup-r2-bucket": fixture()["r2-bucket"]}))


def test_source_lists_must_be_cidrs():
    assert validate.state_errors(fixture({"digitalocean-ssh-sources": []}))
    assert validate.state_errors(
        fixture({"digitalocean-client-sources": ["203.0.113.7"]}))
    assert validate.state_errors(
        fixture({"digitalocean-ssh-sources": "203.0.113.7/32"}))


def test_schedules_and_durations_are_checked():
    assert validate.state_errors(fixture({"heartbeat-interval": "often"}))
    assert validate.state_errors(
        fixture({"backup-snapshot-oncalendar": "daily at one"}))
    assert validate.state_errors(
        fixture({"mysql-innodb-buffer-pool-size": "lots"}))


def test_the_group_port_cannot_be_the_client_port():
    assert validate.state_errors(fixture({"mysql-group-port": 3306}))


def test_a_real_run_needs_exactly_the_credentials_the_design_allows():
    errors = validate.secret_errors(fixture({"blue/event": "create"}))
    names = {m.group(1) for e in errors
             if (m := re.search(r"(COLORS_PAR_\S+)", e))}
    # The package must not invent a credential beyond the two it is given.
    assert names == {"COLORS_PAR_MYSQL_ADMIN_PASSWORD",
                     "COLORS_PAR_MYSQL_REPLICATION_PASSWORD",
                     "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID",
                     "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY",
                     "COLORS_PAR_DO_TOKEN",
                     "COLORS_PAR_CLOUDFLARE_API_TOKEN"}


def test_health_needs_no_database_credential():
    errors = validate.secret_errors(fixture({"blue/event": "health"}))
    assert not any("MYSQL" in e for e in errors)
    assert any("DO_TOKEN" in e for e in errors)


def test_supplied_credentials_are_not_reported_missing():
    assert validate.secret_errors(
        fixture({"blue/event": "create", **CREDENTIALS})) == []


def test_only_the_providers_this_package_implements_are_accepted():
    assert validate.state_errors(fixture({"provider-compute": "hcloud"}))
    assert validate.state_errors(fixture({"provider-dns": "yandex"}))
    assert validate.state_errors(fixture({"provider-backend": "local"})) == []
