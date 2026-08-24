# CLAUDE.md

Guidance for Claude Code when working in `mysql-agy/`.

## What this repository is

`mysql-agy` is a getcolors Package Skill provisioning a 3-node MySQL Group Replication high-availability cluster on DigitalOcean with Cloudflare DNS and Cloudflare R2 backup & restore verification drills.

## Commands

```sh
bb test              # Run Babashka unit tests
bb golden            # Run golden checks
bb golden:accept     # Accept updated golden fixtures
bb pin               # Stamp launcher with pushed git SHA
./scripts/launcher.sh # Test launcher contract and overrides
./green build        # Render local state
./green create --dry-run
```

## Documentation

`index.html` is this repository's landing page and carries two analytics tags: GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly equal the decoded HTML `<title>` and stay distinct and stable so one Analytics property can separate repositories, and the self-hosted Rybbit snippet `<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`, which shares one site ID across every page because `getcolors.github.io/<repo>/` paths already encode the repository. Never add one tag without the other.
