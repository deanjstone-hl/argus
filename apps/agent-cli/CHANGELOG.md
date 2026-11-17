# [@argus/agent-cli-v2.0.1](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v2.0.0...@argus/agent-cli-v2.0.1) (2026-11-03)


### Bug Fixes

* drop stale argus CLI references after the rename to agent ([#1044](https://github.com/deanjstone/argus/issues/1044)) ([1793a81](https://github.com/deanjstone/argus/commit/1793a8197deda65ec9301493a04958d3f1b99a19))

# [@argus/agent-cli-v2.0.0](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.7...@argus/agent-cli-v2.0.0) (2026-10-09)


* feat(agent-cli)!: retire herdr-based open and listen commands ([#593](https://github.com/deanjstone/argus/issues/593)) ([106644e](https://github.com/deanjstone/argus/commit/106644e899159766a1d1461acae618f65baf46e2)), closes [argus#549](https://github.com/argus/issues/549)


### BREAKING CHANGES

* bare `agent` now prints help; `agent -p` and
`agent listen` no longer exist.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

* drop hand-written changelog entry; semantic-release generates it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

# [@argus/agent-cli-v1.1.7](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.6...@argus/agent-cli-v1.1.7) (2026-09-09)


### Bug Fixes

* **agent-cli:** drop doctor checks for decommissioned ccbot and tmux session ([#366](https://github.com/deanjstone/argus/issues/366)) ([6ace7b2](https://github.com/deanjstone/argus/commit/6ace7b204239bc5b108f9e5ec3d2ae5ade819d6e)), closes [argus#302](https://github.com/argus/issues/302) [deanjstone/argus#302](https://github.com/deanjstone/argus/issues/302) [deanjstone/argus-config#294](https://github.com/deanjstone/argus-config/issues/294)

# [@argus/agent-cli-v1.1.6](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.5...@argus/agent-cli-v1.1.6) (2026-08-14)


### Bug Fixes

* **agent-cli:** fix HOME override no-op in projects.test.ts ([#255](https://github.com/deanjstone/argus/issues/255)) ([62cb0ab](https://github.com/deanjstone/argus/commit/62cb0ab34596eb407475cdeec9aaae41315416ec)), closes [#208](https://github.com/deanjstone/argus/issues/208)

# [@argus/agent-cli-v1.1.5](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.4...@argus/agent-cli-v1.1.5) (2026-08-09)


### Bug Fixes

* **release:** disable @semantic-release/github success/fail comments ([#195](https://github.com/deanjstone/argus/issues/195)) ([f8700a7](https://github.com/deanjstone/argus/commit/f8700a7623cba507bb22998fb83df0b8930c187b))

# [@argus/agent-cli-v1.1.4](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.3...@argus/agent-cli-v1.1.4) (2026-08-08)


### Bug Fixes

* **agent-cli:** update ~/projects reference in server.ts error message ([#145](https://github.com/deanjstone/argus/issues/145)) ([950090a](https://github.com/deanjstone/argus/commit/950090ac6395fdeea9aa8f770c006468b14ab9f5)), closes [141/#142](https://github.com/deanjstone/argus/issues/142)

# [@argus/agent-cli-v1.1.3](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.2...@argus/agent-cli-v1.1.3) (2026-08-07)


### Bug Fixes

* **agent-cli:** update CLI help and doctor output to ~/repos ([#142](https://github.com/deanjstone/argus/issues/142)) ([33eed40](https://github.com/deanjstone/argus/commit/33eed407f138227a63831618550846fa16f3b245)), closes [#141](https://github.com/deanjstone/argus/issues/141)

# [@argus/agent-cli-v1.1.2](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.1...@argus/agent-cli-v1.1.2) (2026-08-07)


### Bug Fixes

* **agent-cli:** nest forks dir under repos root, exclude from project list ([#141](https://github.com/deanjstone/argus/issues/141)) ([f8a3889](https://github.com/deanjstone/argus/commit/f8a3889d8c60f5708dabb3e2b28ca68d2165244f)), closes [deanjstone/argus-config#135](https://github.com/deanjstone/argus-config/issues/135)

# [@argus/agent-cli-v1.1.1](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.1.0...@argus/agent-cli-v1.1.1) (2026-08-07)


### Bug Fixes

* dedupe herdr agent launches by reusing existing pane/workspace ([#140](https://github.com/deanjstone/argus/issues/140)) ([494c4ff](https://github.com/deanjstone/argus/commit/494c4ff8ff658219b10fc51fd50627a26d4ee28b))

# [@argus/agent-cli-v1.1.0](https://github.com/deanjstone/argus/compare/@argus/agent-cli-v1.0.0...@argus/agent-cli-v1.1.0) (2026-08-04)


### Features

* control-plane job tracking (ControlPlaneJob, signal, review, routing score) ([#128](https://github.com/deanjstone/argus/issues/128)) ([1b621cf](https://github.com/deanjstone/argus/commit/1b621cfe53f8c67c823a4e549728ec081223fdf1))

# @argus/agent-cli-v1.0.0 (2026-08-03)


### Bug Fixes

* **agent-cli:** also fix isRoot label in explicit subpath branch ([f7aa98e](https://github.com/deanjstone/argus/commit/f7aa98efa20be61c04ad6b1a84c7585c8bcff70b))
* **agent-cli:** base64-encode wt.exe payload to fully neutralize its command-line parser ([#102](https://github.com/deanjstone/argus/issues/102)) ([03f93b5](https://github.com/deanjstone/argus/commit/03f93b55994d3d0105d80acc601269b22c8e6ede))
* **agent-cli:** rename no-flag session label from ARGUS to AGENT ([1968220](https://github.com/deanjstone/argus/commit/1968220ad9c60bf83310b5c21284af67a56d9c5e))
* **agent-cli:** suffix monorepo root label with -ROOT to prevent ARGUS session collision ([5f209bc](https://github.com/deanjstone/argus/commit/5f209bc6225e1f44f814515d9a718e9d5f5edfd0))
* **agent-cli:** walk up dir tree to resolve WT tab color for sub-packages ([2fa59fa](https://github.com/deanjstone/argus/commit/2fa59fa69bfd28dcb6da8ecf1ad866dec6f1e246))
* **agent-listen:** let custom session name override the auto-generated project label ([#93](https://github.com/deanjstone/argus/issues/93)) ([79c3d45](https://github.com/deanjstone/argus/commit/79c3d45b490236cf20b265069196717439dbc893))
* correct ARGUS_DIR path and document watchtower project ([#51](https://github.com/deanjstone/argus/issues/51)) ([7faf680](https://github.com/deanjstone/argus/commit/7faf68004fb8f5706f8f8847e2df7d8a958c69d0))


### Features

* add per-package + monorepo semantic-release versioning ([#125](https://github.com/deanjstone/argus/issues/125)) ([9e8816c](https://github.com/deanjstone/argus/commit/9e8816cdb669bbc863b26eec63849975814d180e))
* **agent-cli:** add ~/CORTEX as ~cortex special entry in -p picker ([eb885e5](https://github.com/deanjstone/argus/commit/eb885e548871b2e6b3a05a9fc4671de973121371))
* **agent-cli:** add doctor and query commands ([db4d290](https://github.com/deanjstone/argus/commit/db4d290d839ef879d9443f3e53511503bcacc2a6))
* **agent-cli:** always create named tmux session on launch ([8a12a59](https://github.com/deanjstone/argus/commit/8a12a59fb4af1418936f4e340c975c953b6cdb4b))
* **agent-cli:** pass session label to claude via --name ([#94](https://github.com/deanjstone/argus/issues/94)) ([7e20e5f](https://github.com/deanjstone/argus/commit/7e20e5f32bbbda4d58153908b14a20190caf600d))
