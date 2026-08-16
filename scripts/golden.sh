#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
state="$root/test/fixtures/colors.yml"
goldens="$root/test/resources/golden"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
accept=0
[ "${1:-}" = --accept ] && accept=1

build() {
  local variant=$1
  shift
  (cd "$root" && env MYSQL_AGY_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/$variant" "$@" \
    ./green build -f "$state" >/dev/null)
  if [ "$accept" = 1 ]; then
    rm -rf "$goldens/$variant"
    mkdir -p "$goldens/$variant"
    cp -r "$tmp/$variant/." "$goldens/$variant/"
    echo "  accepted — $variant"
  else
    diff -qr "$goldens/$variant" "$tmp/$variant"
    echo "  ok — $variant"
  fi
}

build local COLORS_PAR_PROVIDER_BACKEND=local
build r2 COLORS_PAR_PROVIDER_BACKEND=r2

base="$tmp/local/mysql-agy-fixture"
for stage in mysql-agy-infrastructure mysql-agy-dns mysql-agy-ansible; do
  [ -d "$base/$stage" ] || { echo "golden: missing stage $stage" >&2; exit 1; }
done

infra="$base/mysql-agy-infrastructure/main.tf"
grep -q 'resource "digitalocean_droplet" "node"' "$infra"
grep -q 'resource "digitalocean_reserved_ip" "endpoint"' "$infra"
grep -q 'resource "digitalocean_firewall" "cluster"' "$infra"
grep -q 'output "node_public_ips"' "$infra"
grep -q 'output "reserved_ip"' "$infra"
grep -q 'source_addresses = local.client_sources' "$infra"
grep -q '203.0.113.10/32' "$infra"
grep -q '203.0.113.0/24' "$infra"
[ "$(grep -c 'prevent_destroy = true' "$infra")" -ge 3 ] || {
  echo 'golden: deployment-owned infrastructure lost prevent_destroy' >&2; exit 1
}

grep -q 'mysql-agy-fixture/mysql-agy-infrastructure.tfstate' \
  "$tmp/r2/mysql-agy-fixture/mysql-agy-infrastructure/backend.tf.json"

dns="$base/mysql-agy-dns/main.tf"
grep -q 'resource "cloudflare_dns_record" "cluster"' "$dns"
grep -q 'resource "cloudflare_dns_record" "node"' "$dns"

ansible="$base/mysql-agy-ansible"
for file in ansible.cfg base.yml cluster.yml backup.yml health.yml cleanup.yml inventory.json; do
  [ -f "$ansible/$file" ] || { echo "golden: missing playbook $file" >&2; exit 1; }
done

for file in mysqld.cnf verify.cnf apparmor-local node.env mysql-agy-lib mysql-agy-endpoint mysql-agy-heartbeat mysql-agy-snapshot mysql-agy-binlog-archive mysql-agy-binlog-upload mysql-agy-restore-check mysql-agy-health; do
  [ -f "$ansible/files/$file" ] || { echo "golden: missing node file $file" >&2; exit 1; }
done

grep -q 'no_log: true' "$ansible/cluster.yml"
grep -q 'no_log: true' "$ansible/backup.yml"

if grep -rEq 'client-certificate-data|client-key-data|BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|REPLACE_ME|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$tmp"; then
  echo 'golden: credential-shaped material was rendered' >&2; exit 1
fi

echo 'all mysql-agy goldens and safety assertions pass'
