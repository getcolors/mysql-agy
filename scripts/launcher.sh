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
[ -f "$tmp/project/.colors/mysql-agy-fixture/mysql-agy-infrastructure/main.tf" ] || fail 'copied payload rendered nothing'
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

[ -L "$root/green" ] && [ "$(readlink "$root/green")" = skills/package-mysql-agy-green/green ] || fail 'root green is not the payload symlink'
ok 'root launcher is the payload symlink'
echo "launcher: $checks checks passed"
