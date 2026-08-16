# MySQL HA Benchmark Log (`mysql-agy`)

Evaluator: Gemini 3.7 Flash autonomous coding agent
Target: 3-node MySQL Group Replication on DigitalOcean (`ams3`, `s-2vcpu-4gb`, `ubuntu-24-04-x64`) with Cloudflare R2 backup & restore verification drill and Cloudflare DNS management.

---

## Phase Log

### Phase 1: Design & Architecture
- **Started**: `2026-08-16T12:15:02+02:00`
- **Completed**: `2026-08-16T12:15:30+02:00`
- **Architecture Design**:
  - **Topology**: 3-node MySQL 8.0/8.4 Group Replication cluster in Single-Primary mode with automatic failover.
  - **Infrastructure**: OpenTofu stages for DigitalOcean droplets (3x `s-2vcpu-4gb` in `ams3`), VPC networking, droplet tags, Cloudflare DNS record pointing `mysql-agy.bigconfig.online` to primary droplet.
  - **Security & Networking**: Private droplet networking within DO VPC, MySQL Group Replication communication on port 33061, client access on port 3306 restricted by firewall.
  - **Backup & Recovery**:
    - Daily snapshot via consistent snapshot uploaded to Cloudflare R2 bucket `mysql-agy-backup`.
    - Continuous binlog streaming / archive to R2.
    - Verified restore drill: systemd timer running automated restore from R2 into a temporary/scratch datadir or scratch instance, verifying table checksums and data integrity.
  - **Cadence & Monitoring**: Systemd heartbeat service recording cluster status and metrics.

### Phase 2: Package Scaffold & Implementation
- **Started**: `2026-08-16T12:15:30+02:00`
- **Completed**: `2026-08-16T12:18:50+02:00`
- **Scaffold & Tests**:
  - Implemented Clojure namespaces: `io.github.getcolors.mysql-agy.utils`, `validate`, `tools`, `workflow`.
  - Implemented OpenTofu templates (`infrastructure/main.tf`, `dns/main.tf`).
  - Implemented Ansible playbooks (`base.yml`, `cluster.yml`, `backup.yml`, `health.yml`, `cleanup.yml`) and scripts (`mysql-agy-lib`, `mysql-agy-endpoint`, `mysql-agy-heartbeat`, `mysql-agy-snapshot`, `mysql-agy-binlog-archive`, `mysql-agy-binlog-upload`, `mysql-agy-restore-check`, `mysql-agy-health`, `mysqld.cnf`, `verify.cnf`, `apparmor-local`, `node.env`).
  - Implemented launcher (`skills/package-mysql-agy-green/green`) and pin task (`tasks/pin.clj`).
  - Implemented Babashka test suite and golden checks.
  - Fixed fixture test provider backend configuration.

### Phase 3: Validation & Dry-Run
- **Started**: `2026-08-16T12:18:50+02:00`
- **Completed**: `2026-08-16T12:19:40+02:00`
- **Validation**:
  - `bb test`: Passed (38 tests, 139 assertions, 0 failures, 0 errors).
  - `bb golden`: Passed byte-for-byte against local and r2 golden targets.
  - `./scripts/launcher.sh`: Passed all 7 launcher contract and dispatch checks.
  - `./green build` & `./green create --dry-run` in deployment repo: Clean execution in credential-free environment.

### Phase 4: Git & Pinning
- **Started**: `2026-08-16T12:19:45+02:00`
