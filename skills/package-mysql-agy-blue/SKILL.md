---
name: package-mysql-agy-blue
description: A 3-node MySQL Group Replication high-availability cluster on DigitalOcean with continuous point-in-time recovery to Cloudflare R2.
---

# package-mysql-agy-blue

Provisions and manages a 3-node MySQL Group Replication HA cluster on DigitalOcean with Cloudflare DNS and continuous backup/restore verification to Cloudflare R2.

The deployment owns its SSH keypair (keygen mode: leave `digitalocean-ssh-keys` out of `colors.yml`; the first real `create` generates `~/.ssh/<profile>` and registers it at DigitalOcean, and `delete` removes it last) and writes one `~/.ssh/config` block so that `ssh <profile>`, `ssh <profile>-0`, `-1` and `-2` reach the members. Supplying `digitalocean-ssh-keys` and `digitalocean-ssh-private-key` opts out and uses the operator's own key untouched.
