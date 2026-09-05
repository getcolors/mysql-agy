# CLAUDE.md

Guidance for Claude Code when working in `mysql-agy/`.

## What this repository is

`mysql-agy` is a tri-colour getcolors Package Skill (green, red, blue)
provisioning a 3-node MySQL Group Replication high-availability cluster on
DigitalOcean with Cloudflare DNS and Cloudflare R2 backup & restore
verification drills.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`. The fixture
and the goldens are shared across colours at the repository root —
`test/fixtures/` and `test/resources/golden/` — with `green/test/fixtures` and
`green/test/resources` symlinks pointing at them. Each colour dir holds a
launcher symlink to its skill payload (`green/green`, `red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two state backends, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build      # render local state
cd green && ./green create --dry-run
```

Never run real create/delete without explicit authorization. Never edit
`.colors/`. Real deletion requires `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.

## The two-fixture, two-backend golden and parity axes

The goldens have two axes. `test/fixtures/colors.yml` is the keygen-mode
fixture (no `digitalocean-ssh-keys`: the package owns the keypair) and
`test/fixtures/optout.yml` is the opt-out fixture (an explicit key id: the
package touches no key material and renders byte-for-byte what it rendered
before the SSH Keypair Standard, under its own profile). Each is rendered
under the **local** state backend and again under **r2**, produced by
overlaying `COLORS_PAR_PROVIDER_BACKEND=r2` on the same file. The four
committed trees live at
`test/resources/golden/{local,r2}/mysql-agy-{fixture,optout}/`; the backend
pair differs only in every stage's `backend.tf.json`. `scripts/golden.sh`
checks green against all four; `scripts/parity.sh` renders all four through
every colour and diffs the trees — and the colour template trees
(`red/resources`, blue's embedded `resources/`) — byte for byte.

## Coupling

The package pins the SDK — Green in `green/deps.edn`, the Red SDK in
`red/package.json`, the Blue SDK in `blue/pyproject.toml` — and ONCE, in the
same three manifests and in the red payload's `PINS`, for two namespaces:
`compute-cluster` (`io.github.getcolors.once.compute-cluster`,
`package-once-red`'s `computeCluster`, `package_once_blue.compute_cluster`),
the one implementation of the Compute Cluster Standard
(`workspace/standards/compute-cluster.md`), and `ssh`
(`io.github.getcolors.once.ssh`, ONCE's unexported `red/src/ssh.ts` reached
through `red/src/once.ts`, `package_once_blue.ssh`), the reference
implementation of the SSH Keypair Standard (`workspace/standards/ssh-keypair.md`).
The package's `ssh` module wraps ONCE's with the build placeholder; its
`ssh_config` module and its `ansible-local` play are its own copies of the
multi-node shape every DB package carries (`workspace/standards/ssh-config.md`
§7; `workspace/scripts/package-copies.py` gates the copies), writing one
`~/.ssh/config` block marked with the profile that holds a stanza per alias
(`<profile>`, `<profile>-0..2`). Keygen mode is the absence of
`digitalocean-ssh-keys`; `digitalocean-ssh-private-key` is required in opt-out
mode only. On a real create the keypair matrix and the DigitalOcean key
preflight run in `start-step` before anything renders; the block is written
after the infrastructure stage and withdrawn before the destroy; the keypair
is removed last, after the destroy.
The package owns its `compute-providers` registry, its `spec` (one
homogeneous role of `cluster-nodes` members, fallback offset 11, the
`10.110.0.0/20` fallback subnet, a discovered network), its own validators
and its `params-errors`; ONCE owns selection, the source lists, the network
and topology checks, the fallback nodes, `read-state`, `adopt-state`,
`resolved-cluster` and the provider-switch guard. The compute state is the
template's `params` output — `provider`, `reserved_ip`, `vpc_id`,
`vpc_ip_range`, and one node per member with its `droplet_id` — adopted
under `:once/cluster`; a pre-adoption state, which recorded only the parallel
`node_public_ips`/`node_private_ips`/`node_droplet_ids` lists, is translated
into the same shape by the reader in `tools`, and refused when the lists
disagree. The package keeps its own multi-node DigitalOcean template rather
than ONCE's single-server one; what it takes from ONCE is the cluster
contract over that template, never the template itself. Every machine in
the account's regional default VPC is inside the cluster's east-west trust
boundary — the group port and the all-ports VPC rules take
`data.digitalocean_vpc.cluster.ip_range` as their source — which the standard
names as a security exception of a discovered network. Use
`MYSQL_AGY_LIB_ROOT` (the repository root, for every colour; red also accepts
the `red/` dir directly), `GREEN_LIB_ROOT` and `ONCE_LIB_ROOT` for
working-tree development. Final launchers use a pushed SHA managed by
`bb pin` (in `green/`), which stamps all three payloads from their unpinned
birth forms; deployment launchers are copies, not symlinks. Never invent a SHA.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags: GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly equal the decoded HTML `<title>` and stay distinct and stable so one Analytics property can separate repositories, and the self-hosted Rybbit snippet `<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`, which shares one site ID across every page because `getcolors.github.io/<repo>/` paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
