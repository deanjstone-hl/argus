# [@argus/watchtower-v1.4.0](https://github.com/deanjstone/argus/compare/@argus/watchtower-v1.3.1...@argus/watchtower-v1.4.0) (2026-11-01)


### Features

* adopt the curve-safe shell and iOS fixes in ops-hub-web, watchtower and email ([#1022](https://github.com/deanjstone/argus/issues/1022)) ([73d4b82](https://github.com/deanjstone/argus/commit/73d4b829b80283d4d01532f19c1db16bb24c6488)), closes [#1003](https://github.com/deanjstone/argus/issues/1003) [#1003](https://github.com/deanjstone/argus/issues/1003)

# [@argus/watchtower-v1.3.1](https://github.com/deanjstone/argus/compare/@argus/watchtower-v1.3.0...@argus/watchtower-v1.3.1) (2026-10-17)


### Bug Fixes

* **watchtower-collector:** add /mnt/backups disk card, compute disk % like df ([#746](https://github.com/deanjstone/argus/issues/746)) ([03a3f4e](https://github.com/deanjstone/argus/commit/03a3f4e5f8dd9248e7859e207b120f49587e7014)), closes [#740](https://github.com/deanjstone/argus/issues/740)

# [@argus/watchtower-v1.3.0](https://github.com/deanjstone/argus/compare/@argus/watchtower-v1.2.0...@argus/watchtower-v1.3.0) (2026-09-30)


### Features

* **memory-mcp:** v2 memory type enum and the store half of the migration ([#454](https://github.com/deanjstone/argus/issues/454)) ([99f0d21](https://github.com/deanjstone/argus/commit/99f0d214540742acfc7cf0523281c08cd63a334f)), closes [context#213](https://github.com/context/issues/213) [argus#367](https://github.com/argus/issues/367) [context#213](https://github.com/context/issues/213)

# [@argus/watchtower-v1.2.0](https://github.com/deanjstone/argus/compare/@argus/watchtower-v1.1.1...@argus/watchtower-v1.2.0) (2026-09-09)


### Features

* **252:** fail-closed migration verification + route the runtime scripts through the backend switch ([#365](https://github.com/deanjstone/argus/issues/365)) ([c6612dd](https://github.com/deanjstone/argus/commit/c6612ddd3bb5c7833cb88316b38108616c8d2e78)), closes [#252](https://github.com/deanjstone/argus/issues/252) [#249](https://github.com/deanjstone/argus/issues/249) [#298](https://github.com/deanjstone/argus/issues/298) [argus#252](https://github.com/argus/issues/252) [argus#252](https://github.com/argus/issues/252)

# [@argus/watchtower-v1.1.1](https://github.com/deanjstone/argus/compare/@argus/watchtower-v1.1.0...@argus/watchtower-v1.1.1) (2026-09-06)


### Bug Fixes

* **watchtower:** generate Worker types before building ([#349](https://github.com/deanjstone/argus/issues/349)) ([fdb16f5](https://github.com/deanjstone/argus/commit/fdb16f5f26248974e597ecf90da7453f12b45191))

# [@argus/watchtower-v1.1.0](https://github.com/deanjstone/argus/compare/@argus/watchtower-v1.0.0...@argus/watchtower-v1.1.0) (2026-08-14)


### Features

* live-provision D1/Vectorize resources + migrate real data (argus[#252](https://github.com/deanjstone/argus/issues/252) phase 2) ([#253](https://github.com/deanjstone/argus/issues/253)) ([34fea04](https://github.com/deanjstone/argus/commit/34fea0438c823ceb7d9d1d5f93e7829604a37d42))

# @argus/watchtower-v1.0.0 (2026-08-09)


### Bug Fixes

* **release:** disable @semantic-release/github success/fail comments ([#195](https://github.com/deanjstone/argus/issues/195)) ([f8700a7](https://github.com/deanjstone/argus/commit/f8700a7623cba507bb22998fb83df0b8930c187b))

## [1.0.1](https://github.com/deanjstone/watchtower/compare/v1.0.0...v1.0.1) (2026-08-08)


### Bug Fixes

* update ~/projects references to ~/repos ([#26](https://github.com/deanjstone/watchtower/issues/26)) ([568c576](https://github.com/deanjstone/watchtower/commit/568c576a03a1ce6a6a3d710473b14d432a3ee17a))

# 1.0.0 (2026-08-03)


### Bug Fixes

* pin pnpm version, unblocks CI and deploy ([#12](https://github.com/deanjstone/watchtower/issues/12)) ([640b9d5](https://github.com/deanjstone/watchtower/commit/640b9d538bbef311dde22db76da3a7c1bd110fd6))
* pin wrangler as a devDependency to unblock Deploy ([#14](https://github.com/deanjstone/watchtower/issues/14)) ([b9d4078](https://github.com/deanjstone/watchtower/commit/b9d4078251f535ee7d758b6136b2bf05ab1d320c))
* remove dependency-review workflow (hard-fails without GHAS) ([#24](https://github.com/deanjstone/watchtower/issues/24)) ([e656423](https://github.com/deanjstone/watchtower/commit/e65642370aa4b1f6fce01dd3084f9ef09878410d))


### Features

* add semantic-release for automated versioning ([#25](https://github.com/deanjstone/watchtower/issues/25)) ([c3f8428](https://github.com/deanjstone/watchtower/commit/c3f84289ae9b4afbb822c353eb0b3e510e9e9a74))
* collector core, systemd/disk/uptime adapters ([#3](https://github.com/deanjstone/watchtower/issues/3)) ([29a010b](https://github.com/deanjstone/watchtower/commit/29a010b3a55a4bf76e19d99122194c3f5a9f9bdb))
