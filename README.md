# mysql-agy

A 3-node MySQL Group Replication high-availability cluster on DigitalOcean with Cloudflare DNS and continuous backup/restore verification to Cloudflare R2.

## Topology & Architecture

- **Cluster**: 3 homogeneous DigitalOcean droplets running MySQL 8 in Single-Primary Group Replication mode.
- **Failover & VIP**: Dynamic reserved IP endpoint assignment via DigitalOcean API, pointed to by Cloudflare DNS.
- **Backups**:
  - Daily logical snapshots compressed with Zstandard and uploaded to Cloudflare R2.
  - Continuous binary log replication via `mysqlbinlog --stop-never` uploaded every minute.
  - Automated verification drill running in an isolated scratch instance verifying snapshot + PITR replay and lag assertions.
- **Health**: Built-in `./green health` assertions run directly against all cluster members.

## Development & Usage

```sh
./green build              # render .colors/ — no credentials needed
./green create --dry-run   # walk lifecycle graph safely
./green create             # converge infrastructure and cluster
./green health             # check cluster status and backup health
./green delete             # safely teardown cluster
```
