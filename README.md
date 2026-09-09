# mysql-agy

A 3-node MySQL Group Replication high-availability cluster on DigitalOcean with Cloudflare DNS and continuous backup/restore verification to Cloudflare R2.

A tri-colour Package Skill: the canonical Clojure/Babashka implementation lives in `green/`, with byte-identical TypeScript/Bun (`red/`) and Python/uv (`blue/`) ports — `scripts/parity.sh` renders the shared fixture under both state backends through all three and diffs the trees.

## Topology & Architecture

- **Cluster**: 3 homogeneous DigitalOcean droplets running MySQL 8 in Single-Primary Group Replication mode.
- **Failover & VIP**: Dynamic reserved IP endpoint assignment via DigitalOcean API, pointed to by Cloudflare DNS.
- **Backups**:
  - Daily logical snapshots compressed with Zstandard and uploaded to Cloudflare R2.
  - Continuous binary log replication via `mysqlbinlog --stop-never` uploaded every minute.
  - Automated verification drill running in an isolated scratch instance verifying snapshot + PITR replay and lag assertions.
- **Health**: Built-in `./green health` assertions run directly against all cluster members.
- **SSH access**: the deployment owns its machine keypair (the workspace SSH
  Keypair Standard, keygen mode). With no `digitalocean-ssh-keys` in
  `colors.yml`, the first real `create` generates `~/.ssh/<profile>` and
  `~/.ssh/<profile>.pub`, registers the public key at DigitalOcean under the
  profile's name, and `delete` removes the key last, after the droplets are
  gone. Supplying `digitalocean-ssh-keys` (and then
  `digitalocean-ssh-private-key`, the path to its private half) opts out:
  the package uses the listed key ids and touches no key material.
- **`ssh <profile>`**: `create` writes one managed block into `~/.ssh/config`
  with an alias per member — `<profile>` for member one, `<profile>-0`,
  `<profile>-1`, `<profile>-2` — and `delete` removes it before the destroy
  (the workspace SSH Config Standard).

## Development & Usage

From `green/` (or `red/` with `./red`, `blue/` with `./blue`):

```sh
./green build              # render .colors/ — no credentials needed
./green create --dry-run   # walk lifecycle graph safely
./green create             # converge infrastructure and cluster
./green health             # check cluster status and backup health
./green delete             # safely teardown cluster
```

```sh
cd green && bb test && bb golden   # canonical suite and frozen goldens
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh                # three colours, two backends, byte for byte
```

Compute, SSH keys, and R2/S3 remote state now come from the pinned
[colors-compute library](https://github.com/getcolors/colors-compute). The package
declares three peer nodes and its network requirements; the library provisions
shared resources once, fans out node operations, and joins observed outputs for
Ansible. Provider options and credentials follow that library revision. Compatible
provider additions require dependency changes only.

Existing monolithic compute state requires an explicit migration. The library
refuses to adopt it automatically. Managed keys use the profile identity;
external keys require their private identity path. S3 state uses ambient AWS
credentials; R2 state uses `COLORS_PAR_R2_ACCESS_KEY_ID` and
`COLORS_PAR_R2_SECRET_ACCESS_KEY`.

The selected provider must support an application-assigned reserved IP. The
library supplies the endpoint agent, while MySQL retains its primary/read-write
checks. Infrastructure convergence never assigns the endpoint back to a fixed
member.
