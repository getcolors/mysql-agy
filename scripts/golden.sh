#!/usr/bin/env bash
set -euo pipefail

# Green's regression net against the committed goldens: render every fixture
# under both state backends and diff against committed output. scripts/parity.sh
# is the net across colours.
#
# Two fixtures, because the SSH Keypair Standard has two modes and a package
# conforms only if both hold. `colors.yml` is keygen mode (no
# digitalocean-ssh-keys): the compute template must declare the profile-named
# digitalocean_ssh_key resource and reference it by attribute, and the local
# stage must name the generated key. `optout.yml` supplies an explicit key id
# and must create nothing — its rendering is byte-for-byte what the package
# rendered before the standard, under its own profile.
#
# Two backends, because the goldens have a second axis: each fixture is
# rendered under the local state backend and again under r2 by overlaying
# COLORS_PAR_PROVIDER_BACKEND=r2 on the same file; the trees differ only in
# every stage's backend.tf.json.
#
# Keygen paths are rendered from a fixed placeholder home on build, never from
# $HOME, so these goldens mean the same thing on every workstation.
#
#   ./scripts/golden.sh            check
#   ./scripts/golden.sh --accept   regenerate after an intended change

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
goldens="$root/test/resources/golden"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
accept=0
[ "${1:-}" = --accept ] && accept=1
status=0

build() {
  local fixture=$1 backend=$2
  local state="$root/test/fixtures/$fixture.yml"
  local profile
  profile=$(sed -n 's/^profile: //p' "$state")
  (cd "$root/green" && env MYSQL_AGY_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/$backend-$fixture" \
    COLORS_PAR_PROVIDER_BACKEND="$backend" ./green build -f "$state" >/dev/null)
  local actual="$tmp/$backend-$fixture/$profile"
  local golden="$goldens/$backend/$profile"

  checks "$actual" "$profile" "$fixture" "$backend"

  if [ "$accept" = 1 ]; then
    rm -rf "$golden"
    mkdir -p "$golden"
    cp -r "$actual/." "$golden/"
    echo "  accepted — $backend/$profile"
  else
    [ -d "$golden" ] || { echo "golden missing for $backend/$profile; inspect build then run bb golden:accept" >&2; exit 1; }
    if diff -qr "$golden" "$actual"; then
      echo "  ok — $backend/$profile"
    else
      status=1
    fi
  fi
}

checks() {
  local actual=$1 profile=$2 fixture=$3 backend=$4
  for stage in mysql-agy-infrastructure mysql-agy-ansible-local mysql-agy-dns mysql-agy-ansible; do
    [ -d "$actual/$stage" ] || { echo "golden: $profile is missing stage $stage" >&2; exit 1; }
  done

  local infra="$actual/mysql-agy-infrastructure/main.tf"
  grep -q 'resource "digitalocean_droplet" "node"' "$infra"
  grep -q 'resource "digitalocean_reserved_ip" "endpoint"' "$infra"
  grep -q 'resource "digitalocean_firewall" "cluster"' "$infra"
  grep -q 'output "node_public_ips"' "$infra"
  grep -q 'output "reserved_ip"' "$infra"
  grep -q 'source_addresses = local.client_sources' "$infra"
  grep -q '203.0.113.10/32' "$infra"
  grep -q '203.0.113.0/24' "$infra"
  [ "$(grep -c 'prevent_destroy = true' "$infra")" -ge 3 ] || {
    echo "golden: $profile: deployment-owned infrastructure lost prevent_destroy" >&2; exit 1
  }
  # The SSH Keypair Standard, both modes: keygen declares the profile-named key
  # resource and references it by attribute; opt-out keeps the literal id and
  # creates nothing.
  if [ "$fixture" = colors ]; then
    grep -q 'resource "digitalocean_ssh_key" "machine"' "$infra" || { echo "golden: $profile: keygen mode declares no key resource" >&2; exit 1; }
    grep -q 'ssh_keys = \[digitalocean_ssh_key.machine.id\]' "$infra" || { echo "golden: $profile: keygen mode does not reference the key by attribute" >&2; exit 1; }
    grep -q 'ssh_key_id   = digitalocean_ssh_key.machine.id' "$infra" || { echo "golden: $profile: params carries no ssh_key_id" >&2; exit 1; }
    grep -q 'IdentityFile ~/.ssh/mysql-agy-fixture' "$actual/mysql-agy-ansible-local/main.yml" || { echo "golden: $profile: the local stage names no identity file" >&2; exit 1; }
    grep -q '"ansible_ssh_private_key_file" : "/home/build-placeholder/.ssh/mysql-agy-fixture"' "$actual/mysql-agy-ansible/inventory.json" || { echo "golden: $profile: the inventory does not name the generated key" >&2; exit 1; }
  else
    ! grep -q 'digitalocean_ssh_key' "$infra" || { echo "golden: $profile: opt-out mode must create no key" >&2; exit 1; }
    grep -q 'ssh_keys = \["12345678"\]' "$infra" || { echo "golden: $profile: opt-out mode lost the literal key id" >&2; exit 1; }
    ! grep -qE '^\s+IdentityFile ' "$actual/mysql-agy-ansible-local/main.yml" || { echo "golden: $profile: opt-out mode must not guess an identity file" >&2; exit 1; }
  fi

  if [ "$backend" = r2 ]; then
    grep -q "$profile/mysql-agy-infrastructure.tfstate" "$actual/mysql-agy-infrastructure/backend.tf.json"
  fi

  local dns="$actual/mysql-agy-dns/main.tf"
  grep -q 'resource "cloudflare_dns_record" "cluster"' "$dns"
  grep -q 'resource "cloudflare_dns_record" "node"' "$dns"

  local ansible="$actual/mysql-agy-ansible"
  for file in ansible.cfg base.yml cluster.yml backup.yml health.yml cleanup.yml inventory.json; do
    [ -f "$ansible/$file" ] || { echo "golden: $profile is missing playbook $file" >&2; exit 1; }
  done
  for file in mysqld.cnf verify.cnf apparmor-local node.env mysql-agy-lib mysql-agy-endpoint mysql-agy-heartbeat mysql-agy-snapshot mysql-agy-binlog-archive mysql-agy-binlog-upload mysql-agy-restore-check mysql-agy-health; do
    [ -f "$ansible/files/$file" ] || { echo "golden: $profile is missing node file $file" >&2; exit 1; }
  done
  grep -q 'no_log: true' "$ansible/cluster.yml"
  grep -q 'no_log: true' "$ansible/backup.yml"

  if grep -rEq 'client-certificate-data|client-key-data|BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|REPLACE_ME|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$actual"; then
    echo "golden: $profile rendered credential-shaped material" >&2; exit 1
  fi
  # A Selmer tag that survived rendering is a typo or an unsupplied key.
  if grep -rn '<{' "$actual"; then
    echo "golden: $profile left an unrendered Selmer tag" >&2; exit 1
  fi
  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$actual"; then
    echo "golden: $profile rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # SSH Config Standard §6: the local stage takes addresses and the aliases as
  # Ansible extra-vars, never through Selmer, so its rendered playbook carries
  # no address at all.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$actual/mysql-agy-ansible-local"; then
    echo "golden: $profile rendered an address into the local ssh_config stage" >&2; exit 1
  fi
}

for fixture in colors optout; do
  for backend in local r2; do
    build "$fixture" "$backend"
  done
done

[ "$status" = 0 ] && echo 'all mysql-agy goldens and safety assertions pass'
exit "$status"
