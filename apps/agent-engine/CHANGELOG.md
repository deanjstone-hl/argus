# [@argus/agent-engine-v1.4.0](https://github.com/deanjstone/argus/compare/@argus/agent-engine-v1.3.0...@argus/agent-engine-v1.4.0) (2026-10-10)


### Features

* **agent-engine:** make /task/run-plan browser-callable with per-task results ([#621](https://github.com/deanjstone/argus/issues/621)) ([b6d9aab](https://github.com/deanjstone/argus/commit/b6d9aaba83e45714818bd6dae38521f08f4f0e4f))

# [@argus/agent-engine-v1.3.0](https://github.com/deanjstone/argus/compare/@argus/agent-engine-v1.2.0...@argus/agent-engine-v1.3.0) (2026-10-08)


### Features

* **agent-engine:** add POST /plans for ADR-010 plan publishing ([#545](https://github.com/deanjstone/argus/issues/545)) ([42dd012](https://github.com/deanjstone/argus/commit/42dd0124e57fdb1b3e0f5ae90b749dbef8aa81b4)), closes [myargus#143](https://github.com/myargus/issues/143) [#543](https://github.com/deanjstone/argus/issues/543) [myargus#214](https://github.com/myargus/issues/214)

# [@argus/agent-engine-v1.2.0](https://github.com/deanjstone/argus/compare/@argus/agent-engine-v1.1.1...@argus/agent-engine-v1.2.0) (2026-08-10)


### Features

* **agent-engine:** stream Claude/Haiku CLI output via stream-json ([#198](https://github.com/deanjstone/argus/issues/198)) ([8ecd3ee](https://github.com/deanjstone/argus/commit/8ecd3ee77f38eef02175c4ace81a3e34d78d3222))

# [@argus/agent-engine-v1.1.1](https://github.com/deanjstone/argus/compare/@argus/agent-engine-v1.1.0...@argus/agent-engine-v1.1.1) (2026-08-09)


### Bug Fixes

* **release:** disable @semantic-release/github success/fail comments ([#195](https://github.com/deanjstone/argus/issues/195)) ([f8700a7](https://github.com/deanjstone/argus/commit/f8700a7623cba507bb22998fb83df0b8930c187b))

# [@argus/agent-engine-v1.1.0](https://github.com/deanjstone/argus/compare/@argus/agent-engine-v1.0.0...@argus/agent-engine-v1.1.0) (2026-08-04)


### Features

* control-plane job tracking (ControlPlaneJob, signal, review, routing score) ([#128](https://github.com/deanjstone/argus/issues/128)) ([1b621cf](https://github.com/deanjstone/argus/commit/1b621cfe53f8c67c823a4e549728ec081223fdf1))

# @argus/agent-engine-v1.0.0 (2026-08-03)


### Bug Fixes

* **agent-engine:** fix DAG task routing and remove redundant task tool ([717926e](https://github.com/deanjstone/argus/commit/717926ebfb101b7c348c85d1e348686835fa9e1e))
* **agent-engine:** sync node_modules, handle empty DAG plan, add atto1 context ([78f06cc](https://github.com/deanjstone/argus/commit/78f06cc87afaf5df87b548142460ea1ea8cc8612))
* remove trailing comma in agent-engine package.json ([f9f87f6](https://github.com/deanjstone/argus/commit/f9f87f66234f7725f1ef90ea19a45efc480dfe95))


### Features

* add per-package + monorepo semantic-release versioning ([#125](https://github.com/deanjstone/argus/issues/125)) ([9e8816c](https://github.com/deanjstone/argus/commit/9e8816cdb669bbc863b26eec63849975814d180e))
* **agent-engine:** add ArgusContext, VectorEngine, path traversal guards ([2d51708](https://github.com/deanjstone/argus/commit/2d517087ccb5422111172d31360f6fcab6fb42da))
* **agent-engine:** add Dockerfile for Docker deployment on dell-server ([09cdd80](https://github.com/deanjstone/argus/commit/09cdd8081c54586fc89594b55655df6b8bcd0136))
* **agent-engine:** add index.ts barrel export for public API ([705e973](https://github.com/deanjstone/argus/commit/705e9739da09dd87178cc36feab43b00c9f4d794))
* **agent-engine:** add server deploy target to deploy.sh ([c728d8d](https://github.com/deanjstone/argus/commit/c728d8d0c422e3a7849046d41a2e33bdd2e56af4))
* **agent-engine:** integrate CLI with engine; switch HaikuAdapter to claude CLI ([70abc5c](https://github.com/deanjstone/argus/commit/70abc5c5d47e7d4d717524107a2063dc93ad0be3))
* **agent-engine:** scaffold packages/agent-engine with full Wave 0–6 implementation ([100d437](https://github.com/deanjstone/argus/commit/100d4375fd4eda8e91669a8c4f51f13e72659193))
* **runtime:** establish ~/.argus/ as the unified runtime dir for all packages ([0125d98](https://github.com/deanjstone/argus/commit/0125d9821d41b546688030e1247ec776572a6abf))
