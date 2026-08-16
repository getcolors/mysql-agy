# MySQL HA Benchmark Log (`mysql-agy`)

Evaluator: Gemini 3.7 Flash autonomous coding agent
Target: 3-node MySQL Group Replication on DigitalOcean (`ams3`, `s-2vcpu-4gb`, `ubuntu-24-04-x64`) with Cloudflare R2 backup & restore verification drill and Cloudflare DNS management.

---

## Phase Log

### Phase 1: Design & Architecture
- **Started**: `2026-08-16T12:15:02+02:00`
- **Completed**: `2026-08-16T12:15:30+02:00`
- **Architecture Design**:
  - **Topology**: 3-node MySQL 8.0 Group Replication cluster in Single-Primary mode with automatic failover.
  - **Infrastructure**: OpenTofu stages for DigitalOcean droplets (3x `s-2vcpu-4gb` in `ams3`), VPC networking, droplet tags, Cloudflare DNS record pointing `mysql-agy.bigconfig.online` to primary droplet via reserved IP.
  - **Security & Networking**: Private droplet networking within DO VPC, MySQL Group Replication communication on port 33061, client access on port 3306 restricted by firewall.
  - **Backup & Recovery**:
    - Daily snapshot via consistent snapshot (`mysqldump` with `--single-transaction --set-gtid-purged=ON`) compressed with Zstandard and uploaded to Cloudflare R2 bucket `mysql-agy-backup`.
    - Continuous binlog streaming / archive to R2 using `mysqlbinlog --read-from-remote-server --stop-never --raw`.
    - Verified restore drill: systemd timer running automated restore from R2 into an isolated scratch instance, verifying GTID coverage, point-in-time replay advances, and max lag SLA.
  - **Cadence & Monitoring**: Systemd heartbeat service recording cluster status and metrics.

### Phase 2: Package Scaffold & Implementation
- **Started**: `2026-08-16T12:15:30+02:00`
- **Completed**: `2026-08-16T12:18:50+02:00`
- **Scaffold & Implementation**:
  - Implemented Clojure namespaces: `io.github.getcolors.mysql-agy.utils`, `validate`, `tools`, `workflow`.
  - Implemented OpenTofu templates (`infrastructure/main.tf`, `dns/main.tf`).
  - Implemented Ansible playbooks (`base.yml`, `cluster.yml`, `backup.yml`, `health.yml`, `cleanup.yml`) and node agent files (`mysql-agy-lib`, `mysql-agy-endpoint`, `mysql-agy-heartbeat`, `mysql-agy-snapshot`, `mysql-agy-binlog-archive`, `mysql-agy-binlog-upload`, `mysql-agy-restore-check`, `mysql-agy-health`, `mysqld.cnf`, `verify.cnf`, `apparmor-local`, `node.env`).
  - Implemented launcher (`skills/package-mysql-agy-green/green`) and pin task (`tasks/pin.clj`).
  - Implemented Babashka test suite and golden checks.
- **Errors Encountered & Fixed in Phase 2**:
  - *Error*: Initial test fixture `test/fixtures/colors.yml` had `provider-backend: r2` causing unit tests to expect R2 credentials during mock runs.
  - *Fix*: Updated test fixture to `provider-backend: local` matching conventional unit test fixtures.
  - *Error*: Golden script `build r2` was missing `COLORS_PAR_PROVIDER_BACKEND=r2`.
  - *Fix*: Added `COLORS_PAR_PROVIDER_BACKEND=r2` to `scripts/golden.sh`.

### Phase 3: Validation & Dry-Run
- **Started**: `2026-08-16T12:18:50+02:00`
- **Completed**: `2026-08-16T12:19:40+02:00`
- **Validation Results**:
  - `bb test`: Passed (38 tests, 139 assertions, 0 failures, 0 errors).
  - `bb golden`: Passed byte-for-byte against local and r2 golden targets.
  - `./scripts/launcher.sh`: Passed all 7 launcher contract and dispatch checks.
  - `./green build` & `./green create --dry-run` in deployment repo: Clean execution in credential-free environment.

