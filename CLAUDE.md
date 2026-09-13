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
under the **s3** state backend and again under **r2**, produced by
overlaying `COLORS_PAR_PROVIDER_BACKEND=r2` on the same file. The four
committed trees live at
`test/resources/golden/{s3,r2}/mysql-agy-{fixture,optout}/`; the backend
pair differs only in every stage's `backend.tf.json`. `scripts/golden.sh`
checks green against all four; `scripts/parity.sh` renders all four through
every colour and diffs the trees — and the colour template trees
(`red/resources`, blue's embedded `resources/`) — byte for byte.

## Coupling

Every color depends on the pinned colors-compute library for compute, remote
state, provider credentials, SSH keys, topology expansion, and lifecycle
ownership. The package declares three homogeneous peers and application network
requirements. Colors fans out the same library node operation, then joins
complete observed outputs for Ansible and DNS. ONCE remains only for application
DNS helpers and its separate backend credential binding.

Provider templates and registries belong to the library. Supporting another
compatible provider requires a dependency bump, without application source or
provider fixture changes. Build and dry-run use documentation addresses and a
placeholder home without reading local keys. Real operations validate remote
ownership before generating keys or invoking a compute provider. Existing
monolithic compute state requires an explicit migration; it is never silently
adopted. Local SSH config plays remain package-owned and use observed SSH users
and the selected identity path.

Manifests and lockfiles pin published dependencies. Publish package source before
running `bb pin` in `green/`, then publish the stamped launcher copies. Red
launchers resolve compute through the pinned package and pin the Red SDK
explicitly in `PINS` at the commit `red/package.json` pins, because
colors-compute-red declares the SDK as a peer and a cold cache installs nothing
for a peer; `scripts/launcher.sh` checks the two agree and builds the payload
from an empty cache. Do not repeat one Git dependency at two depths: Bun fails
to resolve it.

The library creates the reserved IP without assigning it to a node and supplies
the endpoint agent. MySQL retains the ONLINE/PRIMARY/read-write eligibility gates
and invokes that agent for assignment. Provider API code and credentials must
not return to the application endpoint scripts.


## Documentation

`index.html` is this repository's landing page and carries two analytics tags: GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly equal the decoded HTML `<title>` and stay distinct and stable so one Analytics property can separate repositories, and the self-hosted Rybbit snippet `<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`, which shares one site ID across every page because `getcolors.github.io/<repo>/` paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
