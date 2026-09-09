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

  # Compute documents are library-owned; this package checks its topology and
  # the SSH identities consumed by application stages.
  [ -d "$actual/mysql-agy-infrastructure/shared" ] || exit 1
  for node in 0 1 2; do
    [ -f "$actual/mysql-agy-infrastructure/nodes/$node/node.tf.json" ] || exit 1
  done
  if [ "$fixture" = colors ]; then
    grep -q "colors_keygen: true" "$actual/mysql-agy-ansible-local/main.yml" || exit 1
  else
    grep -q 'colors_keygen: false' "$actual/mysql-agy-ansible-local/main.yml" || exit 1
  fi
  grep -q "$profile/mysql-agy-dns.tfstate" "$actual/mysql-agy-dns/backend.tf.json"

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

  if grep -rEq 'client-certificate-data|client-key-data|BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$actual"; then
    echo "golden: $profile rendered credential-shaped material" >&2; exit 1
  fi
  if grep -rq --exclude=colors-compute-endpoint 'REPLACE_ME' "$actual"; then
    echo "$profile: unresolved configuration placeholder" >&2; exit 1
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
  for backend in s3 r2; do
    build "$fixture" "$backend"
  done
done

[ "$status" = 0 ] && echo 'all mysql-agy goldens and safety assertions pass'
exit "$status"
