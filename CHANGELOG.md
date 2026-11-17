## [3.27.2](https://github.com/deanjstone/argus/compare/v3.27.1...v3.27.2) (2026-11-05)


### Bug Fixes

* stack the PR queue card and hide Approve at level on phones ([#1097](https://github.com/deanjstone/argus/issues/1097)) ([a95eba7](https://github.com/deanjstone/argus/commit/a95eba7030fb7529e6a092da9c4e7447b15b36ed))

## [3.27.1](https://github.com/deanjstone/argus/compare/v3.27.0...v3.27.1) (2026-11-05)


### Bug Fixes

* no budget rung from the first 24h of weekly readings ([#1093](https://github.com/deanjstone/argus/issues/1093)) ([d097632](https://github.com/deanjstone/argus/commit/d097632ee2835dbf6f9ed66a417725370f74a885)), closes [#1091](https://github.com/deanjstone/argus/issues/1091)

# [3.27.0](https://github.com/deanjstone/argus/compare/v3.26.1...v3.27.0) (2026-11-04)


### Features

* keep the AFK directives in loop-state as an owner-set record ([#1090](https://github.com/deanjstone/argus/issues/1090)) ([f38727b](https://github.com/deanjstone/argus/commit/f38727bfee9bfe15e83d71ffaa2a4e7072ba1e82)), closes [#1067](https://github.com/deanjstone/argus/issues/1067)

## [3.26.1](https://github.com/deanjstone/argus/compare/v3.26.0...v3.26.1) (2026-11-04)


### Bug Fixes

* gate loop-state at 100 minus reserve used, not a fixed 90% ([#1082](https://github.com/deanjstone/argus/issues/1082)) ([a3f880e](https://github.com/deanjstone/argus/commit/a3f880e477f486c67dc3c7c21e3cee32234e821a))

# [3.26.0](https://github.com/deanjstone/argus/compare/v3.25.1...v3.26.0) (2026-11-04)


### Features

* route Workers AI calls through AI Gateway behind AI_GATEWAY_ID ([#1064](https://github.com/deanjstone/argus/issues/1064)) ([dee04dd](https://github.com/deanjstone/argus/commit/dee04dd9c1818280ebb326ea0fff1caa2060b5ba)), closes [#1056](https://github.com/deanjstone/argus/issues/1056)

## [3.25.1](https://github.com/deanjstone/argus/compare/v3.25.0...v3.25.1) (2026-11-04)


### Bug Fixes

* regenerate the touched topic hubs on each memory_remember ([#1063](https://github.com/deanjstone/argus/issues/1063)) ([fc05c94](https://github.com/deanjstone/argus/commit/fc05c942cc18c41747df220da184e042905726c9)), closes [#1053](https://github.com/deanjstone/argus/issues/1053)

# [3.25.0](https://github.com/deanjstone/argus/compare/v3.24.1...v3.25.0) (2026-11-04)


### Features

* redesign the ops hub promotions list and approve pages ([#1062](https://github.com/deanjstone/argus/issues/1062)) ([50f3c1d](https://github.com/deanjstone/argus/commit/50f3c1d85e2530cea56ae2a5a27ff85f7b620d2f)), closes [#1018](https://github.com/deanjstone/argus/issues/1018)
* refuse owner_turn from a thread that does not hold the direction lease ([#1061](https://github.com/deanjstone/argus/issues/1061)) ([56a2e74](https://github.com/deanjstone/argus/commit/56a2e745ce42d38fe8f1b9082289d254c92d3f4e)), closes [argus-config#1031](https://github.com/argus-config/issues/1031) [#1042](https://github.com/deanjstone/argus/issues/1042)

## [3.24.1](https://github.com/deanjstone/argus/compare/v3.24.0...v3.24.1) (2026-11-04)


### Bug Fixes

* build the deploy copy when a promotion redeploys loop-state-mcp and the collector ([#1060](https://github.com/deanjstone/argus/issues/1060)) ([e8b760f](https://github.com/deanjstone/argus/commit/e8b760fd1d900446afdd7e3d98ff2abb1c1ca13d)), closes [argus#1051](https://github.com/argus/issues/1051) [argus#1050](https://github.com/argus/issues/1050)

# [3.24.0](https://github.com/deanjstone/argus/compare/v3.23.0...v3.24.0) (2026-11-04)


### Features

* Memory map page, a 3D view of memory connections ([#1059](https://github.com/deanjstone/argus/issues/1059)) ([3cad392](https://github.com/deanjstone/argus/commit/3cad39239b52d16343cd563e97c0b54c5877da63)), closes [#1049](https://github.com/deanjstone/argus/issues/1049)

# [3.23.0](https://github.com/deanjstone/argus/compare/v3.22.6...v3.23.0) (2026-11-03)


### Features

* read-only memory graph endpoint and topics column ([#1058](https://github.com/deanjstone/argus/issues/1058)) ([732c5af](https://github.com/deanjstone/argus/commit/732c5af8f8d140df51d9939b1ed27868df4f0f64)), closes [#1048](https://github.com/deanjstone/argus/issues/1048)

## [3.22.6](https://github.com/deanjstone/argus/compare/v3.22.5...v3.22.6) (2026-11-03)


### Bug Fixes

* ask for workflows:write when a promotion range changes workflow files ([#1057](https://github.com/deanjstone/argus/issues/1057)) ([38f74f8](https://github.com/deanjstone/argus/commit/38f74f83f7fcaa948b88907eaf52ea69d1c3278a)), closes [#1054](https://github.com/deanjstone/argus/issues/1054)

## [3.22.5](https://github.com/deanjstone/argus/compare/v3.22.4...v3.22.5) (2026-11-03)


### Bug Fixes

* wake a homelab lease primary as a primary and let its host reclaim ([#1052](https://github.com/deanjstone/argus/issues/1052)) ([700b5ed](https://github.com/deanjstone/argus/commit/700b5ed0a96a5c7fdf1d79fcef0d9bd3a6340153)), closes [#1046](https://github.com/deanjstone/argus/issues/1046)

## [3.22.4](https://github.com/deanjstone/argus/compare/v3.22.3...v3.22.4) (2026-11-03)


### Bug Fixes

* drop stale argus CLI references after the rename to agent ([#1044](https://github.com/deanjstone/argus/issues/1044)) ([1793a81](https://github.com/deanjstone/argus/commit/1793a8197deda65ec9301493a04958d3f1b99a19))

## [3.22.3](https://github.com/deanjstone/argus/compare/v3.22.2...v3.22.3) (2026-11-03)


### Performance Improvements

* narrow PR CI to the packages a change touches ([#1043](https://github.com/deanjstone/argus/issues/1043)) ([97302ce](https://github.com/deanjstone/argus/commit/97302cee67e310a8f8bfe9774d193ce5791df83c)), closes [#1009](https://github.com/deanjstone/argus/issues/1009)

## [3.22.2](https://github.com/deanjstone/argus/compare/v3.22.1...v3.22.2) (2026-11-02)


### Bug Fixes

* require 2 missed ticks before loop-state reports a holder stalled ([#1041](https://github.com/deanjstone/argus/issues/1041)) ([b2366f4](https://github.com/deanjstone/argus/commit/b2366f422fc7b9cd6e6a4f6ffa30e1c6f62a2292)), closes [#1038](https://github.com/deanjstone/argus/issues/1038)

## [3.22.1](https://github.com/deanjstone/argus/compare/v3.22.0...v3.22.1) (2026-11-02)


### Bug Fixes

* never promote a skip-CI marker commit, and let the owner replay a skipped deploy ([#1036](https://github.com/deanjstone/argus/issues/1036)) ([4105b0b](https://github.com/deanjstone/argus/commit/4105b0b5ac2d6507aa3748d96b4b3e86092dc71b)), closes [argus-config#1060](https://github.com/argus-config/issues/1060) [deanjstone/argus-config#1060](https://github.com/deanjstone/argus-config/issues/1060)

# [3.22.0](https://github.com/deanjstone/argus/compare/v3.21.1...v3.22.0) (2026-11-02)


### Features

* exempt budget-exempt repo slots from the slot caps ([#1035](https://github.com/deanjstone/argus/issues/1035)) ([4e55880](https://github.com/deanjstone/argus/commit/4e558809af39bba98d00d93142b55581f895bf6b)), closes [homelab#335](https://github.com/homelab/issues/335) [design-system#164](https://github.com/design-system/issues/164) [#1033](https://github.com/deanjstone/argus/issues/1033)

## [3.21.1](https://github.com/deanjstone/argus/compare/v3.21.0...v3.21.1) (2026-11-01)


### Bug Fixes

* x-mcp notes keep only the self-reply thread, true metadata and extracted links ([#1031](https://github.com/deanjstone/argus/issues/1031)) ([2601e93](https://github.com/deanjstone/argus/commit/2601e930d137410044624de779759821f7e41cc5)), closes [#1021](https://github.com/deanjstone/argus/issues/1021)

# [3.21.0](https://github.com/deanjstone/argus/compare/v3.20.1...v3.21.0) (2026-11-01)


### Features

* adopt the curve-safe shell and iOS fixes in ops-hub-web, watchtower and email ([#1022](https://github.com/deanjstone/argus/issues/1022)) ([73d4b82](https://github.com/deanjstone/argus/commit/73d4b829b80283d4d01532f19c1db16bb24c6488)), closes [#1003](https://github.com/deanjstone/argus/issues/1003) [#1003](https://github.com/deanjstone/argus/issues/1003)

## [3.20.1](https://github.com/deanjstone/argus/compare/v3.20.0...v3.20.1) (2026-11-01)


### Bug Fixes

* promotion guard lets a release commit take its parent's CI verdict ([#1020](https://github.com/deanjstone/argus/issues/1020)) ([f96b8f4](https://github.com/deanjstone/argus/commit/f96b8f4c2964e040e35396e716aae3db33950801)), closes [#978](https://github.com/deanjstone/argus/issues/978) [#1019](https://github.com/deanjstone/argus/issues/1019)

# [3.20.0](https://github.com/deanjstone/argus/compare/v3.19.0...v3.20.0) (2026-11-01)


### Features

* x-mcp daily-pull command and homelab units, built not enabled ([#1016](https://github.com/deanjstone/argus/issues/1016)) ([2dd845b](https://github.com/deanjstone/argus/commit/2dd845bed7ad4a263318da2939d752ea76478778)), closes [#999](https://github.com/deanjstone/argus/issues/999) [#999](https://github.com/deanjstone/argus/issues/999)

# [3.19.0](https://github.com/deanjstone/argus/compare/v3.18.0...v3.19.0) (2026-11-01)


### Features

* loop-state lets budget-exempt repos start past the budget slot-cap cut ([#1015](https://github.com/deanjstone/argus/issues/1015)) ([c448072](https://github.com/deanjstone/argus/commit/c448072594bbc11dfc84e9aa9102f43a78343307)), closes [#1012](https://github.com/deanjstone/argus/issues/1012)
* x-mcp save_post saves one post into the vault on the ingest's code path ([#1011](https://github.com/deanjstone/argus/issues/1011)) ([1532fbf](https://github.com/deanjstone/argus/commit/1532fbfc720089a2afaeab728856c06971a3c63a)), closes [#996](https://github.com/deanjstone/argus/issues/996)

# [3.18.0](https://github.com/deanjstone/argus/compare/v3.17.1...v3.18.0) (2026-11-01)


### Features

* run x-mcp on the homelab only, WSL2 and Windows reach it over ssh ([#1008](https://github.com/deanjstone/argus/issues/1008)) ([03388fd](https://github.com/deanjstone/argus/commit/03388fd54566d0d1fbe1e4024447880f754d87e3)), closes [argus#1006](https://github.com/argus/issues/1006)

## [3.17.1](https://github.com/deanjstone/argus/compare/v3.17.0...v3.17.1) (2026-11-01)


### Bug Fixes

* x-mcp distil clips an overlong model summary or title instead of refusing the post ([#1007](https://github.com/deanjstone/argus/issues/1007)) ([1307820](https://github.com/deanjstone/argus/commit/13078208c07d1d8f663712b31dae121aa1f82c7b))

# [3.17.0](https://github.com/deanjstone/argus/compare/v3.16.0...v3.17.0) (2026-10-31)


### Features

* x-mcp import-cookies --from-t3-profile ([#1004](https://github.com/deanjstone/argus/issues/1004)) ([c5456d8](https://github.com/deanjstone/argus/commit/c5456d89146158053093c1c14a95b8e5208b691e))

# [3.16.0](https://github.com/deanjstone/argus/compare/v3.15.0...v3.16.0) (2026-10-31)


### Features

* x-mcp distil files ingested X posts into per-subject reference memories ([#1002](https://github.com/deanjstone/argus/issues/1002)) ([a9ae048](https://github.com/deanjstone/argus/commit/a9ae048227cd7ea02d7d1d99eefe1242c25c863b))

# [3.15.0](https://github.com/deanjstone/argus/compare/v3.14.1...v3.15.0) (2026-10-31)


### Features

* x-mcp ingest writes bookmarks into CONTEXT as X source files ([#1001](https://github.com/deanjstone/argus/issues/1001)) ([9c3dbef](https://github.com/deanjstone/argus/commit/9c3dbef25a9e62443b59bc0f6ebc8919a7bd115e))

## [3.14.1](https://github.com/deanjstone/argus/compare/v3.14.0...v3.14.1) (2026-10-31)


### Bug Fixes

* x-mcp reads Bookmarks at /i/history ([#992](https://github.com/deanjstone/argus/issues/992)) ([cf9f496](https://github.com/deanjstone/argus/commit/cf9f496b2261b3009c7bdbc5e2c5ca57753ab403))

# [3.14.0](https://github.com/deanjstone/argus/compare/v3.13.0...v3.14.0) (2026-10-31)


### Features

* enable atto1 for hub promotion ([#990](https://github.com/deanjstone/argus/issues/990)) ([931d7f9](https://github.com/deanjstone/argus/commit/931d7f90c591e847bcf94864abe94aaf4827a748)), closes [#890](https://github.com/deanjstone/argus/issues/890) [#900](https://github.com/deanjstone/argus/issues/900)

# [3.13.0](https://github.com/deanjstone/argus/compare/v3.12.3...v3.13.0) (2026-10-26)


### Features

* add remaining-budget ladder, hysteresis and per-host slot caps to loop-state ([#886](https://github.com/deanjstone/argus/issues/886)) ([3d21c4b](https://github.com/deanjstone/argus/commit/3d21c4b76e147d9ca102f35e84a9445a8a6d50d0)), closes [#861](https://github.com/deanjstone/argus/issues/861)

## [3.12.3](https://github.com/deanjstone/argus/compare/v3.12.2...v3.12.3) (2026-10-19)


### Bug Fixes

* **memory-mcp:** reconcile untyped tombstones by name == key (ADR-006 amendment) ([#806](https://github.com/deanjstone/argus/issues/806)) ([e812bdb](https://github.com/deanjstone/argus/commit/e812bdbdf31f731fe2bf9fffb581db241a26c2ea))

## [3.12.2](https://github.com/deanjstone/argus/compare/v3.12.1...v3.12.2) (2026-10-18)


### Bug Fixes

* **memory-mcp:** don't commit reconcile runs that only move the marker ([#775](https://github.com/deanjstone/argus/issues/775)) ([4200284](https://github.com/deanjstone/argus/commit/4200284902c930f5a96f534c422b41b398b25377)), closes [#772](https://github.com/deanjstone/argus/issues/772)

## [3.12.1](https://github.com/deanjstone/argus/compare/v3.12.0...v3.12.1) (2026-10-17)


### Bug Fixes

* **ops-hub:** stop iOS zooming the page on input focus ([#767](https://github.com/deanjstone/argus/issues/767)) ([efc014c](https://github.com/deanjstone/argus/commit/efc014c1755e20bb0ef53f442e3b7717e16d305a)), closes [#735](https://github.com/deanjstone/argus/issues/735)

# [3.12.0](https://github.com/deanjstone/argus/compare/v3.11.0...v3.12.0) (2026-10-17)


### Features

* **ops-hub:** add board DB migration script for the cutover ([#735](https://github.com/deanjstone/argus/issues/735)) ([#765](https://github.com/deanjstone/argus/issues/765)) ([f95d4d2](https://github.com/deanjstone/argus/commit/f95d4d2b848383a49067adf6f918acda7437d94e))

# [3.11.0](https://github.com/deanjstone/argus/compare/v3.10.1...v3.11.0) (2026-10-17)


### Bug Fixes

* **memory-mcp:** keep a staged page's topic on an update with no topic ([#763](https://github.com/deanjstone/argus/issues/763)) ([#764](https://github.com/deanjstone/argus/issues/764)) ([c4011e4](https://github.com/deanjstone/argus/commit/c4011e4b0840c9a465e3b8c04e35c8033729fd43))


### Features

* **ops-hub:** Table and Wayfinder maps views ([#731](https://github.com/deanjstone/argus/issues/731)) ([#761](https://github.com/deanjstone/argus/issues/761)) ([743f198](https://github.com/deanjstone/argus/commit/743f198a05c4e19a686afde3cb09cec7637bbd7e)), closes [#721](https://github.com/deanjstone/argus/issues/721)

## [3.10.1](https://github.com/deanjstone/argus/compare/v3.10.0...v3.10.1) (2026-10-17)


### Bug Fixes

* **memory-mcp:** scope sync-files test to its own URL prefix ([#760](https://github.com/deanjstone/argus/issues/760)) ([842bcb3](https://github.com/deanjstone/argus/commit/842bcb3dcb2d12fd9bbc3ef1e482ccb8c47c32fc))

# [3.10.0](https://github.com/deanjstone/argus/compare/v3.9.0...v3.10.0) (2026-10-17)


### Features

* **ops-hub:** issue page and v1 issue writes ([#732](https://github.com/deanjstone/argus/issues/732)) ([#755](https://github.com/deanjstone/argus/issues/755)) ([c2e1f86](https://github.com/deanjstone/argus/commit/c2e1f86fad06685c61b9aa6769a38beb587dff6e))

# [3.9.0](https://github.com/deanjstone/argus/compare/v3.8.0...v3.9.0) (2026-10-17)


### Features

* **ops-hub-web:** Home Needs-you feed, Waves and Mine ([#730](https://github.com/deanjstone/argus/issues/730)) ([#754](https://github.com/deanjstone/argus/issues/754)) ([423721a](https://github.com/deanjstone/argus/commit/423721a27ff1d6bdeda1f678ad0a7052fa8b10ac)), closes [#727](https://github.com/deanjstone/argus/issues/727) [#726](https://github.com/deanjstone/argus/issues/726) [732/#733](https://github.com/deanjstone/argus/issues/733)

# [3.8.0](https://github.com/deanjstone/argus/compare/v3.7.0...v3.8.0) (2026-10-17)


### Features

* **ops-hub:** PR page and guarded PR actions ([#733](https://github.com/deanjstone/argus/issues/733)) ([#757](https://github.com/deanjstone/argus/issues/757)) ([ab4750c](https://github.com/deanjstone/argus/commit/ab4750c17a0297ecd1bc9c8465a230e38f19afcb)), closes [#722](https://github.com/deanjstone/argus/issues/722)

# [3.7.0](https://github.com/deanjstone/argus/compare/v3.6.0...v3.7.0) (2026-10-17)


### Features

* **ops-hub:** label enforcement in the webhook handler and sweep ([#729](https://github.com/deanjstone/argus/issues/729)) ([#752](https://github.com/deanjstone/argus/issues/752)) ([4aaddb6](https://github.com/deanjstone/argus/commit/4aaddb6aca02141a9c2fcccf8164a21f8251f8c3))

# [3.6.0](https://github.com/deanjstone/argus/compare/v3.5.0...v3.6.0) (2026-10-17)


### Features

* **ops-hub:** real-App smoke script; fix BWS App key name ([#750](https://github.com/deanjstone/argus/issues/750)) ([688aee7](https://github.com/deanjstone/argus/commit/688aee79e4906e0b462f43c9bb2feba04398da70)), closes [#724](https://github.com/deanjstone/argus/issues/724) [#734](https://github.com/deanjstone/argus/issues/734)

# [3.5.0](https://github.com/deanjstone/argus/compare/v3.4.1...v3.5.0) (2026-10-17)


### Features

* **ops-hub:** derivation module, table logic and read views ([#727](https://github.com/deanjstone/argus/issues/727)) ([#748](https://github.com/deanjstone/argus/issues/748)) ([9f34e06](https://github.com/deanjstone/argus/commit/9f34e0674e14c18d03317d22fa44f55f6eab10c9))

## [3.4.1](https://github.com/deanjstone/argus/compare/v3.4.0...v3.4.1) (2026-10-17)


### Bug Fixes

* **watchtower-collector:** add /mnt/backups disk card, compute disk % like df ([#746](https://github.com/deanjstone/argus/issues/746)) ([03a3f4e](https://github.com/deanjstone/argus/commit/03a3f4e5f8dd9248e7859e207b120f49587e7014)), closes [#740](https://github.com/deanjstone/argus/issues/740)

# [3.4.0](https://github.com/deanjstone/argus/compare/v3.3.0...v3.4.0) (2026-10-17)


### Features

* **ops-hub:** GitHub gateway, fake GitHub, cache, webhook receiver and sweep ([#745](https://github.com/deanjstone/argus/issues/745)) ([f1ea0fb](https://github.com/deanjstone/argus/commit/f1ea0fb7e2846b5757dedc96c1fb1794c54fed16))

# [3.3.0](https://github.com/deanjstone/argus/compare/v3.2.0...v3.3.0) (2026-10-17)


### Features

* **ops-hub-web:** hub PWA shell — registry UI, routing, phone tab bar, palette, live updates, notice board ([#728](https://github.com/deanjstone/argus/issues/728)) ([#744](https://github.com/deanjstone/argus/issues/744)) ([f71337c](https://github.com/deanjstone/argus/commit/f71337c0507ca388e38421ab0db2ccf446677d82)), closes [#726](https://github.com/deanjstone/argus/issues/726)

# [3.2.0](https://github.com/deanjstone/argus/compare/v3.1.4...v3.2.0) (2026-10-17)


### Features

* **ops-hub:** hub server package absorbing the notice board ([#741](https://github.com/deanjstone/argus/issues/741)) ([8872385](https://github.com/deanjstone/argus/commit/88723857d0df8a455a28df145c45f68574410dc9))

## [3.1.4](https://github.com/deanjstone/argus/compare/v3.1.3...v3.1.4) (2026-10-12)


### Bug Fixes

* **vault-agent:** price claude-haiku-5-5 with a prompt-size tier ([#640](https://github.com/deanjstone/argus/issues/640)) ([2eae06d](https://github.com/deanjstone/argus/commit/2eae06d530461e5a292ff8b0bfbeb5579a8962d5)), closes [#634](https://github.com/deanjstone/argus/issues/634) [#634](https://github.com/deanjstone/argus/issues/634)

## [3.1.3](https://github.com/deanjstone/argus/compare/v3.1.2...v3.1.3) (2026-10-11)


### Bug Fixes

* **vault-agent:** price Opus 5 and the Claude 5.x ids from the published rate card ([#632](https://github.com/deanjstone/argus/issues/632)) ([78bc961](https://github.com/deanjstone/argus/commit/78bc9618e97b8b176c4a0dc55197ab3292db13c8)), closes [#605](https://github.com/deanjstone/argus/issues/605) [#605](https://github.com/deanjstone/argus/issues/605)

## [3.1.2](https://github.com/deanjstone/argus/compare/v3.1.1...v3.1.2) (2026-10-10)


### Bug Fixes

* **wiki:** raise vitest timeout for loaded CI runners ([#588](https://github.com/deanjstone/argus/issues/588)) ([#624](https://github.com/deanjstone/argus/issues/624)) ([cd2fc16](https://github.com/deanjstone/argus/commit/cd2fc167a345b55336144eb1aae97ef98a6679fc))

## [3.1.1](https://github.com/deanjstone/argus/compare/v3.1.0...v3.1.1) (2026-10-10)


### Bug Fixes

* **email:** report a killed real-Wrangler spawn as a timeout ([#585](https://github.com/deanjstone/argus/issues/585)) ([#623](https://github.com/deanjstone/argus/issues/623)) ([81edfb4](https://github.com/deanjstone/argus/commit/81edfb47f87ae9388d0984e89b7273bac96470c8))

# [3.1.0](https://github.com/deanjstone/argus/compare/v3.0.3...v3.1.0) (2026-10-10)


### Features

* **agent-engine:** make /task/run-plan browser-callable with per-task results ([#621](https://github.com/deanjstone/argus/issues/621)) ([b6d9aab](https://github.com/deanjstone/argus/commit/b6d9aaba83e45714818bd6dae38521f08f4f0e4f))

## [3.0.3](https://github.com/deanjstone/argus/compare/v3.0.2...v3.0.3) (2026-10-10)


### Bug Fixes

* **notice-board:** make claim idempotent per session so a timed-out hook can retry ([#617](https://github.com/deanjstone/argus/issues/617)) ([be2986a](https://github.com/deanjstone/argus/commit/be2986a9062074a1c10599c22a1d631713273aaa))

## [3.0.2](https://github.com/deanjstone/argus/compare/v3.0.1...v3.0.2) (2026-10-09)


### Bug Fixes

* **vault-agent:** remove the Loop tab limits that controlled nothing ([#564](https://github.com/deanjstone/argus/issues/564)) ([#600](https://github.com/deanjstone/argus/issues/600)) ([a93b8e1](https://github.com/deanjstone/argus/commit/a93b8e1d525ce41bbb6126b1bcee1fb40d92090c))

## [3.0.1](https://github.com/deanjstone/argus/compare/v3.0.0...v3.0.1) (2026-10-09)


### Bug Fixes

* **vault-agent:** only ENOENT/ENOTDIR mean missing in pathExists ([#563](https://github.com/deanjstone/argus/issues/563)) ([#597](https://github.com/deanjstone/argus/issues/597)) ([78a4e49](https://github.com/deanjstone/argus/commit/78a4e491b8601b269edab0cee1ff8695d9950f48))

# [3.0.0](https://github.com/deanjstone/argus/compare/v2.39.10...v3.0.0) (2026-10-09)


* feat(agent-cli)!: retire herdr-based open and listen commands ([#593](https://github.com/deanjstone/argus/issues/593)) ([106644e](https://github.com/deanjstone/argus/commit/106644e899159766a1d1461acae618f65baf46e2)), closes [argus#549](https://github.com/argus/issues/549)


### BREAKING CHANGES

* bare `agent` now prints help; `agent -p` and
`agent listen` no longer exist.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* drop hand-written changelog entry; semantic-release generates it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

## [2.39.10](https://github.com/deanjstone/argus/compare/v2.39.9...v2.39.10) (2026-10-09)


### Bug Fixes

* **memory-mcp:** let the reconciler delete a stale mirror of an earlier store version ([#559](https://github.com/deanjstone/argus/issues/559)) ([#594](https://github.com/deanjstone/argus/issues/594)) ([f41d91f](https://github.com/deanjstone/argus/commit/f41d91f0e1cd38ce28af29e6b8bafbd441188385)), closes [#484](https://github.com/deanjstone/argus/issues/484)

## [2.39.9](https://github.com/deanjstone/argus/compare/v2.39.8...v2.39.9) (2026-10-09)


### Bug Fixes

* **ci:** release from the tip of main, one run at a time ([#556](https://github.com/deanjstone/argus/issues/556)) ([#592](https://github.com/deanjstone/argus/issues/592)) ([fea24f5](https://github.com/deanjstone/argus/commit/fea24f55278a7632ff5611cd7a98c47c4acd48d8))

## [2.39.8](https://github.com/deanjstone/argus/compare/v2.39.7...v2.39.8) (2026-10-09)


### Bug Fixes

* **memory-mcp:** reject memory_remember keys that collide with a live key's mirror file ([#552](https://github.com/deanjstone/argus/issues/552)) ([#590](https://github.com/deanjstone/argus/issues/590)) ([5ceb7c3](https://github.com/deanjstone/argus/commit/5ceb7c38e0b44b86a14bc772e6ea328b396c24a4)), closes [#551](https://github.com/deanjstone/argus/issues/551)

## [2.39.7](https://github.com/deanjstone/argus/compare/v2.39.6...v2.39.7) (2026-10-08)


### Bug Fixes

* **vault-agent:** stop swallowing errors in migration, restore, audit-log and index paths ([#462](https://github.com/deanjstone/argus/issues/462)) ([#562](https://github.com/deanjstone/argus/issues/562)) ([78b6fbc](https://github.com/deanjstone/argus/commit/78b6fbc876bf0233918b5afd9e7eb099acdcaac4))

## [2.39.6](https://github.com/deanjstone/argus/compare/v2.39.5...v2.39.6) (2026-10-08)


### Bug Fixes

* **memory-mcp:** keep index placement, reachability and curated lines on update ([#560](https://github.com/deanjstone/argus/issues/560)) ([e5d62bf](https://github.com/deanjstone/argus/commit/e5d62bfc8a897f403e6c25dbadeba19069b93200)), closes [#464](https://github.com/deanjstone/argus/issues/464) [#467](https://github.com/deanjstone/argus/issues/467) [#470](https://github.com/deanjstone/argus/issues/470) [#464](https://github.com/deanjstone/argus/issues/464) [#467](https://github.com/deanjstone/argus/issues/467) [#470](https://github.com/deanjstone/argus/issues/470)

## [2.39.5](https://github.com/deanjstone/argus/compare/v2.39.4...v2.39.5) (2026-10-08)


### Bug Fixes

* **memory-mcp:** retry refused reconciler writes instead of losing them ([#484](https://github.com/deanjstone/argus/issues/484)) ([#558](https://github.com/deanjstone/argus/issues/558)) ([32d8b80](https://github.com/deanjstone/argus/commit/32d8b805899c08bd81b93e569b5a2da322cae1e6))

## [2.39.4](https://github.com/deanjstone/argus/compare/v2.39.3...v2.39.4) (2026-10-08)


### Bug Fixes

* **email:** give the real-Wrangler deploy-vapid test a scoped 20s timeout ([#533](https://github.com/deanjstone/argus/issues/533)) ([#557](https://github.com/deanjstone/argus/issues/557)) ([4210d20](https://github.com/deanjstone/argus/commit/4210d20ceba3a5ebfbbeb6f270d8bd9ad7837718))

## [2.39.3](https://github.com/deanjstone/argus/compare/v2.39.2...v2.39.3) (2026-10-08)


### Bug Fixes

* **memory-mcp:** emit mirror frontmatter in one canonical order ([#465](https://github.com/deanjstone/argus/issues/465)) ([#555](https://github.com/deanjstone/argus/issues/555)) ([e0aeaef](https://github.com/deanjstone/argus/commit/e0aeaef40e4967eeb443c7ff14ad08dfd237dd3b))

## [2.39.2](https://github.com/deanjstone/argus/compare/v2.39.1...v2.39.2) (2026-10-08)


### Bug Fixes

* **memory-mcp:** stamp source: provenance on the server from the transport ([#553](https://github.com/deanjstone/argus/issues/553)) ([c3fdc3d](https://github.com/deanjstone/argus/commit/c3fdc3d47fac0fee3f1a7c0b7fd4b0b078355d5c)), closes [#377](https://github.com/deanjstone/argus/issues/377)

## [2.39.1](https://github.com/deanjstone/argus/compare/v2.39.0...v2.39.1) (2026-10-08)


### Bug Fixes

* **memory-mcp:** make memory_forget's mirror delete find, verify and report the right page ([#551](https://github.com/deanjstone/argus/issues/551)) ([9885e4a](https://github.com/deanjstone/argus/commit/9885e4ac1482a09fcebbb9ebd681a3270dd5e525)), closes [argus#376](https://github.com/argus/issues/376) [#380](https://github.com/deanjstone/argus/issues/380) [#376](https://github.com/deanjstone/argus/issues/376)

# [2.39.0](https://github.com/deanjstone/argus/compare/v2.38.0...v2.39.0) (2026-10-08)


### Features

* **watchtower-collector:** add Duplicati adapter for lnv-lgn5 ([#547](https://github.com/deanjstone/argus/issues/547)) ([0ad5239](https://github.com/deanjstone/argus/commit/0ad52397124e1312e92969e28a24aed0cbc52a44)), closes [#284](https://github.com/deanjstone/argus/issues/284) [#546](https://github.com/deanjstone/argus/issues/546)

# [2.38.0](https://github.com/deanjstone/argus/compare/v2.37.0...v2.38.0) (2026-10-08)


### Features

* **agent-engine:** add POST /plans for ADR-010 plan publishing ([#545](https://github.com/deanjstone/argus/issues/545)) ([42dd012](https://github.com/deanjstone/argus/commit/42dd0124e57fdb1b3e0f5ae90b749dbef8aa81b4)), closes [myargus#143](https://github.com/myargus/issues/143) [#543](https://github.com/deanjstone/argus/issues/543) [myargus#214](https://github.com/myargus/issues/214)

# [2.37.0](https://github.com/deanjstone/argus/compare/v2.36.0...v2.37.0) (2026-10-07)


### Features

* **notice-board:** accept a homelab device token ([#542](https://github.com/deanjstone/argus/issues/542)) ([a8f4a8b](https://github.com/deanjstone/argus/commit/a8f4a8b9bb64fd1cf5ae14196de6dc9c446ec3e4))

# [2.36.0](https://github.com/deanjstone/argus/compare/v2.35.1...v2.36.0) (2026-10-07)


### Features

* **email:** swap apps/email UI to design-system registry components ([#534](https://github.com/deanjstone/argus/issues/534)) ([2388974](https://github.com/deanjstone/argus/commit/2388974b1305a767a8c07ca71624570696e9d855))

## [2.35.1](https://github.com/deanjstone/argus/compare/v2.35.0...v2.35.1) (2026-10-03)


### Bug Fixes

* **notice-board:** wait up to 60s for /healthz after restart ([#512](https://github.com/deanjstone/argus/issues/512)) ([6d0dd50](https://github.com/deanjstone/argus/commit/6d0dd5061a9c49fc2f49b5b93609ef6ade73726a)), closes [#510](https://github.com/deanjstone/argus/issues/510)

# [2.35.0](https://github.com/deanjstone/argus/compare/v2.34.0...v2.35.0) (2026-10-03)


### Features

* **notice-board-web:** call the board same-origin and build it in deploy.sh ([#509](https://github.com/deanjstone/argus/issues/509)) ([9af11d6](https://github.com/deanjstone/argus/commit/9af11d60a37f639ffba7d24d75c92efae43789dc))

# [2.34.0](https://github.com/deanjstone/argus/compare/v2.33.2...v2.34.0) (2026-10-03)


### Features

* **notice-board:** serve the PWA build on the board's own origin ([#507](https://github.com/deanjstone/argus/issues/507)) ([c22341c](https://github.com/deanjstone/argus/commit/c22341cb592199230221e0cee445288ff042f356)), closes [homelab#125](https://github.com/homelab/issues/125)

## [2.33.2](https://github.com/deanjstone/argus/compare/v2.33.1...v2.33.2) (2026-10-02)


### Bug Fixes

* **notice-board-web:** clear the iOS status-bar blur above the header ([#506](https://github.com/deanjstone/argus/issues/506)) ([aa84f18](https://github.com/deanjstone/argus/commit/aa84f184ce87abf244359f685672155ca194771a))

## [2.33.1](https://github.com/deanjstone/argus/compare/v2.33.0...v2.33.1) (2026-10-02)


### Bug Fixes

* **notice-board-web:** retry the settings check that a fresh install makes first ([#505](https://github.com/deanjstone/argus/issues/505)) ([173ba59](https://github.com/deanjstone/argus/commit/173ba59333ab4940af7f8398691cc6bc1f92f06e))

# [2.33.0](https://github.com/deanjstone/argus/compare/v2.32.1...v2.33.0) (2026-10-02)


### Features

* **notice-board-web:** ship to Pages at board.myargus.cc behind Access ([#493](https://github.com/deanjstone/argus/issues/493)) ([a797604](https://github.com/deanjstone/argus/commit/a797604400234e662850d1e92a42d089ebb9f1b0)), closes [#479](https://github.com/deanjstone/argus/issues/479)

## [2.32.1](https://github.com/deanjstone/argus/compare/v2.32.0...v2.32.1) (2026-10-02)


### Bug Fixes

* **memory-mcp:** route stdio import tools through the selected backend ([#502](https://github.com/deanjstone/argus/issues/502)) ([9b32775](https://github.com/deanjstone/argus/commit/9b3277523fcb544e913426a423d82cecd2467617)), closes [#367](https://github.com/deanjstone/argus/issues/367) [#494](https://github.com/deanjstone/argus/issues/494)
* **vault-agent-relay:** correlate on relay-assigned ids, not the caller's ([#501](https://github.com/deanjstone/argus/issues/501)) ([73ebc68](https://github.com/deanjstone/argus/commit/73ebc6890c0e18acabb4a4552fda1869e7427f9d)), closes [#495](https://github.com/deanjstone/argus/issues/495)

# [2.32.0](https://github.com/deanjstone/argus/compare/v2.31.1...v2.32.0) (2026-10-02)


### Features

* **notice-board-web:** notice-board PWA on design-system primitives ([#490](https://github.com/deanjstone/argus/issues/490)) ([6bbbbac](https://github.com/deanjstone/argus/commit/6bbbbac6d1667c7db72a60d1722cb086b8e0f7bc)), closes [#480](https://github.com/deanjstone/argus/issues/480)

## [2.31.1](https://github.com/deanjstone/argus/compare/v2.31.0...v2.31.1) (2026-10-02)


### Bug Fixes

* **notice-board:** set busy_timeout before switching to WAL ([#491](https://github.com/deanjstone/argus/issues/491)) ([e17c7df](https://github.com/deanjstone/argus/commit/e17c7df690ea602aa6ab2dc0f1bca75e96ad9a6f))

# [2.31.0](https://github.com/deanjstone/argus/compare/v2.30.0...v2.31.0) (2026-10-02)


### Features

* **notice-board:** push new messages to the phone via brrr ([#489](https://github.com/deanjstone/argus/issues/489)) ([d396bae](https://github.com/deanjstone/argus/commit/d396baed7a6f4ace05571e8e0d9a7ab772242f20)), closes [#478](https://github.com/deanjstone/argus/issues/478)

# [2.30.0](https://github.com/deanjstone/argus/compare/v2.29.0...v2.30.0) (2026-10-02)


### Features

* **notice-board:** claim by raw origin ([#488](https://github.com/deanjstone/argus/issues/488)) ([50c732b](https://github.com/deanjstone/argus/commit/50c732b1a5a57a1e3bb1650d0eb930317bf4d1b9)), closes [#476](https://github.com/deanjstone/argus/issues/476)

# [2.29.0](https://github.com/deanjstone/argus/compare/v2.28.0...v2.29.0) (2026-10-02)


### Features

* **notice-board:** MCP tools and session ack ([#485](https://github.com/deanjstone/argus/issues/485)) ([a8ba290](https://github.com/deanjstone/argus/commit/a8ba290d0db3f873867c2601c33b5b02f3980c16)), closes [#477](https://github.com/deanjstone/argus/issues/477)

# [2.28.0](https://github.com/deanjstone/argus/compare/v2.27.0...v2.28.0) (2026-10-02)


### Features

* **notice-board:** homelab systemd unit and deploy.sh ([#483](https://github.com/deanjstone/argus/issues/483)) ([27cf41b](https://github.com/deanjstone/argus/commit/27cf41b6e6125eaddf81e1fca4978d2ed79ae921)), closes [#475](https://github.com/deanjstone/argus/issues/475)

# [2.27.0](https://github.com/deanjstone/argus/compare/v2.26.0...v2.27.0) (2026-10-02)


### Features

* **notice-board:** service core — queue, claim/lease/ack, SSE ([#482](https://github.com/deanjstone/argus/issues/482)) ([0e7f324](https://github.com/deanjstone/argus/commit/0e7f324b353044f8a3540273df6c49397b5559f0)), closes [#474](https://github.com/deanjstone/argus/issues/474) [#474](https://github.com/deanjstone/argus/issues/474)

# [2.26.0](https://github.com/deanjstone/argus/compare/v2.25.0...v2.26.0) (2026-09-30)


### Features

* **memory-mcp:** v2 memory type enum and the store half of the migration ([#454](https://github.com/deanjstone/argus/issues/454)) ([99f0d21](https://github.com/deanjstone/argus/commit/99f0d214540742acfc7cf0523281c08cd63a334f)), closes [context#213](https://github.com/context/issues/213) [argus#367](https://github.com/argus/issues/367) [context#213](https://github.com/context/issues/213)

# [2.25.0](https://github.com/deanjstone/argus/compare/v2.24.1...v2.25.0) (2026-09-30)


### Features

* **memory-mcp:** require a reason when memory_remember updates a memory ([#453](https://github.com/deanjstone/argus/issues/453)) ([98435a2](https://github.com/deanjstone/argus/commit/98435a2689c6e800ae61b61929279ea8fa6fabf2)), closes [context#205](https://github.com/context/issues/205)

## [2.24.1](https://github.com/deanjstone/argus/compare/v2.24.0...v2.24.1) (2026-09-30)


### Bug Fixes

* **memory-mcp:** index a resolved page under its real filename ([#431](https://github.com/deanjstone/argus/issues/431)) ([#449](https://github.com/deanjstone/argus/issues/449)) ([85f796c](https://github.com/deanjstone/argus/commit/85f796ca8027bee0e54acc0a3352f3bb84279495)), closes [#441](https://github.com/deanjstone/argus/issues/441)

# [2.24.0](https://github.com/deanjstone/argus/compare/v2.23.3...v2.24.0) (2026-09-30)


### Features

* **memory-mcp:** own its systemd units and install them from deploy.sh ([#446](https://github.com/deanjstone/argus/issues/446)) ([8e13c8e](https://github.com/deanjstone/argus/commit/8e13c8eee3710f21edcb56587cdb06c8a9eb4d58)), closes [argus-config#338](https://github.com/argus-config/issues/338)

## [2.23.3](https://github.com/deanjstone/argus/compare/v2.23.2...v2.23.3) (2026-09-29)


### Bug Fixes

* **memory-mcp:** publish mirror writes before the live vault changes ([#441](https://github.com/deanjstone/argus/issues/441)) ([dc2320d](https://github.com/deanjstone/argus/commit/dc2320d9968c07f9310d0c0a38f2580ba325eda0)), closes [#436](https://github.com/deanjstone/argus/issues/436) [#437](https://github.com/deanjstone/argus/issues/437) [#438](https://github.com/deanjstone/argus/issues/438)

## [2.23.2](https://github.com/deanjstone/argus/compare/v2.23.1...v2.23.2) (2026-09-29)


### Bug Fixes

* **memory-mcp:** guard reconciler against unsafe vault git state ([#429](https://github.com/deanjstone/argus/issues/429)) ([#430](https://github.com/deanjstone/argus/issues/430)) ([b3a6cfe](https://github.com/deanjstone/argus/commit/b3a6cfeb5002c143979079f813a0d4a7a98ee162))

## [2.23.1](https://github.com/deanjstone/argus/compare/v2.23.0...v2.23.1) (2026-09-24)


### Bug Fixes

* **watchtower-collector:** reach homelab Syncthing over its pinned TLS cert ([#412](https://github.com/deanjstone/argus/issues/412)) ([64a928f](https://github.com/deanjstone/argus/commit/64a928fe114f872e0159cd6065fa342434b84432))

# [2.23.0](https://github.com/deanjstone/argus/compare/v2.22.0...v2.23.0) (2026-09-12)


### Features

* **vault-agent:** RelayClient, the vault end of the remote MCP relay ([#391](https://github.com/deanjstone/argus/issues/391)) ([3bca5ff](https://github.com/deanjstone/argus/commit/3bca5ff2db791f204f7af2e30cabbbc43b65e1a2))

# [2.22.0](https://github.com/deanjstone/argus/compare/v2.21.2...v2.22.0) (2026-09-12)


### Features

* **vault-agent-relay:** Worker and Durable Object for remote MCP access ([#387](https://github.com/deanjstone/argus/issues/387)) ([ae8b663](https://github.com/deanjstone/argus/commit/ae8b6636c9db8de9ff75f4078c843b5cf86209ef))

## [2.21.2](https://github.com/deanjstone/argus/compare/v2.21.1...v2.21.2) (2026-09-12)


### Bug Fixes

* **memory-mcp:** resolve a mirror page by name before deriving a new one ([#386](https://github.com/deanjstone/argus/issues/386)) ([545d98b](https://github.com/deanjstone/argus/commit/545d98bcb1e0e3593c02354d8d055ae794be23ed))

## [2.21.1](https://github.com/deanjstone/argus/compare/v2.21.0...v2.21.1) (2026-09-12)


### Bug Fixes

* **memory-mcp:** stop the reconciler overwriting mirror files the store never saw ([#385](https://github.com/deanjstone/argus/issues/385)) ([c3be841](https://github.com/deanjstone/argus/commit/c3be841b1a0cf6fcf7a475dd819cb1e1526852d3)), closes [context#153](https://github.com/context/issues/153)

# [2.21.0](https://github.com/deanjstone/argus/compare/v2.20.2...v2.21.0) (2026-09-12)


### Features

* **memory-mcp:** expose the applies_to scope lookup for the SessionStart signal ([#384](https://github.com/deanjstone/argus/issues/384)) ([6d0778e](https://github.com/deanjstone/argus/commit/6d0778e90882a774aa2513a1a1764de58a1a79dc)), closes [context#153](https://github.com/context/issues/153)

## [2.20.2](https://github.com/deanjstone/argus/compare/v2.20.1...v2.20.2) (2026-09-12)


### Bug Fixes

* **memory-mcp:** carry applies_to through the reconciler ([#378](https://github.com/deanjstone/argus/issues/378)) ([11cac67](https://github.com/deanjstone/argus/commit/11cac67b9a46c4512ff5b342d62fd8f4c565e6c5)), closes [argus#268](https://github.com/argus/issues/268)

## [2.20.1](https://github.com/deanjstone/argus/compare/v2.20.0...v2.20.1) (2026-09-11)


### Bug Fixes

* **ci:** give the D1 migration step its own token ([#375](https://github.com/deanjstone/argus/issues/375)) ([86c0187](https://github.com/deanjstone/argus/commit/86c018791e7e80f0da7df85d07e25268269c950d)), closes [#372](https://github.com/deanjstone/argus/issues/372) [#374](https://github.com/deanjstone/argus/issues/374)

# [2.20.0](https://github.com/deanjstone/argus/compare/v2.19.0...v2.20.0) (2026-09-11)


### Features

* **memory-mcp:** applies_to as a validated frontmatter field ([#268](https://github.com/deanjstone/argus/issues/268)) ([#371](https://github.com/deanjstone/argus/issues/371)) ([71e6d4f](https://github.com/deanjstone/argus/commit/71e6d4fb1317c19d2fe684c3e721e40603c071b3))

# [2.19.0](https://github.com/deanjstone/argus/compare/v2.18.0...v2.19.0) (2026-09-10)


### Features

* **memory-mcp:** store→files reconciler per ADR-005 ([#322](https://github.com/deanjstone/argus/issues/322)) ([#324](https://github.com/deanjstone/argus/issues/324)) ([d2372b4](https://github.com/deanjstone/argus/commit/d2372b4c3d1ae5fe3778b94a109c991aa80a9bd2)), closes [#319](https://github.com/deanjstone/argus/issues/319) [context#160](https://github.com/context/issues/160) [context#155](https://github.com/context/issues/155) [context#149](https://github.com/context/issues/149)

# [2.18.0](https://github.com/deanjstone/argus/compare/v2.17.4...v2.18.0) (2026-09-08)


### Bug Fixes

* **agent-cli:** drop doctor checks for decommissioned ccbot and tmux session ([#366](https://github.com/deanjstone/argus/issues/366)) ([6ace7b2](https://github.com/deanjstone/argus/commit/6ace7b204239bc5b108f9e5ec3d2ae5ade819d6e)), closes [argus#302](https://github.com/argus/issues/302) [deanjstone/argus#302](https://github.com/deanjstone/argus/issues/302) [deanjstone/argus-config#294](https://github.com/deanjstone/argus-config/issues/294)


### Features

* **252:** fail-closed migration verification + route the runtime scripts through the backend switch ([#365](https://github.com/deanjstone/argus/issues/365)) ([c6612dd](https://github.com/deanjstone/argus/commit/c6612ddd3bb5c7833cb88316b38108616c8d2e78)), closes [#252](https://github.com/deanjstone/argus/issues/252) [#249](https://github.com/deanjstone/argus/issues/249) [#298](https://github.com/deanjstone/argus/issues/298) [argus#252](https://github.com/argus/issues/252) [argus#252](https://github.com/argus/issues/252)

## [2.17.4](https://github.com/deanjstone/argus/compare/v2.17.3...v2.17.4) (2026-09-07)


### Bug Fixes

* **memory-mcp:** make absent Vectorize/AI bindings explicit, stop swallowing TypeErrors ([#354](https://github.com/deanjstone/argus/issues/354)) ([0042f60](https://github.com/deanjstone/argus/commit/0042f60816f17c940993b078ba3eadb8c801c929)), closes [#342](https://github.com/deanjstone/argus/issues/342)

## [2.17.3](https://github.com/deanjstone/argus/compare/v2.17.2...v2.17.3) (2026-09-06)


### Bug Fixes

* **ccbot:** drop dead ~/argus bare-root project matcher ([#340](https://github.com/deanjstone/argus/issues/340)) ([84653d0](https://github.com/deanjstone/argus/commit/84653d056ae3caffd3e1b2409d72ed3d9e86caa8)), closes [#278](https://github.com/deanjstone/argus/issues/278)

## [2.17.2](https://github.com/deanjstone/argus/compare/v2.17.1...v2.17.2) (2026-09-06)


### Reverts

* Revert "ci: serialize workflows on the shared homelab runners ([#350](https://github.com/deanjstone/argus/issues/350))" ([#351](https://github.com/deanjstone/argus/issues/351)) ([3ce2eee](https://github.com/deanjstone/argus/commit/3ce2eee4346790b630ef997bb52601c1379eed4a))

## [2.17.1](https://github.com/deanjstone/argus/compare/v2.17.0...v2.17.1) (2026-09-06)


### Bug Fixes

* **watchtower:** generate Worker types before building ([#349](https://github.com/deanjstone/argus/issues/349)) ([fdb16f5](https://github.com/deanjstone/argus/commit/fdb16f5f26248974e597ecf90da7453f12b45191))

# [2.17.0](https://github.com/deanjstone/argus/compare/v2.16.1...v2.17.0) (2026-09-06)


### Features

* **memory-mcp:** write flat frontmatter, read both shapes ([#343](https://github.com/deanjstone/argus/issues/343)) ([cb3ddbe](https://github.com/deanjstone/argus/commit/cb3ddbeadcea7f8f3df67e407ad7685a6f0352db)), closes [context#163](https://github.com/context/issues/163)

## [2.16.1](https://github.com/deanjstone/argus/compare/v2.16.0...v2.16.1) (2026-09-06)


### Bug Fixes

* **x-mcp:** stop deploy.sh chmod'ing argus-config's tracked file ([#339](https://github.com/deanjstone/argus/issues/339)) ([f9801e5](https://github.com/deanjstone/argus/commit/f9801e533e6bb819bd69a59c3ac8814d88a8d926)), closes [argus-config#272](https://github.com/argus-config/issues/272)

# [2.16.0](https://github.com/deanjstone/argus/compare/v2.15.0...v2.16.0) (2026-09-05)


### Features

* **email-worker:** forward inbound agent email to a personal inbox ([5f67bb9](https://github.com/deanjstone/argus/commit/5f67bb9b081fc71b251b50bac77d9d9f1a2177dd))

# [2.15.0](https://github.com/deanjstone/argus/compare/v2.14.0...v2.15.0) (2026-09-05)


### Features

* **code-relay:** add the herdr-scoped Telegram bot, on one shared poller ([#333](https://github.com/deanjstone/argus/issues/333)) ([a3b4e90](https://github.com/deanjstone/argus/commit/a3b4e903d27390297e9ee3aa6cfdd65ced314dbb)), closes [#282](https://github.com/deanjstone/argus/issues/282)

# [2.14.0](https://github.com/deanjstone/argus/compare/v2.13.0...v2.14.0) (2026-09-04)


### Features

* **code-relay:** rebuild the PWA around the live session stream ([#332](https://github.com/deanjstone/argus/issues/332)) ([14ed675](https://github.com/deanjstone/argus/commit/14ed675a0973c62f0d212a9fc4a5434707658440)), closes [#280](https://github.com/deanjstone/argus/issues/280) [#281](https://github.com/deanjstone/argus/issues/281) [#277](https://github.com/deanjstone/argus/issues/277) [#279](https://github.com/deanjstone/argus/issues/279)

# [2.13.0](https://github.com/deanjstone/argus/compare/v2.12.0...v2.13.0) (2026-09-04)


### Features

* **code-relay:** fire a brrr.now push when an agent pane blocks ([#331](https://github.com/deanjstone/argus/issues/331)) ([6cf2d6a](https://github.com/deanjstone/argus/commit/6cf2d6ab0d3beb3b29a8ea36725ec6c60c9e1dc9)), closes [#280](https://github.com/deanjstone/argus/issues/280) [#281](https://github.com/deanjstone/argus/issues/281)

# [2.12.0](https://github.com/deanjstone/argus/compare/v2.11.0...v2.12.0) (2026-09-04)


### Features

* **code-relay:** enrich ApprovalRequested with real blocked-pane content ([#329](https://github.com/deanjstone/argus/issues/329)) ([c8632a9](https://github.com/deanjstone/argus/commit/c8632a95a4a6cf2e06a875761a0338d329ac4a29)), closes [#280](https://github.com/deanjstone/argus/issues/280)
* **x-mcp:** read-only X MCP server with bookmark reads ([#330](https://github.com/deanjstone/argus/issues/330)) ([d7479d5](https://github.com/deanjstone/argus/commit/d7479d598c23a2141c6f514b85d2f3b8bea26409)), closes [argus#230](https://github.com/argus/issues/230) [#230](https://github.com/deanjstone/argus/issues/230) [#230](https://github.com/deanjstone/argus/issues/230) [#230](https://github.com/deanjstone/argus/issues/230)

# [2.11.0](https://github.com/deanjstone/argus/compare/v2.10.0...v2.11.0) (2026-08-28)


### Bug Fixes

* **vault-agent:** default local endpoints to 127.0.0.1, and close two package-convention gaps ([f42d7bb](https://github.com/deanjstone/argus/commit/f42d7bbd7fedeb28c3c5551841c47d6554c5e93f)), closes [#319](https://github.com/deanjstone/argus/issues/319)


### Features

* **vault-agent:** drive the turn from the Claude Agent SDK, not a second loop ([7bec714](https://github.com/deanjstone/argus/commit/7bec7140a54262e3c4063f6db90030dac2ffc4b4))
* **vault-agent:** vendor vault-operator and replace its model layer with the Claude Agent SDK ([2c60cfe](https://github.com/deanjstone/argus/commit/2c60cfe6566075fd8ae3e2cc29506b7988774ddb)), closes [#303](https://github.com/deanjstone/argus/issues/303) [#304](https://github.com/deanjstone/argus/issues/304) [#307](https://github.com/deanjstone/argus/issues/307) [#308](https://github.com/deanjstone/argus/issues/308) [#310](https://github.com/deanjstone/argus/issues/310) [#311](https://github.com/deanjstone/argus/issues/311)

# [2.10.0](https://github.com/deanjstone/argus/compare/v2.9.5...v2.10.0) (2026-08-17)


### Features

* **memory-mcp:** add the stdio -> Worker data-plane client, opt-in ([#298](https://github.com/deanjstone/argus/issues/298)) ([d154660](https://github.com/deanjstone/argus/commit/d154660757a536407b7d68866837a01b6d58694d)), closes [#249](https://github.com/deanjstone/argus/issues/249)

## [2.9.5](https://github.com/deanjstone/argus/compare/v2.9.4...v2.9.5) (2026-08-17)


### Bug Fixes

* **deploy:** don't cp the launch script onto itself when ~/.argus/hooks is a symlink ([#294](https://github.com/deanjstone/argus/issues/294)) ([ee0d2fd](https://github.com/deanjstone/argus/commit/ee0d2fddf1e696007c36219c3bfb84d392659838)), closes [argus-config#178](https://github.com/argus-config/issues/178) [argus#291](https://github.com/argus/issues/291) [argus#292](https://github.com/argus/issues/292)

## [2.9.4](https://github.com/deanjstone/argus/compare/v2.9.3...v2.9.4) (2026-08-17)


### Bug Fixes

* **memory-mcp:** don't silently commit the CONTEXT mirror to a non-main branch ([#293](https://github.com/deanjstone/argus/issues/293)) ([436d857](https://github.com/deanjstone/argus/commit/436d857b3cc999df0d2f25b96cac28a3e8c18ace))

## [2.9.3](https://github.com/deanjstone/argus/compare/v2.9.2...v2.9.3) (2026-08-17)


### Bug Fixes

* **memory-mcp:** generate Cloudflare types on build, not just on typecheck ([#292](https://github.com/deanjstone/argus/issues/292)) ([04692ab](https://github.com/deanjstone/argus/commit/04692ab6ec0c44da30266aec82d02a6e0ed708a9)), closes [#291](https://github.com/deanjstone/argus/issues/291)

## [2.9.2](https://github.com/deanjstone/argus/compare/v2.9.1...v2.9.2) (2026-08-17)


### Bug Fixes

* **memory-mcp:** select release by tag prefix, not "newest in the repo" ([#291](https://github.com/deanjstone/argus/issues/291)) ([7f294c9](https://github.com/deanjstone/argus/commit/7f294c98698d3b4b892c68148e473b120e531ce0)), closes [#262](https://github.com/deanjstone/argus/issues/262)

## [2.9.1](https://github.com/deanjstone/argus/compare/v2.9.0...v2.9.1) (2026-08-14)


### Bug Fixes

* **agent-cli:** fix HOME override no-op in projects.test.ts ([#255](https://github.com/deanjstone/argus/issues/255)) ([62cb0ab](https://github.com/deanjstone/argus/commit/62cb0ab34596eb407475cdeec9aaae41315416ec)), closes [#208](https://github.com/deanjstone/argus/issues/208)

# [2.9.0](https://github.com/deanjstone/argus/compare/v2.8.0...v2.9.0) (2026-08-14)


### Features

* live-provision D1/Vectorize resources + migrate real data (argus[#252](https://github.com/deanjstone/argus/issues/252) phase 2) ([#253](https://github.com/deanjstone/argus/issues/253)) ([34fea04](https://github.com/deanjstone/argus/commit/34fea0438c823ceb7d9d1d5f93e7829604a37d42))

# [2.8.0](https://github.com/deanjstone/argus/compare/v2.7.1...v2.8.0) (2026-08-10)


### Features

* **agent-email:** wire real D1/R2 IDs and fix Workers Route path prefix (Stage 4) ([#225](https://github.com/deanjstone/argus/issues/225)) ([8a28239](https://github.com/deanjstone/argus/commit/8a28239a0204f83e79bedaf9cca1040580d0aff4))

## [2.7.1](https://github.com/deanjstone/argus/compare/v2.7.0...v2.7.1) (2026-08-10)


### Bug Fixes

* **ccbot:** default AGENT_VIEW_BACKEND to herdr in deploy.sh ([#224](https://github.com/deanjstone/argus/issues/224)) ([03e3d1d](https://github.com/deanjstone/argus/commit/03e3d1df4c6119b76a3ae03e0bd105df440b99ad)), closes [argus#135](https://github.com/argus/issues/135)

# [2.7.0](https://github.com/deanjstone/argus/compare/v2.6.0...v2.7.0) (2026-08-10)


### Features

* **agent-email-mcp:** implement stdio transport's storage backend (Stage 3b) ([#212](https://github.com/deanjstone/argus/issues/212)) ([c8e140a](https://github.com/deanjstone/argus/commit/c8e140aff5b8415320cb5c3e454f4c0a54fc6ddf)), closes [#1](https://github.com/deanjstone/argus/issues/1)

# [2.6.0](https://github.com/deanjstone/argus/compare/v2.5.0...v2.6.0) (2026-08-10)


### Features

* **agent-email-mcp:** implement 7-tool surface on the Worker transport ([#211](https://github.com/deanjstone/argus/issues/211)) ([03f4491](https://github.com/deanjstone/argus/commit/03f4491c398c62397e1660d80fe65460e2aff3e5)), closes [#2](https://github.com/deanjstone/argus/issues/2)

# [2.5.0](https://github.com/deanjstone/argus/compare/v2.4.0...v2.5.0) (2026-08-10)


### Features

* **agent-email:** implement outbound send path (Cloudflare Email Sending REST API) ([#210](https://github.com/deanjstone/argus/issues/210)) ([325d9c4](https://github.com/deanjstone/argus/commit/325d9c4483e6271c3868bdb3f7e2bb0ed7a1f620))

# [2.4.0](https://github.com/deanjstone/argus/compare/v2.3.0...v2.4.0) (2026-08-10)


### Features

* **agent-email:** implement inbound path (D1/R2, MIME, threading) ([#209](https://github.com/deanjstone/argus/issues/209)) ([ab6b962](https://github.com/deanjstone/argus/commit/ab6b962681388d6243de55ba5a692d4463556414))

# [2.3.0](https://github.com/deanjstone/argus/compare/v2.2.0...v2.3.0) (2026-08-10)


### Features

* **agent-email:** scaffold agent-email + agent-email-mcp packages ([#207](https://github.com/deanjstone/argus/issues/207)) ([0d3419a](https://github.com/deanjstone/argus/commit/0d3419a5ccf652cb1b12015c9cee5291f7d8413f)), closes [argus#124](https://github.com/argus/issues/124) [argus#208](https://github.com/argus/issues/208)

# [2.2.0](https://github.com/deanjstone/argus/compare/v2.1.0...v2.2.0) (2026-08-10)


### Features

* **mcp-server:** add memory_remember topic param, retarget mirror index writes ([#200](https://github.com/deanjstone/argus/issues/200)) ([ab7cb92](https://github.com/deanjstone/argus/commit/ab7cb92c48d2c3cea040f000470523faa366f583)), closes [context#109](https://github.com/context/issues/109)

# [2.1.0](https://github.com/deanjstone/argus/compare/v2.0.0...v2.1.0) (2026-08-10)


### Features

* **agent-engine:** stream Claude/Haiku CLI output via stream-json ([#198](https://github.com/deanjstone/argus/issues/198)) ([8ecd3ee](https://github.com/deanjstone/argus/commit/8ecd3ee77f38eef02175c4ace81a3e34d78d3222))

# [2.0.0](https://github.com/deanjstone/argus/compare/v1.0.1...v2.0.0) (2026-08-10)


* Rename OpenWiki identifiers and env vars to ArgusWiki in src ([#197](https://github.com/deanjstone/argus/issues/197)) ([ae2be6b](https://github.com/deanjstone/argus/commit/ae2be6bcaefe7febfc98c231bb9a06130b963b03)), closes [#187](https://github.com/deanjstone/argus/issues/187) [#188](https://github.com/deanjstone/argus/issues/188)


### BREAKING CHANGES

* env var names changed (e.g. OPENWIKI_PROVIDER ->
ARGUSWIKI_PROVIDER, OPENWIKI_DEV -> ARGUSWIKI_DEV, OPENWIKI_HOME ->
ARGUSWIKI_HOME). Anyone with old env var names set externally (systemd
units, CI secrets, .env files) must update them.

## [1.0.1](https://github.com/deanjstone/argus/compare/v1.0.0...v1.0.1) (2026-08-09)


### Bug Fixes

* **release:** disable @semantic-release/github success/fail comments ([#195](https://github.com/deanjstone/argus/issues/195)) ([f8700a7](https://github.com/deanjstone/argus/commit/f8700a7623cba507bb22998fb83df0b8930c187b))

# 1.0.0 (2026-08-09)


### Bug Fixes

* add configurable provider retry attempts ([#239](https://github.com/deanjstone/argus/issues/239)) ([8636659](https://github.com/deanjstone/argus/commit/8636659273c91f6171d93408226d8e60e894408b))
* add Gemini API key to credential redaction and add missing unicode regex flags ([#378](https://github.com/deanjstone/argus/issues/378)) ([703ab52](https://github.com/deanjstone/argus/commit/703ab52b7fe8a9b98aea38a0b79c12b7ba4e3e8b))
* add OPENAI_COMPATIBLE_API_KEY to secret redaction list ([#245](https://github.com/deanjstone/argus/issues/245)) ([9933a93](https://github.com/deanjstone/argus/commit/9933a93ee9354c26907e1564bfc1fce631397d7a))
* **agent-cli:** also fix isRoot label in explicit subpath branch ([f7aa98e](https://github.com/deanjstone/argus/commit/f7aa98efa20be61c04ad6b1a84c7585c8bcff70b))
* **agent-cli:** base64-encode wt.exe payload to fully neutralize its command-line parser ([#102](https://github.com/deanjstone/argus/issues/102)) ([03f93b5](https://github.com/deanjstone/argus/commit/03f93b55994d3d0105d80acc601269b22c8e6ede))
* **agent-cli:** nest forks dir under repos root, exclude from project list ([#141](https://github.com/deanjstone/argus/issues/141)) ([f8a3889](https://github.com/deanjstone/argus/commit/f8a3889d8c60f5708dabb3e2b28ca68d2165244f)), closes [deanjstone/argus-config#135](https://github.com/deanjstone/argus-config/issues/135)
* **agent-cli:** rename no-flag session label from ARGUS to AGENT ([1968220](https://github.com/deanjstone/argus/commit/1968220ad9c60bf83310b5c21284af67a56d9c5e))
* **agent-cli:** suffix monorepo root label with -ROOT to prevent ARGUS session collision ([5f209bc](https://github.com/deanjstone/argus/commit/5f209bc6225e1f44f814515d9a718e9d5f5edfd0))
* **agent-cli:** update ~/projects reference in server.ts error message ([#145](https://github.com/deanjstone/argus/issues/145)) ([950090a](https://github.com/deanjstone/argus/commit/950090ac6395fdeea9aa8f770c006468b14ab9f5)), closes [141/#142](https://github.com/deanjstone/argus/issues/142)
* **agent-cli:** update CLI help and doctor output to ~/repos ([#142](https://github.com/deanjstone/argus/issues/142)) ([33eed40](https://github.com/deanjstone/argus/commit/33eed407f138227a63831618550846fa16f3b245)), closes [#141](https://github.com/deanjstone/argus/issues/141)
* **agent-cli:** walk up dir tree to resolve WT tab color for sub-packages ([2fa59fa](https://github.com/deanjstone/argus/commit/2fa59fa69bfd28dcb6da8ecf1ad866dec6f1e246))
* **agent-engine:** fix DAG task routing and remove redundant task tool ([717926e](https://github.com/deanjstone/argus/commit/717926ebfb101b7c348c85d1e348686835fa9e1e))
* **agent-engine:** sync node_modules, handle empty DAG plan, add atto1 context ([78f06cc](https://github.com/deanjstone/argus/commit/78f06cc87afaf5df87b548142460ea1ea8cc8612))
* **agent-listen:** let custom session name override the auto-generated project label ([#93](https://github.com/deanjstone/argus/issues/93)) ([79c3d45](https://github.com/deanjstone/argus/commit/79c3d45b490236cf20b265069196717439dbc893))
* **agent-view-monitor:** use absolute paths for claude/herdr binaries ([08a875e](https://github.com/deanjstone/argus/commit/08a875efb0a341ba9eb676e18b0715f7200eefff))
* **agent:** keep init update checkpoints ephemeral ([#259](https://github.com/deanjstone/argus/issues/259)) ([5187a54](https://github.com/deanjstone/argus/commit/5187a5433992cf7269a00e792d9ff358ad906105))
* **agent:** shell-escape claudeArgs to preserve prompt strings in launched sessions ([439aef4](https://github.com/deanjstone/argus/commit/439aef45252007767d3a3bd10b7f534a11e6615e))
* apply prettier formatting to pre-existing files ([927d48b](https://github.com/deanjstone/argus/commit/927d48ba8a7f4378def7f6ca2b71e632e0599666)), closes [#35](https://github.com/deanjstone/argus/issues/35)
* argus CLI — always emit new-tab, add --title, drop rename from launch.sh ([f53d700](https://github.com/deanjstone/argus/commit/f53d70078e9faf50e611b12319cda68811a4c781))
* better styled cli, better onboarding ([082aa7b](https://github.com/deanjstone/argus/commit/082aa7b275c5798a16e62175a1e73fce484679ef))
* **build:** replace rm -rf with cross-platform node script ([#196](https://github.com/deanjstone/argus/issues/196)) ([56049b3](https://github.com/deanjstone/argus/commit/56049b384aa101a0c11a4c34e61aee60249439e5))
* **ccbot:** await injector.injectCommand in SlackSocketHandler to catch errors ([a810e04](https://github.com/deanjstone/argus/commit/a810e040ed622453069ab3a3fadec446f2ca58ae))
* **ccbot:** scope memory-apply background agents with --allowedTools ([337ca2f](https://github.com/deanjstone/argus/commit/337ca2f3e685c5a27edce2831e5f99c0cc0971bd))
* chatgpt login with 5.6-luna ([#268](https://github.com/deanjstone/argus/issues/268)) ([392fe5e](https://github.com/deanjstone/argus/commit/392fe5e2c80d19415892bafaa163c668a0329853))
* **ci:** set least-privilege permissions and pin pnpm/action-setup SHA ([#146](https://github.com/deanjstone/argus/issues/146)) ([12055db](https://github.com/deanjstone/argus/commit/12055db1b2bcbd08335292b53cb7613de4ea5c36))
* cli, prompt and readme improvements ([4f7bb4c](https://github.com/deanjstone/argus/commit/4f7bb4ca2dbc6f4016afb6df768610474fd5d1a6))
* **cli:** exclude dotfiles from project and package pickers ([bac3aed](https://github.com/deanjstone/argus/commit/bac3aed6c37a17e7e566f119c52d833ae5a5fbbe))
* **config:** add claude-memory MCP server for Windows via wsl.exe ([5ff7001](https://github.com/deanjstone/argus/commit/5ff700123f49a305bdc503b4b2ca6971f124eb62))
* **config:** replace remaining ~/argus/ refs in windows config and scripts ([0d84f7c](https://github.com/deanjstone/argus/commit/0d84f7c37900ea20393c3c5f44375b0f35c58ff2))
* **config:** replace stale ~/argus/ refs with ~/projects/argus/ throughout ([7234329](https://github.com/deanjstone/argus/commit/7234329285f692f7cb62c6f6b0fc5499b8919f9c))
* **config:** use stable fnm alias path for node in claude-memory MCP server ([a018fd2](https://github.com/deanjstone/argus/commit/a018fd257a5dd4fdeb70abfd3167b47cce89b6d1))
* constrain init update writes to openwiki ([#230](https://github.com/deanjstone/argus/issues/230)) ([a7ae9b0](https://github.com/deanjstone/argus/commit/a7ae9b007bad97a8e462ec57a8d70d088f39ef75))
* correct ARGUS_DIR path and document watchtower project ([#51](https://github.com/deanjstone/argus/issues/51)) ([7faf680](https://github.com/deanjstone/argus/commit/7faf68004fb8f5706f8f8847e2df7d8a958c69d0))
* correct OpenRouter Claude Opus model ID ([#133](https://github.com/deanjstone/argus/issues/133)) ([a4df0c9](https://github.com/deanjstone/argus/commit/a4df0c9ecdd292ba249eb8af0f19f39027733c81)), closes [#86](https://github.com/deanjstone/argus/issues/86)
* correct sed order in project listing — strip trailing slash before dirname ([a015e12](https://github.com/deanjstone/argus/commit/a015e127923870b0fdea0eee7d14c4b2b9f2bdc3))
* **cortex-search:** use WSL2-local ~/CORTEX path instead of Windows mount ([2e290b6](https://github.com/deanjstone/argus/commit/2e290b64f5b6708af7dde2e05524829f2d1f13ed))
* dedupe herdr agent launches by reusing existing pane/workspace ([#140](https://github.com/deanjstone/argus/issues/140)) ([494c4ff](https://github.com/deanjstone/argus/commit/494c4ff8ff658219b10fc51fd50627a26d4ee28b))
* **deploy:** ship a runtime-only package.json to the remote server ([bf6a3ca](https://github.com/deanjstone/argus/commit/bf6a3ca1993266446b1c99f1e43f912c4a2301f8)), closes [13/#19](https://github.com/deanjstone/argus/issues/19)
* **dev-stack:** extend Windows backup paths ([f7d6372](https://github.com/deanjstone/argus/commit/f7d63723704ca29d619e11a5d21d1d3c37db2421))
* **dev-stack:** fix WezTerm asset regex hyphen vs dot (-setup.exe not .setup.exe) ([0c4f41f](https://github.com/deanjstone/argus/commit/0c4f41f528680b5d613fc916d508acd19686d892))
* **dev-stack:** fix WezTerm asset regex, add standalone install-wezterm.ps1 ([8019146](https://github.com/deanjstone/argus/commit/8019146c6f1324d50c5ef896fd95ac52405d6fa7))
* **dev-stack:** install WezTerm from GitHub releases, not winget ([d312017](https://github.com/deanjstone/argus/commit/d312017e6b32feb289d6c9cad2270720c3d2e21f))
* **dev-stack:** overhaul install-windows.ps1 ([f9f077f](https://github.com/deanjstone/argus/commit/f9f077f2bd29645edb49a821dba0e3d639da0096))
* **dev-stack:** remove non-existent ~/.bashrc.d from backup paths ([453b4d4](https://github.com/deanjstone/argus/commit/453b4d498e4bd84ac6373eb4f7ed94efc51d2535))
* **dev-stack:** update claude-memory MCP URL in Zed settings ([26db6b6](https://github.com/deanjstone/argus/commit/26db6b67f7ebc738e290b4d4eb016e31c98c36cd))
* **dev-stack:** use with_arguments for Zed terminal shell config ([95438db](https://github.com/deanjstone/argus/commit/95438db44a01cb0f55ae75e901f0d75d32945b85))
* **env:** remove stale uv env sourcing from zshrc and dev.sh ([639ba46](https://github.com/deanjstone/argus/commit/639ba462256302d7aed0e6557c02674971eb847e))
* escape carriage returns in env value formatting/parsing ([#248](https://github.com/deanjstone/argus/issues/248)) ([14f1281](https://github.com/deanjstone/argus/commit/14f1281c2aa8e92918b84635009d9dc0365e3d5c))
* fzf --layout=reverse for top prompt and A-Z order ([6166439](https://github.com/deanjstone/argus/commit/6166439c4b70e7375e91e00b932c325208a92673))
* gate scheduled OpenWiki Update workflow to the origin repository ([#303](https://github.com/deanjstone/argus/issues/303)) ([5fcb8f3](https://github.com/deanjstone/argus/commit/5fcb8f379d8f88b5fe5e65605dd61c18aab16b36)), closes [#302](https://github.com/deanjstone/argus/issues/302)
* gh action example ([587a141](https://github.com/deanjstone/argus/commit/587a14157ed962571080fe8ffc0312fe5fa880f5))
* handle trailing requests while the OAuth callback server is closing ([#311](https://github.com/deanjstone/argus/issues/311)) ([4187eb0](https://github.com/deanjstone/argus/commit/4187eb0177607814ca4347127c6cd9d6a3331720)), closes [#297](https://github.com/deanjstone/argus/issues/297)
* **herdr-agents:** map idle to running, not waiting ([b79b9fd](https://github.com/deanjstone/argus/commit/b79b9fd59d7cea8313704c337021c3fd5c2e9d30))
* honor per-instance connectorConfig in gmail, slack, x connectors ([#288](https://github.com/deanjstone/argus/issues/288)) ([ddd1f60](https://github.com/deanjstone/argus/commit/ddd1f609b23d83b96a800ea0f4d47e7d28a78c7d))
* **hooks:** add turns logging to subagent-log.sh; fix path to ~/CORTEX ([1ede3a7](https://github.com/deanjstone/argus/commit/1ede3a7efaefac9bf47c6af605d77206c5a15404))
* **hooks:** correct argus path from ~/argus to ~/projects/argus ([b986168](https://github.com/deanjstone/argus/commit/b986168da7fc8e9221435f81f95272bba367276d))
* **hooks:** correct find logic and first-run default in yesterdays-sessions ([c963f9e](https://github.com/deanjstone/argus/commit/c963f9ef0195c42ab61cc5f9ce0b7903292cc63e))
* **hooks:** correct SessionStart hook paths and add XDA Developers briefing source ([b7462ac](https://github.com/deanjstone/argus/commit/b7462ace8caa715a774c79115abc312bef7fea6e))
* **hooks:** fix session-stub.sh hardcoded Windows path; mark done: Agent Teams, ccbot, end-session hook, spawn-claude naming ([c789f86](https://github.com/deanjstone/argus/commit/c789f8660d259257397f21b84fc53a6e1a639ee1))
* **hooks:** handle dangling symlinks and exclude argus from install-hooks.sh ([ee90b3e](https://github.com/deanjstone/argus/commit/ee90b3ea68525a8c418c7bd7d23e95f333ab31f8))
* **hooks:** remove hyphen between date and title in sessions output filename ([2dc1b62](https://github.com/deanjstone/argus/commit/2dc1b621f3aa590c5adf7bc88210c7df3db39a75))
* **hooks:** update stale CORTEX vault path ([0cd4138](https://github.com/deanjstone/argus/commit/0cd41384d6af2e989da22055b8874c6c329a306e))
* html tokens have incomplete multi-character sanitization ([#148](https://github.com/deanjstone/argus/issues/148)) ([7d35537](https://github.com/deanjstone/argus/commit/7d355379423172049308ba166ec2eff02c1c2e7d))
* improve agent ([ceded10](https://github.com/deanjstone/argus/commit/ceded101c7128a340ce9a6f8a0b5d472cfd127bf))
* Improve code onboarding, save INSTRUCTIONS.md to openwiki/ ([#264](https://github.com/deanjstone/argus/issues/264)) ([20c4867](https://github.com/deanjstone/argus/commit/20c48678a8d493cd3b7b8a078ccfa8d2797cd8c7))
* Improve prompt and git context ([4e8737a](https://github.com/deanjstone/argus/commit/4e8737ad60392de2c8a4241130e4920d45792217))
* Improve prompting to not write slim files ([dfa73cc](https://github.com/deanjstone/argus/commit/dfa73cce9d55e674152015fc8f925e1088614d0f))
* improve streaming ([19c3e9e](https://github.com/deanjstone/argus/commit/19c3e9eeaae7689d3f2073f420fa7a36df96a1d1))
* keep scheduled OpenWiki updates opt-in on forks ([#370](https://github.com/deanjstone/argus/issues/370)) ([877280a](https://github.com/deanjstone/argus/commit/877280a57d5fbf383f6b0e2eddf797bb502a04ee))
* keep typeof check to reject unsupported source instance targets in cron commands ([#246](https://github.com/deanjstone/argus/issues/246)) ([fa414f0](https://github.com/deanjstone/argus/commit/fa414f02740550f7b35b9bd680cc76dc34af1d94))
* logo rendering in cli ([ca69e8a](https://github.com/deanjstone/argus/commit/ca69e8a10cf06d7b7ba4ff6b7d08f6ebab7e3e23))
* make blank LangSmith input disable tracing ([#54](https://github.com/deanjstone/argus/issues/54)) ([ebc4712](https://github.com/deanjstone/argus/commit/ebc471289e449a482ec0ed4af0dcf5f516416244))
* Make readme image read from github asset url ([d3cb143](https://github.com/deanjstone/argus/commit/d3cb143bd7081171fe870e46e5b15e1599a2a2ee))
* match project paths under ~/repos instead of ~/projects ([#31](https://github.com/deanjstone/argus/issues/31)) ([77b7998](https://github.com/deanjstone/argus/commit/77b79986862067c4f2b9e4e520d26f7eeadc5179)), closes [deanjstone/argus-config#135](https://github.com/deanjstone/argus-config/issues/135) [142/#143](https://github.com/deanjstone/argus/issues/143) [cmdpal-argus#37](https://github.com/cmdpal-argus/issues/37)
* **mcp-server:** deploy.sh fetches BWS secrets by ID, not name ([#7](https://github.com/deanjstone/argus/issues/7)) ([13c6f82](https://github.com/deanjstone/argus/commit/13c6f82475dd57815bc1636c3152dcf672183852))
* **mcp-server:** don't double the type prefix in CONTEXT mirror filenames ([#4](https://github.com/deanjstone/argus/issues/4)) ([fa483bc](https://github.com/deanjstone/argus/commit/fa483bc2492f98f7367af2833cc35b144d7bd8cf)), closes [#3](https://github.com/deanjstone/argus/issues/3)
* **mcp-server:** MEMORY.md index removal is link-granular, not line-granular ([#8](https://github.com/deanjstone/argus/issues/8)) ([c031a4f](https://github.com/deanjstone/argus/commit/c031a4f3a276fcbb040ce449c7b14c4ccc74a6f4))
* **mcp-server:** point deploy.sh releases at argus, port build-publish CI ([2591c75](https://github.com/deanjstone/argus/commit/2591c75a61739c0048641b921c5a2f41359acc50))
* **mcp-server:** verify CONTEXT mirror write/delete before reporting success ([#6](https://github.com/deanjstone/argus/issues/6)) ([e2ec8a2](https://github.com/deanjstone/argus/commit/e2ec8a22f2343cd0cee7821c673b052f8c7bef7f)), closes [#5](https://github.com/deanjstone/argus/issues/5)
* More cli styling improvements ([89a67b0](https://github.com/deanjstone/argus/commit/89a67b08f24f145c929006515e56c6c443786839))
* **my-rename:** no-recap, narrow trigger, tmux rename, add SRVR_ prefix; re-symlink ([ac0a970](https://github.com/deanjstone/argus/commit/ac0a9700aaa30df8a45b2e76cfdc5da05a1fab52))
* only trigger exit on /exit with slash prefix ([#247](https://github.com/deanjstone/argus/issues/247)) ([2f89c5f](https://github.com/deanjstone/argus/commit/2f89c5f56b54d0b5a5543aefed3a6429866ca9fe))
* persist .last-update.json when a run fails after generating content ([#277](https://github.com/deanjstone/argus/issues/277)) ([a8923fa](https://github.com/deanjstone/argus/commit/a8923fa107936f5dd655dad5ccdb21e33d8f5072)), closes [#72](https://github.com/deanjstone/argus/issues/72) [#131](https://github.com/deanjstone/argus/issues/131)
* pin pnpm version, unblocks CI and deploy ([#12](https://github.com/deanjstone/argus/issues/12)) ([640b9d5](https://github.com/deanjstone/argus/commit/640b9d538bbef311dde22db76da3a7c1bd110fd6))
* pin wrangler as a devDependency to unblock Deploy ([#14](https://github.com/deanjstone/argus/issues/14)) ([b9d4078](https://github.com/deanjstone/argus/commit/b9d4078251f535ee7d758b6136b2bf05ab1d320c))
* preserve `OPENAI_BASE_URL` when loading and saving environment ([#90](https://github.com/deanjstone/argus/issues/90)) ([7c084f9](https://github.com/deanjstone/argus/commit/7c084f9f6f8032243fd3dfd544969c279416b5cb))
* Prompt agent to write more concise docs ([f396412](https://github.com/deanjstone/argus/commit/f396412230b504392d8255b5deeb069584874837))
* Readme improvements ([#19](https://github.com/deanjstone/argus/issues/19)) ([14ca04a](https://github.com/deanjstone/argus/commit/14ca04a8b9ddba347ff267eb514d2864e6f55ee8))
* recognize positional mode after flags instead of treating it as the message ([#279](https://github.com/deanjstone/argus/issues/279)) ([0c0639e](https://github.com/deanjstone/argus/commit/0c0639eece971acc75ccc36dad8d6b99a9b906f5)), closes [#313](https://github.com/deanjstone/argus/issues/313) [#313](https://github.com/deanjstone/argus/issues/313)
* **release:** declare semantic-release deps in mcp-server and wiki ([#194](https://github.com/deanjstone/argus/issues/194)) ([7c9b701](https://github.com/deanjstone/argus/commit/7c9b701709cc91d47a7251e6cfcbf9487f1466d0))
* **release:** restore checkout credentials so the final git pull works ([#181](https://github.com/deanjstone/argus/issues/181)) ([7350d34](https://github.com/deanjstone/argus/commit/7350d345326fcb2b4f11880093f5463105480909))
* remove dependency-review workflow (hard-fails without GHAS) ([#24](https://github.com/deanjstone/argus/issues/24)) ([e656423](https://github.com/deanjstone/argus/commit/e65642370aa4b1f6fce01dd3084f9ef09878410d))
* remove leftover scoped-exception bullet from SYSTEM.md ([676739a](https://github.com/deanjstone/argus/commit/676739ad3f999a082232b4ca4cd8389955ff86e0))
* remove trailing comma in agent-engine package.json ([f9f87f6](https://github.com/deanjstone/argus/commit/f9f87f66234f7725f1ef90ea19a45efc480dfe95))
* repoint sync-files-to-supabase MEMORY_DIR at CONTEXT vault ([#67](https://github.com/deanjstone/argus/issues/67)) ([211349b](https://github.com/deanjstone/argus/commit/211349bee3cad06d723a0ab1fd0c0e6831297ada))
* run --init/--update non-interactively when stdin is not a TTY ([#153](https://github.com/deanjstone/argus/issues/153)) ([bd3d214](https://github.com/deanjstone/argus/commit/bd3d214b643af4b73968890fbbd0fa88f099b757)), closes [#149](https://github.com/deanjstone/argus/issues/149)
* Run in code mode if no brain mode specified ([#313](https://github.com/deanjstone/argus/issues/313)) ([7c687ab](https://github.com/deanjstone/argus/commit/7c687ab9ef3581a4c3da7211224005e13cb2489f))
* **server:** move @code-relay/types to devDependencies ([5e57be7](https://github.com/deanjstone/argus/commit/5e57be75a81bcafcc8839b5459d5f9af66a4d2ac)), closes [#13](https://github.com/deanjstone/argus/issues/13)
* **skills:** add title field to cortex-search SKILL.md ([6225e43](https://github.com/deanjstone/argus/commit/6225e4393019925378c7e7cb15cba8bb3fd83171))
* **skills:** update launch-claude for Windows Terminal + tmux stack (ADR-006) ([9ed57a1](https://github.com/deanjstone/argus/commit/9ed57a120fd487f4ee19ccf6311d589586db606c))
* skip clean update prints before credentials ([#211](https://github.com/deanjstone/argus/issues/211)) ([339de4a](https://github.com/deanjstone/argus/commit/339de4abbe2783b31c7990305e102db744f0a999))
* stop env-behavior tests from overwriting the real ~/.openwiki/.env ([#334](https://github.com/deanjstone/argus/issues/334)) ([a67464e](https://github.com/deanjstone/argus/commit/a67464e4d941138ed17d6542632d1ff459d52acb))
* strip internal newlines from bw unlock --raw output in bw-unlock ([4e4f161](https://github.com/deanjstone/argus/commit/4e4f16172f3edfa0167958b7deb5c73072f4fca3))
* sync pnpm-lock.yaml with [#19](https://github.com/deanjstone/argus/issues/19)'s devDependencies move ([ed0149f](https://github.com/deanjstone/argus/commit/ed0149f90581fcfab49474fb713033f27b5fa922))
* tolerate optional OKF index metadata ([#376](https://github.com/deanjstone/argus/issues/376)) ([b1f24bc](https://github.com/deanjstone/argus/commit/b1f24bc6250559fa43f18ea764d11cb9cf9cbf7a))
* update ~/projects references to ~/repos ([#26](https://github.com/deanjstone/argus/issues/26)) ([568c576](https://github.com/deanjstone/argus/commit/568c576a03a1ce6a6a3d710473b14d432a3ee17a))
* update ~/projects references to ~/repos in mcp-server package ([#10](https://github.com/deanjstone/argus/issues/10)) ([817a991](https://github.com/deanjstone/argus/commit/817a991084f6a990b55c96ed1f28befaa83275ad)), closes [deanjstone/mcp-memory#73](https://github.com/deanjstone/mcp-memory/issues/73)
* update bin/argus with CLI fixes, remove bin/argus-launch ([7d86105](https://github.com/deanjstone/argus/commit/7d8610582e46d945f97234c154e718a2119616d8))
* update bw helpers and direnv for BW CLI 2026.5.0 keyring issue ([20fea15](https://github.com/deanjstone/argus/commit/20fea15c51267d53b81c42c03b015c9506b35702))
* update hook path to argus-config after monorepo split ([11d0c24](https://github.com/deanjstone/argus/commit/11d0c24cc3e9bd2e0fd4d770c7454b6852f6d199))
* Update readme description ([#242](https://github.com/deanjstone/argus/issues/242)) ([681b25a](https://github.com/deanjstone/argus/commit/681b25a9993a3ef516185c68bef03a07c71df098))
* **update:** skip agent run when no repository changes are detected ([#57](https://github.com/deanjstone/argus/issues/57)) ([b1b3564](https://github.com/deanjstone/argus/commit/b1b3564a7c89082a50495174bc185e243a47f4a2))
* use best practices for skills in DA ([#343](https://github.com/deanjstone/argus/issues/343)) ([8a0bc6b](https://github.com/deanjstone/argus/commit/8a0bc6bc360bc44ec19583543f56fe35f43516b7))
* use bw get item for ccbot deploy session validation ([eab7550](https://github.com/deanjstone/argus/commit/eab7550f5a750a419c926001003d8af93b9c2343))
* use dash-delimited Anthropic model id for Opus (claude-opus-4-8) ([#113](https://github.com/deanjstone/argus/issues/113)) ([23428de](https://github.com/deanjstone/argus/commit/23428de0cc0b1b6d3e5d09be413e92a5d6ee451f))
* use fzf auto-height to eliminate blank space below project list ([50c7863](https://github.com/deanjstone/argus/commit/50c7863d160b1128ce8515f301e20fbccae2085f))
* Use v3 stream events for agent output ([38723ce](https://github.com/deanjstone/argus/commit/38723ce1db47490576585d13ab2bbb37590ce568))
* validate configured provider before setup completes ([#197](https://github.com/deanjstone/argus/issues/197)) ([ca74b84](https://github.com/deanjstone/argus/commit/ca74b844262ead055125e2ddda20eb14520d2cb9))
* **watchtower-collector:** restore PATH env in systemd unit ([#177](https://github.com/deanjstone/argus/issues/177)) ([fd9342e](https://github.com/deanjstone/argus/commit/fd9342e3338518affd4b977dd755198527360203)), closes [hi#level](https://github.com/hi/issues/level)
* **watchtower:** scope wrangler-action to apps/watchtower's own install ([#184](https://github.com/deanjstone/argus/issues/184)) ([1c35604](https://github.com/deanjstone/argus/commit/1c35604ea9fbfda077091db20f64f63ae01e1865)), closes [#183](https://github.com/deanjstone/argus/issues/183)
* **windows:** resolve Git-cloned symlinks when installing skills ([c5fa80d](https://github.com/deanjstone/argus/commit/c5fa80d3a187a688cd6c02e54fc13da189fee080))


### Features

* add --tmux flag to open sessions in tmux window instead of WT tab ([c518f70](https://github.com/deanjstone/argus/commit/c518f7003cd4e1fab877d03771719fc3fe91977e))
* add -h / --help flag to argus CLI ([11ebf9a](https://github.com/deanjstone/argus/commit/11ebf9a5f0588217ef13590b8ba7792283be12c1))
* add 5 new skills and update 5 existing from session audit ([e753b38](https://github.com/deanjstone/argus/commit/e753b38d6495cd3fad8a8305f2414bd2174eb6cc))
* add an OpenAI-compatible provider with a required base URL ([#110](https://github.com/deanjstone/argus/issues/110)) ([d75a9f3](https://github.com/deanjstone/argus/commit/d75a9f38f500d0bfc0c0f51d805785e510560b50))
* add argus CLI tool to open Claude sessions in new WT tabs ([88b0d8f](https://github.com/deanjstone/argus/commit/88b0d8f650d958de5c46c18ed13cdf146d088f5e))
* add aws bedrock to the model provider list ([#327](https://github.com/deanjstone/argus/issues/327)) ([d43bd4f](https://github.com/deanjstone/argus/commit/d43bd4fa1432695f4f3bbd9eee3b67f46715d136))
* add Bitbucket Pipelines example for openwiki --update ([#261](https://github.com/deanjstone/argus/issues/261)) ([8014247](https://github.com/deanjstone/argus/commit/8014247f0138d55caf5f2edc1809cae81771178c)), closes [#260](https://github.com/deanjstone/argus/issues/260)
* add direnv .envrc for ccbot dev environment ([2fa77d4](https://github.com/deanjstone/argus/commit/2fa77d4441c40e21c23f3fa8a79ab41666964146))
* add gemini (ai studio) and gemini enterprise (vertex ai) providers with vertex model-family routing ([#154](https://github.com/deanjstone/argus/issues/154)) ([e1a2fea](https://github.com/deanjstone/argus/commit/e1a2fea77048f342c6317c457b3dca6efe5ec209))
* add google vertex ai (claude) provider ([#179](https://github.com/deanjstone/argus/issues/179)) ([15f1af5](https://github.com/deanjstone/argus/commit/15f1af5c804cb15bfd67f09d6a8920d063c63111))
* add GPT-5.6 OpenAI model options ([#252](https://github.com/deanjstone/argus/issues/252)) ([3f0ed25](https://github.com/deanjstone/argus/commit/3f0ed25427aacd67f8ed8b25673002b63e8cc594))
* add herdr-backed AgentViewMonitor backend behind AGENT_VIEW_BACKEND flag ([32e85a5](https://github.com/deanjstone/argus/commit/32e85a5d1d182ac1c17c87707fd06319cf58225b)), closes [#135](https://github.com/deanjstone/argus/issues/135)
* add list-memories-first-prompt hook script ([#29](https://github.com/deanjstone/argus/issues/29)) ([0d79bdf](https://github.com/deanjstone/argus/commit/0d79bdf953db961cc9073fe89f35d1cdd73c2d71))
* add nebius token factory provider support ([#147](https://github.com/deanjstone/argus/issues/147)) ([bdbd966](https://github.com/deanjstone/argus/commit/bdbd96690d5373eb66fab07efd6bb7af8f96153d))
* add nvidia nim as a model provider for inference ([#42](https://github.com/deanjstone/argus/issues/42)) ([326a307](https://github.com/deanjstone/argus/commit/326a307203345128a60b92a356978c46e2992df3))
* add OpenAI ChatGPT-login provider (Codex OAuth) ([#151](https://github.com/deanjstone/argus/issues/151)) ([bf8f84a](https://github.com/deanjstone/argus/commit/bf8f84aafaad892aaffd5509408470702edee909))
* add per-package + monorepo semantic-release versioning ([#125](https://github.com/deanjstone/argus/issues/125)) ([9e8816c](https://github.com/deanjstone/argus/commit/9e8816cdb669bbc863b26eec63849975814d180e))
* add semantic-release for automated versioning ([#12](https://github.com/deanjstone/argus/issues/12)) ([8a3b5db](https://github.com/deanjstone/argus/commit/8a3b5db8b6dcc08bf9f07e1858bacb2d6703d225))
* add semantic-release for automated versioning ([#24](https://github.com/deanjstone/argus/issues/24)) ([4764385](https://github.com/deanjstone/argus/commit/4764385faec2f2a51c6d6eb884c1ea1a2412e00c))
* add semantic-release for automated versioning ([#25](https://github.com/deanjstone/argus/issues/25)) ([c3f8428](https://github.com/deanjstone/argus/commit/c3f84289ae9b4afbb822c353eb0b3e510e9e9a74))
* add session-summary hook and wire daily-briefing to SessionStart ([dce7f9a](https://github.com/deanjstone/argus/commit/dce7f9a733956737ddd9ece9e72c73a3d3a90906))
* Add trending repo badge to readme ([#347](https://github.com/deanjstone/argus/issues/347)) ([27ee8c8](https://github.com/deanjstone/argus/commit/27ee8c8a8a07fdc3091c23f2e29fd0416b8a9592))
* **agent-cli:** add ~/CORTEX as ~cortex special entry in -p picker ([eb885e5](https://github.com/deanjstone/argus/commit/eb885e548871b2e6b3a05a9fc4671de973121371))
* **agent-cli:** add doctor and query commands ([db4d290](https://github.com/deanjstone/argus/commit/db4d290d839ef879d9443f3e53511503bcacc2a6))
* **agent-cli:** always create named tmux session on launch ([8a12a59](https://github.com/deanjstone/argus/commit/8a12a59fb4af1418936f4e340c975c953b6cdb4b))
* **agent-cli:** pass session label to claude via --name ([#94](https://github.com/deanjstone/argus/issues/94)) ([7e20e5f](https://github.com/deanjstone/argus/commit/7e20e5f32bbbda4d58153908b14a20190caf600d))
* **agent-engine:** add ArgusContext, VectorEngine, path traversal guards ([2d51708](https://github.com/deanjstone/argus/commit/2d517087ccb5422111172d31360f6fcab6fb42da))
* **agent-engine:** add Dockerfile for Docker deployment on dell-server ([09cdd80](https://github.com/deanjstone/argus/commit/09cdd8081c54586fc89594b55655df6b8bcd0136))
* **agent-engine:** add index.ts barrel export for public API ([705e973](https://github.com/deanjstone/argus/commit/705e9739da09dd87178cc36feab43b00c9f4d794))
* **agent-engine:** add server deploy target to deploy.sh ([c728d8d](https://github.com/deanjstone/argus/commit/c728d8d0c422e3a7849046d41a2e33bdd2e56af4))
* **agent-engine:** integrate CLI with engine; switch HaikuAdapter to claude CLI ([70abc5c](https://github.com/deanjstone/argus/commit/70abc5c5d47e7d4d717524107a2063dc93ad0be3))
* **agent-engine:** scaffold packages/agent-engine with full Wave 0–6 implementation ([100d437](https://github.com/deanjstone/argus/commit/100d4375fd4eda8e91669a8c4f51f13e72659193))
* **agent:** add context read/write commands for agent-engine vault access ([f40cefd](https://github.com/deanjstone/argus/commit/f40cefdef05ea76c9bd16c49f27426cb85a99d80))
* **agent:** fuzzy sub-path resolution — agent -p argus/agent works without 'packages/' ([70cadbc](https://github.com/deanjstone/argus/commit/70cadbc6a661a1326e7a5da8b7120b8bfa3f8463))
* **agent:** support direct sub-module launch via agent -p <name>/<path> ([1ee0d1b](https://github.com/deanjstone/argus/commit/1ee0d1b7a664a2b39ea9d1f838a5712e09a9a6d5))
* Auto-exit on complete when running init or update ([fd3a702](https://github.com/deanjstone/argus/commit/fd3a702fd0f3ef8e701df36670ef9464c52cb327))
* **brrr:** add integration plan, TODO items, and reference doc ([f531eb4](https://github.com/deanjstone/argus/commit/f531eb414021b5c3088dc0f258a8e148dd99a893))
* **ccbot:** 8 mobile UX gap items — voice, spinners, history, skills, file transfer ([#12](https://github.com/deanjstone/argus/issues/12)) ([f95fe1a](https://github.com/deanjstone/argus/commit/f95fe1a3aed42312e6993622852a91811b728623))
* **ccbot:** add full Telegram→Slack feature parity ([ca9b2c4](https://github.com/deanjstone/argus/commit/ca9b2c43a8f36683fffd023b7d5d2bfdc18aff38))
* **ccbot:** add MACHINE_PREFIX env var for multi-machine workspace disambiguation ([4ae176e](https://github.com/deanjstone/argus/commit/4ae176ea32f70e5a78942a487e5da80d0c6e75bb))
* **ccbot:** add Matrix channel support ([2468fad](https://github.com/deanjstone/argus/commit/2468fad2210d3cf771aaf3869f8582d222bc9d1c))
* **ccbot:** add per-project Telegram Topics routing ([574667a](https://github.com/deanjstone/argus/commit/574667a930660e31fcd8325760554351683026a3))
* **ccbot:** add pre-tool-notify for intermediate Telegram updates ([36e58c8](https://github.com/deanjstone/argus/commit/36e58c8b6cba67f7687a0befb37bdd4447188521))
* **ccbot:** add TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_PORT to env config ([18ed543](https://github.com/deanjstone/argus/commit/18ed5433b6859f6f1360f2650529eefa2c7db91a))
* **ccbot:** migrate source to TypeScript monorepo ([3712363](https://github.com/deanjstone/argus/commit/3712363e9a0263768dc6cd9e3acfc4e3aad6dd70))
* **ccbot:** multi-group Telegram routing ([da98279](https://github.com/deanjstone/argus/commit/da98279a7bf2d60c529cec2a5d1cc309038e2b2d))
* **ccbot:** Slack bidirectional relay — route responses back to source channel ([54c21de](https://github.com/deanjstone/argus/commit/54c21dea367a503f70301eae0bac20f7c9738d00))
* **ccbot:** spawn background claude session for memory consolidation apply ([b8603ba](https://github.com/deanjstone/argus/commit/b8603bad31383d631da062314ee79bf09a096c3b))
* **ccbot:** Telegram free-form injection, /agents and /compact commands ([847d445](https://github.com/deanjstone/argus/commit/847d445183aaff50a67d4aba4ffcd15cd70dd94f))
* **cli:** add @argus/cli TypeScript package replacing bash launcher ([23f804c](https://github.com/deanjstone/argus/commit/23f804c22e2d5bf4cacb243142aebb7eb3a9a6a0))
* **cli:** add deploy.sh ([67e8053](https://github.com/deanjstone/argus/commit/67e80531257955c5b2f57f2a947995b4fef7f28c))
* **cli:** add root option to monorepo package picker ([a7a99b3](https://github.com/deanjstone/argus/commit/a7a99b3c2b5d9a0ba6a66d6f7774da6112dccc62))
* **cli:** show package picker for monorepo projects ([f400485](https://github.com/deanjstone/argus/commit/f40048598d9e7daa3b9f982d78b97207aafc1884))
* collector core, systemd/disk/uptime adapters ([#3](https://github.com/deanjstone/argus/issues/3)) ([29a010b](https://github.com/deanjstone/argus/commit/29a010b3a55a4bf76e19d99122194c3f5a9f9bdb))
* **config:** add deploy-windows.ps1 for syncing repo changes to live Windows config ([d4a93c0](https://github.com/deanjstone/argus/commit/d4a93c04bdc8b853d0b24e7739f71d1b78fc1029))
* **config:** add path-scoped rules, trim global CLAUDE.md ~210 tokens ([675a048](https://github.com/deanjstone/argus/commit/675a0482fbf601859b224a95262094d8a4b066f9))
* **config:** add Syncthing setup documentation and fix Windows package ID ([b1f94af](https://github.com/deanjstone/argus/commit/b1f94af893dd602da9f4d90dea4762315abdc8c4))
* **config:** add systemd user services for argus session and ccbot ([2c0be79](https://github.com/deanjstone/argus/commit/2c0be79f5d74aca8f29b74de431f954cc0957860))
* **config:** sync argus skills to Windows ([53b950f](https://github.com/deanjstone/argus/commit/53b950fc61484cda1e86f83c7cc80bacc309819c))
* **context:** add OKF frontmatter to context bundle and memory files ([827f53d](https://github.com/deanjstone/argus/commit/827f53dbfdbf01ae59cf51288b6d22ea17d82e66))
* control-plane job tracking (ControlPlaneJob, signal, review, routing score) ([#128](https://github.com/deanjstone/argus/issues/128)) ([1b621cf](https://github.com/deanjstone/argus/commit/1b621cfe53f8c67c823a4e549728ec081223fdf1))
* daily memory consolidation on Argus session start ([70bd6b3](https://github.com/deanjstone/argus/commit/70bd6b3260403f79bd57438a06617f29fe04f91d))
* **dashboard:** move WSL2 system dashboard into argus repo ([2438faf](https://github.com/deanjstone/argus/commit/2438faf9d8f66f3a7145872634236d1cf835c6be))
* **deploy:** support AGENT_VIEW_BACKEND/AGENT_VIEW_HERDR_SHADOW ([d42f54f](https://github.com/deanjstone/argus/commit/d42f54f3a747593e7846bd7d7833cec54f5ddeb9))
* **dev-stack:** add Dimidium color schemes for WT, Zed, and Orca ([#26](https://github.com/deanjstone/argus/issues/26)) ([44b4075](https://github.com/deanjstone/argus/commit/44b4075bbb8807c675a159590878a2cba84ffbac))
* **dev-stack:** add Dimidium Light theme for Zed ([e44cce2](https://github.com/deanjstone/argus/commit/e44cce28e4b3e8e97bff05c7f59808e2641d595a)), closes [#F5F3F1](https://github.com/deanjstone/argus/issues/F5F3F1)
* **dev-stack:** add Dimidium theme for Zed and switch dark theme ([3d7801a](https://github.com/deanjstone/argus/commit/3d7801acbbf5fc6e09c9d846fe505376668c52b3)), closes [#141414](https://github.com/deanjstone/argus/issues/141414)
* **dev-stack:** add personal apps to Windows install script ([7c2cff2](https://github.com/deanjstone/argus/commit/7c2cff2303990d1c26e50e113454b74c6a2a700f))
* **dev-stack:** add restic backup system targeting homelab ([9f698c4](https://github.com/deanjstone/argus/commit/9f698c4a9c6c32bf2bd9766472ac2a7abc7b5a75))
* **dev-stack:** add WezTerm config and wire into Windows bootstrap ([54d1b84](https://github.com/deanjstone/argus/commit/54d1b84690725effaa54ef8cae6ef42b6560cf00))
* **dev-stack:** add Zed install and settings copy to install-windows.ps1 ([ad9adc2](https://github.com/deanjstone/argus/commit/ad9adc2af11e8cde8b7fbf22a716cf5c434e0002))
* **dev-stack:** add Zed settings with VS Code migration ([201f68c](https://github.com/deanjstone/argus/commit/201f68c1829a84a75586c75705befa0cbe7701b0))
* **dev-stack:** add Zed theme install step to install-windows.ps1 ([a4816f4](https://github.com/deanjstone/argus/commit/a4816f48e7ff30d1d72760b54f23b3b4c7412f9d))
* **dev-stack:** extend Windows install + backup coverage ([f8d0f38](https://github.com/deanjstone/argus/commit/f8d0f383ee75aedbfe75c2e0cdd3cd03ed3a9668))
* **dev-stack:** install WezTerm from nightly instead of stable ([1f4eb30](https://github.com/deanjstone/argus/commit/1f4eb3080ae761326611408d83872eda5fd396a8))
* **dev-stack:** install Zellij, replace tmux in WSL2 bootstrap (ADR-002) ([d65e787](https://github.com/deanjstone/argus/commit/d65e787e0db74f84a87bf673cbb2d0f23d440808))
* dual-write memory_remember/memory_forget to CONTEXT disk mirror ([#51](https://github.com/deanjstone/argus/issues/51)) ([d72adac](https://github.com/deanjstone/argus/commit/d72adacda559b127c3ebf24a91212415943a35b2))
* **env:** enable headroom output shaper for model output token compression ([4db1ce7](https://github.com/deanjstone/argus/commit/4db1ce7b30848bba3cd64c38fc0ee36c15d214c1))
* **hooks:** add claudestat hooks for real-time cost and quota monitoring ([4cf6b43](https://github.com/deanjstone/argus/commit/4cf6b439f2596323351866deea97edb82e90b57b))
* **hooks:** implement tmux status bar state hooks via [@claude-state](https://github.com/claude-state) window variable ([299e255](https://github.com/deanjstone/argus/commit/299e255f6bed880e0959e0d8e4f0aad43c9363c0))
* **hooks:** replace session-summary with yesterdays-sessions ([83f7c06](https://github.com/deanjstone/argus/commit/83f7c069834a09e7f34209fc727739d00e76ef18))
* implement tool schema recovery middleware to handle malformed file tool calls without aborting the run ([#122](https://github.com/deanjstone/argus/issues/122)) ([f050609](https://github.com/deanjstone/argus/commit/f050609adfb43d736de035a33426ae2f530aaf50))
* **infra:** add dell-server config env and install script ([ee8322f](https://github.com/deanjstone/argus/commit/ee8322f41693477f9265f888b808d253a66c21d1))
* **infra:** add systemd timer for daily briefing ([1bc9da6](https://github.com/deanjstone/argus/commit/1bc9da61fbe8e756169e865535e9e8733872a9b9))
* Make OpenWiki general purpose ([#48](https://github.com/deanjstone/argus/issues/48)) ([cb2f203](https://github.com/deanjstone/argus/commit/cb2f20399c2786948b42dd514820a99abca09e22)), closes [#109](https://github.com/deanjstone/argus/issues/109)
* **mcp-memory:** add stdio deploy.sh and mcp-memory-launch.sh hook; audit and verify remaining TODOs ([ef23ec5](https://github.com/deanjstone/argus/commit/ef23ec52eda51b1f2eb3ef9674e13d4eb90a5db3))
* **mcp-memory:** expose knowledge graph as MCP resource ([c8dffd8](https://github.com/deanjstone/argus/commit/c8dffd88c2292ce7e0d9b73b57991fa171fbaf69))
* **mcp-memory:** migrate HTTP transport from Express/Vercel to Hono/CF Workers ([c6529cf](https://github.com/deanjstone/argus/commit/c6529cf52cbf8159ee08ee3d29b5cd3dcc4c80b0))
* **mcp-memory:** switch embedding to local Ollama (nomic-embed-text) ([4f57529](https://github.com/deanjstone/argus/commit/4f575299bf11d332358c8b139a832162124b8a0e))
* **mcp-server:** restore Cloudflare Worker auto-deploy from argus ([#185](https://github.com/deanjstone/argus/issues/185)) ([ee61235](https://github.com/deanjstone/argus/commit/ee612359210f74298b641bef72760bff58240b09)), closes [#176](https://github.com/deanjstone/argus/issues/176)
* **memory:** replace inline consolidation with daily bg session; add /memory Telegram command ([f6b679b](https://github.com/deanjstone/argus/commit/f6b679bf08c55680087f5de6b9f93fd4099aada6))
* OKF + telemetry ([#345](https://github.com/deanjstone/argus/issues/345)) ([d4e94ab](https://github.com/deanjstone/argus/commit/d4e94ab513ab13908c6b61346b23dc17bbd59b1f)), closes [#321](https://github.com/deanjstone/argus/issues/321) [#323](https://github.com/deanjstone/argus/issues/323) [#324](https://github.com/deanjstone/argus/issues/324) [#339](https://github.com/deanjstone/argus/issues/339) [#351](https://github.com/deanjstone/argus/issues/351) [#353](https://github.com/deanjstone/argus/issues/353) [#354](https://github.com/deanjstone/argus/issues/354) [#325](https://github.com/deanjstone/argus/issues/325) [#357](https://github.com/deanjstone/argus/issues/357) [#347](https://github.com/deanjstone/argus/issues/347) [#348](https://github.com/deanjstone/argus/issues/348)
* phase 1 governance — ADRs, registry.json, post-commit hook ([78346a3](https://github.com/deanjstone/argus/commit/78346a3b410c0e94a1293ee92dbbed42e42895eb))
* phase 2 — myargus Supabase project created and documented ([44b0ece](https://github.com/deanjstone/argus/commit/44b0ecea95893f298a74ad728182a33fb5b2882b))
* phase 3 — myargus monorepo scaffold and GitHub repo ([3502a0a](https://github.com/deanjstone/argus/commit/3502a0a2a6e01eedbaac8f95defa99f712d22a47))
* phase 6 — ccbot copied into argus/packages/ccbot ([aedef04](https://github.com/deanjstone/argus/commit/aedef048a37964e55893c816ecc22d595ae34cb1))
* phase 6 — claude-config copied into argus/config ([a895cb1](https://github.com/deanjstone/argus/commit/a895cb1f996d65488943dcaf5f1a512e33d94136))
* phase 6 — dev-stack copied into argus/packages/dev-stack ([3ba03ca](https://github.com/deanjstone/argus/commit/3ba03ca71b618fe6f153e75c0e8fa83d229cabcb))
* phase 6 — mcp-memory copied into argus/packages/mcp-memory ([2026ee5](https://github.com/deanjstone/argus/commit/2026ee570804c33f733d70d5afaeaae411df56b9))
* replace cloud briefing routine with local SessionStart hook ([7c59fae](https://github.com/deanjstone/argus/commit/7c59fae15135af620952bc923db891e1e4cd63ca))
* **runtime:** establish ~/.argus/ as the unified runtime dir for all packages ([0125d98](https://github.com/deanjstone/argus/commit/0125d9821d41b546688030e1247ec776572a6abf))
* set up local LLM (Ollama + gemma3:4b) for preprocessing and sensitive data ([83a58b3](https://github.com/deanjstone/argus/commit/83a58b393bd54fc7c0805f0081e7d4d292ae5604))
* **settings:** enable Agent Teams experimental feature ([555e8fd](https://github.com/deanjstone/argus/commit/555e8fd9352e89a3c192f7ddbe9edc3d51998596))
* **skills:** add adr skill; reduce write-adr to alias ([7ded5ae](https://github.com/deanjstone/argus/commit/7ded5aef1dec3c0395114ace0ea6e41aba26ed50))
* **skills:** add cortex-file skill for vault-conforming note creation ([80b1bc3](https://github.com/deanjstone/argus/commit/80b1bc3bedc42ffdec07f41a5a7110bc703fcdbf))
* **skills:** add impl-plan skill and data-driven implementation plan template ([af42930](https://github.com/deanjstone/argus/commit/af42930bf57e61d7c293e9f664cca1e84f483462))
* **skills:** add rename skill to enforce PREFIX_label naming convention ([8f748d7](https://github.com/deanjstone/argus/commit/8f748d7efb333f455ade181acbd20bb87d9ffa4b))
* **skills:** add tmux-sessions skill for listing and switching sessions ([54903de](https://github.com/deanjstone/argus/commit/54903de9bb87ad080ed17434f7857ab1e14f253a))
* **skills:** add todo skill for appending items to docs/TODO.md ([d5a04ed](https://github.com/deanjstone/argus/commit/d5a04edff941d8820b03dede11d11310094f59d6))
* **skills:** add todo-migrate, provision-server, github-setup, syncthing-pair, ccbot-machine ([3e2251b](https://github.com/deanjstone/argus/commit/3e2251bc53d7354c61ea57858d585964dd1dedf9))
* **skills:** add write-adr and deploy skills ([365ead4](https://github.com/deanjstone/argus/commit/365ead4c7661b42a7196e1452045e8140f8b99f4))
* **skills:** migrate launch-claude and my-rename from tmux to Zellij ([f8eb109](https://github.com/deanjstone/argus/commit/f8eb109c7691cbfe00db041583083bb195fe31fc))
* **statusline:** add Claude Code status bar for WSL2 and Windows ([f27cafc](https://github.com/deanjstone/argus/commit/f27cafc6b4ac09506ecd04d38735fb4f2e07d1e3))
* Support multiple model providers ([f89b05d](https://github.com/deanjstone/argus/commit/f89b05d23f77ddaf915f239a5c847d9ff39339ea))
* **syncthing:** enforce Tailscale-only sync on all nodes ([d6b9046](https://github.com/deanjstone/argus/commit/d6b9046e7e9778898c1699f1a555278a7305a444))
* **syncthing:** migrate CORTEX from Obsidian/ to ~/CORTEX on all nodes ([9c84cb5](https://github.com/deanjstone/argus/commit/9c84cb5faa8e28152cfc32a62a6b51f8b678385b))
* **syncthing:** replace Windows device ID after fresh SyncTrayzor install ([868bb3a](https://github.com/deanjstone/argus/commit/868bb3ac020eda228f16bdcc62dfe2dce6e8af51))
* Tailscale identity gate + herdr-backed RelayEvent stream ([cfc819a](https://github.com/deanjstone/argus/commit/cfc819a39497273ef88aaf89c62214827e4cb335)), closes [#132](https://github.com/deanjstone/argus/issues/132)
* **todo-skill:** infer target repo and create GH issue on TODO add ([a50c506](https://github.com/deanjstone/argus/commit/a50c5068b41a3f77296d460ecbe016aac116b6e4))
* **tools:** install codebase-memory-mcp v0.8.1 code intelligence MCP ([49a634b](https://github.com/deanjstone/argus/commit/49a634b5fd40dc386ad5a3bb1045c5dc006bacd2))
* track deferred documentation areas ([#286](https://github.com/deanjstone/argus/issues/286)) ([2fb44a8](https://github.com/deanjstone/argus/commit/2fb44a876db8cca461ad1c0767931d95495763a3))
* Update agents.md/claude.md to reference openwiki ([a82759f](https://github.com/deanjstone/argus/commit/a82759f16bf88aeaeb30e0b8c20ac7dc31da8e93))
* Update openwiki (local run) ([4633b02](https://github.com/deanjstone/argus/commit/4633b025fa75dc9b6fee6d81fe9d85cfa7b93ec5))
* use openai responses api ([#202](https://github.com/deanjstone/argus/issues/202)) ([39493ef](https://github.com/deanjstone/argus/commit/39493ef8e11a2757870eaabcff904c768d0984e5))
* **watchtower:** restore Cloudflare Pages auto-deploy from argus ([#183](https://github.com/deanjstone/argus/issues/183)) ([614ebb8](https://github.com/deanjstone/argus/commit/614ebb8494e66a86cd5803a3804f3a5c741f17b9))
* **wiki:** port OpenWiki auto-update cron and add audit + smoke test ([#186](https://github.com/deanjstone/argus/issues/186)) ([cec22be](https://github.com/deanjstone/argus/commit/cec22be3cda3d5880f373dfe747609b2a3d18178)), closes [map-#163](https://github.com/map-/issues/163) [#179](https://github.com/deanjstone/argus/issues/179)
* **wsl2:** add PowerShell (pwsh + powershell.exe) to PATH ([0ae68f1](https://github.com/deanjstone/argus/commit/0ae68f1f3abe6ee81f29246e6f9f39d8c09e3536))
* **zsh:** jazz up shell — eza, zoxide, delta, history-substring-search, fzf-tab preview ([cdc16d6](https://github.com/deanjstone/argus/commit/cdc16d6878209d0352dfe51eb64c7a6113346c02))
