---
name: package-mysql-agy-blue
description: A 3-node MySQL Group Replication high-availability cluster with continuous point-in-time recovery to Cloudflare R2.
---

# package-mysql-agy-blue

Provisions and manages a 3-node MySQL Group Replication HA cluster with Cloudflare DNS and continuous backup/restore verification to Cloudflare R2.

Compute, SSH keys, and remote state are supplied by the pinned
[colors-compute library](https://github.com/getcolors/colors-compute). Select a
provider supported by that revision and configure its options and credentials.
The package supplies three peer nodes and application network requirements;
the library joins observed node addresses and SSH users for Ansible.

Use `provider-backend: r2` or `s3`. R2 requires
`COLORS_PAR_R2_ACCESS_KEY_ID` and `COLORS_PAR_R2_SECRET_ACCESS_KEY`; S3 uses
the ambient AWS credential chain. The library owns managed profile keys, or
uses configured external keys with `ssh-private-key-path`. Existing monolithic
compute state requires explicit migration and is refused by this lifecycle.

This package also requires the library capability for an application-assigned
reserved IP. The library supplies the endpoint agent; MySQL decides when a
member is eligible to claim the address.
