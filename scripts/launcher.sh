#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-mysql-agy-green/green"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
checks=0
fail(){ echo "launcher: FAIL — $*" >&2; exit 1; }
ok(){ checks=$((checks+1)); echo "  ok — $*"; }

[ -f "$launcher" ] || fail 'payload launcher is missing'
grep -q 'io.github.getcolors.mysql-agy.workflow/workflow' "$launcher" || fail 'workflow dispatch is missing'
for bad in 'defn.*-step' 'tofu/' 'ansible-playbook'; do
  ! grep -qE "$bad" "$launcher" || fail "launcher contains package logic: $bad"
done
ok 'dispatches to the library and contains no lifecycle logic'

grep -qE '\(def \^:private mysql-agy-sha (nil|"[0-9a-f]{40}")\)' "$launcher" || fail 'invalid pin site'
ok 'has one managed immutable pin site'

mkdir "$tmp/bare"
cp "$launcher" "$tmp/bare/green"; chmod +x "$tmp/bare/green"
if grep -q '(def \^:private mysql-agy-sha nil)' "$launcher"; then
  out=$(cd "$tmp/bare" && ./green build 2>&1 || true)
  grep -q MYSQL_AGY_LIB_ROOT <<<"$out" || fail 'an unpinned launcher did not explain MYSQL_AGY_LIB_ROOT'
  ok 'unstamped payload fails with an actionable working-tree override'
else
  ok 'payload carries a real package commit pin'
fi

mkdir "$tmp/project"
cp "$launcher" "$tmp/project/green"; chmod +x "$tmp/project/green"
cp "$root/test/fixtures/colors.yml" "$tmp/project/colors.yml"
(cd "$tmp/project" && MYSQL_AGY_LIB_ROOT="$root" ./green build >/dev/null) || fail 'MYSQL_AGY_LIB_ROOT build failed'
[ -f "$tmp/project/.colors/mysql-agy-fixture/mysql-agy-infrastructure/shared/shared.tf.json" ] || fail 'copied payload rendered nothing'
ok 'working-tree override renders from a copied payload'
mkdir -p "$tmp/project/deep/path"
(cd "$tmp/project/deep/path" && MYSQL_AGY_LIB_ROOT="$root" ../../green build >/dev/null) || fail 'upward desired-state search failed'
ok 'finds colors.yml by walking upward'

out=$(cd "$tmp/project" && MYSQL_AGY_LIB_ROOT="$root" ./green nonsense 2>&1 || true)
grep -q Usage <<<"$out" || fail 'unknown command has no usage'
for verb in build create delete health; do
  grep -q "\"$verb\"" "$launcher" || fail "missing command $verb"
done
ok 'lifecycle and health commands are dispatchable'

[ -L "$root/green/green" ] && [ "$(readlink "$root/green/green")" = ../skills/package-mysql-agy-green/green ] || fail 'green/green is not the payload symlink'
[ -L "$root/red/red" ] && [ "$(readlink "$root/red/red")" = ../skills/package-mysql-agy-red/red ] || fail 'red/red is not the payload symlink'
[ -L "$root/blue/blue" ] && [ "$(readlink "$root/blue/blue")" = ../skills/package-mysql-agy-blue/blue ] || fail 'blue/blue is not the payload symlink'
ok 'each colour launcher is its payload symlink'

for payload in "$root/skills/package-mysql-agy-red/red" "$root/skills/package-mysql-agy-blue/blue"; do
  [ -f "$payload" ] || fail "payload launcher is missing: $payload"
done
grep -q '"package-mysql-agy-red": null,\|"package-mysql-agy-red": "github:getcolors/mysql-agy#' \
  "$root/skills/package-mysql-agy-red/red" || fail 'red payload has no managed pin site'
grep -q '# dependencies = \[\]\|package-mysql-agy-blue = { git' \
  "$root/skills/package-mysql-agy-blue/blue" || fail 'blue payload has no managed pin site'
ok 'red and blue payloads carry managed pin sites'
# The ONCE pin is one fact in four places: the three manifests and the red
# payload's PINS, which installs ONCE itself (blue resolves it transitively
# through the package). A manifest bump the red payload did not follow
# installs a package whose `computeCluster` import fails at first use in a
# deployment, not here.
once_sha=$(awk '/once\.git/ {found=1} found && match($0, /:git\/sha "[0-9a-f]{40}"/) {print substr($0, RSTART+10, 40); exit}' "$root/green/deps.edn")
[ -n "$once_sha" ] || fail 'green/deps.edn carries no ONCE pin'
grep -q "getcolors/once#$once_sha" "$root/red/package.json" || fail 'red/package.json ONCE pin differs from green'
grep -q "rev = \"$once_sha\"" "$root/blue/pyproject.toml" || fail 'blue/pyproject.toml ONCE pin differs from green'
grep -q "getcolors/once#$once_sha" "$root/skills/package-mysql-agy-red/red" || fail 'red payload PINS ONCE pin differs from green'
ok 'the ONCE pin agrees in green, red, blue, and the red payload'

# colors-compute-red declares the Red SDK as a peer, so a cold launcher cache
# installs the SDK only because PINS names it. The pin must be the one
# red/package.json tests against, and a cold cache must actually resolve it:
# the working-tree builds reuse red/node_modules and cannot see a missing peer.
red_launcher="$root/skills/package-mysql-agy-red/red"
red_sdk_sha=$(grep -oE '"red": "github:getcolors/red#[0-9a-f]{40}"' "$root/red/package.json" | grep -oE '[0-9a-f]{40}')
[[ -n $red_sdk_sha ]] || fail 'red/package.json carries no Red SDK pin'
grep -q "\"red\": \"github:getcolors/red#$red_sdk_sha\"" "$red_launcher" || fail 'red payload PINS the Red SDK at a different commit than red/package.json'
ok 'the red payload PINS the Red SDK at the red/package.json commit'
mkdir "$tmp/red-cold"
cp "$red_launcher" "$tmp/red-cold/red"; chmod +x "$tmp/red-cold/red"
cp "$root/test/fixtures/colors.yml" "$tmp/red-cold/colors.yml"
# One retry: a cold install fetches GitHub tarballs and a transient fetch
# failure is not a payload defect. Each attempt starts from empty caches.
cold_ok=0
for attempt in 1 2; do
  rm -rf "$tmp/red-cold/xdg" "$tmp/red-cold/bun" "$tmp/red-cold/.colors"
  if (cd "$tmp/red-cold" && XDG_CACHE_HOME="$tmp/red-cold/xdg" BUN_INSTALL_CACHE_DIR="$tmp/red-cold/bun" ./red build >"$tmp/red-cold/build.log" 2>&1); then cold_ok=1; break; fi
done
[[ $cold_ok == 1 ]] || { tail -5 "$tmp/red-cold/build.log" >&2; fail 'red payload does not build from a cold cache'; }
ok 'red payload builds from a cold cache with only its PINS'

echo "launcher: $checks checks passed"
