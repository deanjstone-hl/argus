# Windows-hosted Obsidian plugin: where do embeddings come from?

**Ticket:** [argus#315](https://github.com/deanjstone/argus/issues/315) (research, child of [#303](https://github.com/deanjstone/argus/issues/303))
**Status:** complete
**Date:** 2026-08-26

## Question

How does a Windows-hosted Obsidian plugin get embeddings, when Ollama is installed only in WSL2?

## Evidence tags

- `[FACT-OBS]` — observed directly on this machine, command output included.
- `[FACT-DOC]` — stated by a primary source (official docs, upstream source code).
- `[INFERENCE]` — reasoning on top of the above, not itself observed.

## Recommendation (summary)

**Install Ollama on Windows (option 2).** Option 1 works today and works well, but it is the only thing that would re-introduce a WSL2 dependency the plugin no longer otherwise has — see "What changed under this ticket" below. Option 3 is not the cheap reuse the ticket assumed.

Use **option 1 as the zero-install development path** in the meantime; it needs no code change to switch, only a base URL.

---

## What changed under this ticket

When #315 was written, the reasoning was "the plugin already depends on WSL2 for the Claude backend, so an embeddings hop adds nothing new."

**[FACT-OBS]** [#314](https://github.com/deanjstone/argus/issues/314) invalidated that. There is a native Windows `claude.exe` (Claude Desktop-bundled), it resolves subscription auth, and `@anthropic-ai/claude-agent-sdk` spawns it successfully under Windows Node. The model path does **not** cross into WSL2.

**[INFERENCE]** Embeddings are therefore the *last* WSL2 dependency, not one of several. Choosing option 1 means the plugin's semantic layer dies whenever WSL2 is not running, in a design that would otherwise be fully Windows-native. That reframes the whole question and is why the recommendation lands on option 2 rather than the cheapest working path.

---

## 1. Reach WSL2's Ollama from Windows

**It works, and it is fast — but only via `127.0.0.1`, not `localhost`.**

**[FACT-OBS]** Ollama in WSL2 binds all interfaces, not loopback-only. Its systemd unit sets `OLLAMA_HOST=0.0.0.0`, and `ss -tlnp` shows `LISTEN *:11434`.

**[FACT-OBS]** `C:\Users\deanj\.wslconfig` sets `networkingMode=mirrored` (plus `dnsTunneling=true`, `firewall=true`, `vmIdleTimeout=-1`). Mirrored networking is why Windows can reach the WSL2 listener on loopback at all.

**[FACT-OBS]** Reachability from Windows PowerShell, `GET /api/tags`:

| Host | Result |
|---|---|
| `localhost` | timed out at 6s; **succeeded at 21,126ms** on a longer timeout, then 14ms, 13ms |
| `127.0.0.1` | HTTP 200 in 16ms, 16ms, 16ms — no cold penalty |
| `100.64.0.3` (Tailscale addr) | timed out |

**[INFERENCE]** The ~21s first-hit cost on `localhost` is an IPv6-first resolution attempt (`::1`) timing out before falling back to IPv4. It is not breakage, but a plugin using `localhost` would appear to hang on its first embedding call after every Windows boot. **Use `127.0.0.1` explicitly.**

**[FACT-OBS]** Embedding round-trips against `nomic-embed-text` via `127.0.0.1`, 768 dimensions returned each time:

| Call | Latency |
|---|---|
| Cold (model not loaded) | 24,396ms |
| First warm | 469ms |
| Subsequent | 105ms, 95ms, 97ms |

**[INFERENCE]** ~100ms per chunk warm is entirely usable for incremental indexing and acceptable for a full rebuild. The 24s cold load is a one-time cost per model unload.

**Failure mode when the dependency is absent:** WSL2 not running means nothing is listening on `127.0.0.1:11434` from Windows' point of view, and every embedding call fails. Semantic search, the knowledge layer and memory retrieval all go dark with no local fallback. **[FACT-OBS]** `vmIdleTimeout=-1` means the VM does not idle out once started — so in practice this bites after a Windows reboot where WSL has not been started, not mid-session. Not tested by shutting WSL down, because that would kill the session doing the testing.

## 2. Ollama on Windows

**Assessed, not installed** (per the ticket's constraint).

**[FACT-OBS]** No Windows Ollama install exists today — nothing under `AppData\Local\Programs\Ollama`.

**[FACT-OBS]** `nomic-embed-text` is 274 MB, so a duplicate copy of the embedding model is a trivial storage cost. (The `gemma3n` models at 5.6/7.5 GB would not need duplicating — they are irrelevant to embeddings.)

**[INFERENCE]** Costs: a second daemon to keep updated, a second model store, and two Ollama instances on one machine that can drift in version. Benefits: the plugin becomes fully self-contained on Windows, with no cross-boundary dependency at all, and Ollama installs as a Windows service that starts with the OS.

**Failure mode when the dependency is absent:** the service is local to the machine the plugin runs on, so "absent" means "the service stopped" — the same class of failure as any local daemon, recoverable without reference to another OS.

## 3. In-process embeddings via transformers.js

**Not the cheap reuse the ticket assumed.**

**[FACT-OBS]** vault-operator's `@huggingface/transformers` + `onnxruntime-web` machinery is **reranker-only**. Grepping `src/core/semantic/` and `src/core/memory/EmbeddingService.ts` for `transformers` returns nothing — there is no existing embedding-via-transformers path. The `EmbeddingService`/`VaultOperatorEmbeddingProvider` pair wraps an HTTP callback into `SemanticIndexService.embedBatchViaApi`.

**[FACT-OBS]** The asset machinery is real and would be reusable: `OptionalAssetManager` downloads large optional assets on explicit user action, verifies SHA256, and refuses to mark a mismatched download as installed. The reranker ships as two paired assets — `reranker-bundle.js` (0.6 MB, the tree-shaken JS) and `ort-wasm-simd-threaded.wasm` (12 MB) — and only activates when both are present.

**[FACT-OBS]** Every asset is fetched from `https://github.com/pssah4/vault-operator/releases/download/${pluginVersion}-assets/...`. **[INFERENCE]** A fork must host its own release assets or rebuild them; it cannot rely on upstream's tags, which are keyed to upstream's plugin version.

**[INFERENCE]** So option 3 means: write the embedding path, build and host an ONNX embedding model asset, and accept WASM-speed throughput for a full-vault index. It is the only option with no daemon at all, and the only one that would survive with neither WSL2 nor a Windows Ollama — but it is net-new work in a fork that already has no test suite.

**Failure mode when the dependency is absent:** essentially none — assets are local files. The trade is throughput and build effort, not availability.

---

## Comparison

| | Works today | Cross-boundary | Net-new code | Fails when |
|---|---|---|---|---|
| 1. WSL2 Ollama via `127.0.0.1` | **yes**, ~100ms/chunk warm | **yes** | none (base URL only) | WSL2 not running → semantic layer dark |
| 2. Ollama on Windows | after install | no | none | local service stopped |
| 3. transformers.js in-process | no | no | **substantial** + self-hosted assets | ~never; costs throughput |

## Recommendation

**Option 2 for the design; option 1 for development now.**

The deciding criterion set by the ticket was which fails least badly, not which is fastest. Option 1 is the fastest to adopt and performs well, but post-#314 it is the *only* remaining thread tying a Windows-native plugin to WSL2, and its failure mode is the whole semantic layer going silently dark. Option 2 removes that thread for the price of a 274 MB model copy and a second daemon, and requires no code beyond pointing at a different base URL.

Option 3 is worth revisiting only if the fork decision ([#308](https://github.com/deanjstone/argus/issues/308)) lands somewhere that already forces the asset-hosting problem to be solved.

**Regardless of which is chosen: use `127.0.0.1`, never `localhost`.** The 21-second IPv6 fallback would present as a hang on the first embedding call after every boot.