### Phase 4: Git & Pinning
- **Started**: `2026-08-16T12:19:45+02:00`
- **Completed**: `2026-08-16T12:20:20+02:00`
- **Git & Pinning Summary**:
  - Created public GitHub repositories: `getcolors/mysql-agy` and `getcolors/mysql-agy-digitalocean`.
  - Initialized git repositories, committed, and pushed main branches.
  - Executed `bb pin` to stamp launcher with immutable commit SHA `ae642657619a788d42971dd75c568832f6d768a4`.
  - Pushed stamped launcher to `getcolors/mysql-agy`.
  - Synchronized launcher to `mysql-agy-digitalocean` (`.agents/skills/package-mysql-agy-green/green` and `./green`), verified byte-identical with `cmp`.
  - Committed and pushed `mysql-agy-digitalocean` to GitHub.

### Phase 5: Real Deployment & Acceptance
- **Started**: `2026-08-16T12:20:25+02:00`
- **Completed**: `2026-08-16T12:33:30+02:00`
- **Attempt History & Errors Fixed**:
  - **Attempt 1 (`2026-08-16T12:20:29+02:00`)**:
    - *Error*: OpenTofu provisioned 3 droplets and DNS successfully. Ansible `base.yml` failed with `The 'community.general.yaml' callback plugin has been removed`.
    - *Fix*: Updated `ansible.cfg` to remove legacy `stdout_callback = yaml`, added `interpreter_python = auto_silent`.
  - **Attempt 2 (`2026-08-16T12:21:42+02:00`)**:
    - *Error*: MySQL base configuration and Group Replication cluster formed successfully across all 3 nodes. Snapshot published to R2. In `restore-check`, `mysqld --initialize-insecure` failed with error `Can't generate a unique log-filename /var/lib/mysql-agy/verify/binlog.(1-999)`.
    - *Investigation*: Kernel audit logs showed AppArmor denied directory read on `/var/lib/mysql-agy/verify/`.
    - *Fix*: Updated `apparmor-local` to include `/var/lib/mysql-agy/verify/ r,` and `/etc/mysql-agy/ r,` rules.
  - **Attempt 3 (`2026-08-16T12:27:38+02:00`)**:
    - *Error*: On rerun against already running cluster, `cluster.yml` attempted `CREATE USER` / `ALTER USER` on secondary nodes where `super_read_only = ON`.
    - *Fix*: Added `when: gr_online.stdout | trim == '0'` guard to account creation tasks in `cluster.yml` for idempotency on existing clusters.
  - **Attempt 4 (`2026-08-16T12:28:54+02:00` - `2026-08-16T12:33:04+02:00`)**:
    - *Result*: **Converged with exit code 0!**
    - All stages completed: infrastructure, DNS, base configuration, Group Replication cluster, R2 snapshots, PITR binary log streaming, verified restore drill in isolated scratch instance, and full health checks.

---

## Objective Verification & Metrics

- **Cluster Topology**:
  - Node 1 (`mysql-agy-node-1`): `159.223.238.163` (Private: `10.110.0.3`) — ONLINE (PRIMARY)
  - Node 2 (`mysql-agy-node-2`): `165.22.84.184` (Private: `10.110.0.2`) — ONLINE (SECONDARY)
  - Node 3 (`mysql-agy-node-3`): `165.22.84.185` (Private: `10.110.0.4`) — ONLINE (SECONDARY)
- **VIP & DNS Endpoint**:
  - Reserved IP: `178.128.139.24` (assigned to primary droplet `592790793` / `mysql-agy-node-1`)
  - Cloudflare DNS FQDN: `mysql-agy.bigconfig.online` -> resolves to `178.128.139.24`
- **Replication Health**:
  - Group Replication Status: 3 of 3 members ONLINE
  - Heartbeat cadence: Active every 10s (current lag: 2s)
  - Remote transactions streaming: 109+ proposed on Primary, applied on Secondaries with 0 queued
- **Backup & Point-in-Time Recovery**:
  - Cloudflare R2 Bucket: `mysql-agy-backup` (`eu` jurisdiction)
  - Snapshot: `20260816T103108Z` dump uploaded with sha256 checksum and metadata
  - Continuous Binary Log Streaming: Active (`binlog.*` continuous replication to R2)
  - Verified Restore Drill: Passed (restored snapshot `20260816T103108Z`, replayed archived binlogs, confirmed GTID coverage, verified heartbeat rows advance, lag within budget)
- **Client Connectivity**:
  - Direct MySQL client query to `mysql-agy.bigconfig.online:3306` successfully queried `mysql_agy.heartbeat` and `mysql_agy.beat_log`.
