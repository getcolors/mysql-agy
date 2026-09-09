from pathlib import Path

from blue.cli import load_yaml

ROOT = Path(__file__).resolve().parents[2]

CREDENTIALS = {
    "mysql-admin-password": "a",
    "mysql-replication-password": "b",
    "backup-r2-access-key-id": "c",
    "backup-r2-secret-access-key": "d",
    "do-token": "e",
    "cloudflare-api-token": "f",
}


def _load(name: str, overrides: dict | None = None) -> dict:
    text = (ROOT / "test" / "fixtures" / name).read_text()
    return {**load_yaml(text), "provider-backend": "r2", "blue/event": "build", **(overrides or {})}


def fixture(overrides: dict | None = None) -> dict:
    return _load("colors.yml", overrides)


def optout(overrides: dict | None = None) -> dict:
    return _load("optout.yml", overrides)
