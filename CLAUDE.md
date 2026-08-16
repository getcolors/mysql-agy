# CLAUDE.md

Guidance for Claude Code when working in `mysql-agy/`.

## What this repository is

`mysql-agy` is a getcolors Package Skill provisioning a 3-node MySQL Group Replication high-availability cluster on DigitalOcean with Cloudflare DNS and Cloudflare R2 backup & restore verification drills.

## Commands

```sh
bb test              # Run Babashka unit tests
bb golden            # Run golden checks
bb golden:accept     # Accept updated golden fixtures
bb pin               # Stamp launcher with pushed git SHA
./scripts/launcher.sh # Test launcher contract and overrides
./green build        # Render local state
./green create --dry-run
```
