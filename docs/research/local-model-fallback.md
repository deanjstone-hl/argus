# Is a local-model fallback a real exit, or a fig leaf?

Research for [argus#313](https://github.com/deanjstone/argus/issues/313), part of map [#303](https://github.com/deanjstone/argus/issues/303), blocking [#308](https://github.com/deanjstone/argus/issues/308).

Status: **complete**.

Claim tags: `[FACT-OBS]` observed on this machine in this investigation; `[FACT-DOC]` cited to a primary source; `[INFERENCE]` reasoned, not observed.

## Verdict

**Fig leaf.** Not "unreliable" — the locally-available models **cannot run on this machine at all**, and neither supports tool-calling even if they could.

Two independent blockers, either of which is sufficient:

1. **No tool support.** `gemma3n:e2b` and `:e4b` advertise `completion` only; Ollama rejects a `tools` array at the API boundary.
2. **No capacity.** On GPU the model exceeds 4 GiB VRAM; on CPU it exceeds 5.8 GiB system RAM and the runner is killed before emitting a token.

A user switching to this fallback would not get a degraded agent. They would get no agent.

## Hardware observed

`[FACT-OBS]` `lscpu` / `free -h` / `nvidia-smi`, 2026-08-26, WSL2 on LNV-LGN5:

```
CPU: Intel Core i7-10750H @ 2.60GHz, 4 cores / 8 threads
MemTotal: 6067840 kB  (5.8 GiB total, ~2.7-3.0 GiB available at probe time)
Swap: 2 GiB (/dev/sdc)
nvidia-smi: not on PATH  ->  CORRECTED, see below
ollama version 0.30.10, running as system systemd unit (active)
```

**Correction (superseding an earlier note in this file).** An earlier pass recorded "no CUDA GPU visible to WSL2" because `nvidia-smi` is not on `PATH`. That was wrong.

`[FACT-OBS]` The GPU is present and passed through: `/dev/dxg` exists, `/usr/lib/wsl/lib/` carries `libcuda.so*`, and `/usr/lib/wsl/lib/nvidia-smi` reports:

```
NVIDIA GeForce GTX 1650, 4096 MiB total, 3923 MiB free
```

`[FACT-OBS]` Ollama detects and prefers it (`journalctl -u ollama`):

```
msg="inference compute" library=CUDA compute=7.5 name=CUDA0
  description="NVIDIA GeForce GTX 1650" driver=13.3 type=discrete
  total="4.0 GiB" available="3.2 GiB"
msg="vram-based default context" total_vram="4.0 GiB" default_num_ctx=4096
```

This matters: the binding constraint is **4 GiB of VRAM**, not only system RAM.

`[FACT-OBS]` Models present (`ollama list`): `gemma3n:e2b` 5.6 GB, `gemma3n:e4b` 7.5 GB, `nomic-embed-text` 274 MB. Nothing loaded (`ollama ps` empty).

`[FACT-OBS]` The e4b weights (7.5 GB) exceed total WSL2 RAM (5.8 GiB). The e2b weights (5.6 GB) exceed *available* RAM (~2.7-3.0 GiB) and leave no headroom for KV cache.

## Probe 0 — does Ollama accept a `tools` array for these models?

`[FACT-OBS]` `ollama show` reports the capability set for both models as **`completion` only** — no `tools`:

```
$ ollama show gemma3n:e2b
  Model
    architecture        gemma3n
    parameters          4.5B
    context length      32768
    quantization        Q4_K_M
  Capabilities
    completion
```

(`gemma3n:e4b` identical but 6.9B parameters.)

`[FACT-OBS]` Passing a `tools` array to `/api/chat` is rejected at the API boundary for both models — this is a hard error, not degraded output:

```
$ curl -s http://localhost:11434/api/chat -d '{"model":"gemma3n:e2b","stream":false,
    "messages":[{"role":"user","content":"What is the weather in Sydney?"}],
    "tools":[{"type":"function","function":{"name":"get_weather", ...}}]}'
{"error":"registry.ollama.ai/library/gemma3n:e2b does not support tools"}

$ ... "model":"gemma3n:e4b" ...
{"error":"registry.ollama.ai/library/gemma3n:e4b does not support tools"}
```

`[INFERENCE]` Ollama derives the `tools` capability from whether the model's chat template contains tool-call handling. Gemma 3n ships no tool-call section in its template, so no amount of prompting reaches a native tool-call path: `message.tool_calls` can never be populated for these models.

**Native multi-turn tool-calling against the locally-available models is not degraded — it is unavailable.**

## Probe A — prompted tool-call emulation (the steelman)

Probe 0 closes the native path, but it does not by itself close the question: a fallback could ask the model for JSON in a plain completion and parse tool calls out of the text, which is what wrapper frameworks do for non-tool models. Probe A below tests whether *that* is reliable enough to drive an agent loop. **It never got as far as measuring reliability**, because the model could not be made to run.

### A.1 — GPU path: out of VRAM

`[FACT-OBS]` A single-tool prompted-JSON request to `gemma3n:e2b` (`num_ctx:2048`, `num_predict:120`) fails in 20s:

```json
{"error":"llama-server process has terminated: exit status 1: cudaMalloc failed: out of memory
  alloc_tensor_range: failed to allocate CUDA0 buffer of size 1578850560
  error loading model: unable to allocate CUDA0 buffer"}
```

`[INFERENCE]` A 5.6 GB Q4_K_M model cannot fit in 4 GiB of VRAM. Partial offload would be the normal fallback, which leads directly to A.2.

### A.2 — CPU path: out of system RAM, runner killed

`[FACT-OBS]` Same request with `num_gpu:0` to force CPU inference. The model **loads** — `ollama ps` shows `gemma3n:e2b  6.2 GB  100% CPU  2048 ctx` — and then:

```
elapsed: 397s
ERROR: health resp: Get "http://127.0.0.1:55216/health": EOF
```

`[FACT-OBS]` System memory at the moment of failure:

```
              total  used   free   buff/cache  available
Mem:          5.8Gi  5.7Gi  54Mi   193Mi       92Mi
```

`[INFERENCE]` The 6.2 GB resident runner against 5.8 GiB total RAM drove the machine to 92 MiB available; the `EOF` on the health endpoint is the `llama-server` child dying. **397 seconds elapsed and not one token was produced.**

`[FACT-OBS]` The model was unloaded (`ollama stop`) and memory recovered to 4.1 GiB available.

### Why `gemma3n:e4b` was not tested

`[INFERENCE]` At 7.5 GB it is strictly larger than the 5.6 GB variant that already exhausted both VRAM and system RAM. Testing it would consume ~10 minutes to reproduce a known failure, and risks destabilising the machine — the e2b CPU probe already took the system to 92 MiB available. Its `ollama show` capability set is identical (`completion` only), so it fails blocker 1 regardless.

## Is there a materially better locally-runnable option?

`[INFERENCE]` — assessed on published data only; **nothing was downloaded**, per the ticket's constraint.

The real budget is **4 GiB VRAM** (fast path) or roughly **3.5-4 GiB resident** (CPU path, leaving headroom for the OS). Weights plus KV cache must fit. That points at 1.5B-4B parameter models at Q4, not the 4.5B/6.9B Gemma 3n pair already present.

Candidates with **native tool-calling in their chat template** — the property Gemma 3n lacks, and the one that actually matters:

| Model | Approx Q4 size | Fits 4 GiB VRAM | Native tools |
|---|---|---|---|
| `qwen3:1.7b` | ~1.4 GB | comfortably | yes |
| `llama3.2:3b` | ~2.0 GB | yes | yes |
| `qwen3:4b` | ~2.6 GB | tight but plausible | yes |

`[INFERENCE]` Any of these would clear both blockers. What none of them clears is the *quality* question: a 1.7B-4B model driving a multi-turn agent loop over a vault, with a multi-thousand-token system prompt, is a different proposition from Claude. That question is untestable here without downloading, and this ticket does not answer it.

## What this means for the map

1. **The tripwires in [#312](https://github.com/deanjstone/argus/issues/312) are observation-only as things stand.** There is no working local exit today, so the design should not pay anything to keep one open.
2. **A local exit is not impossible — just not with what is installed.** It costs a deliberate model download (~1.4-2.6 GB) of a *tool-capable* small model, and it would still need its agent-loop quality proven.
3. **The 4 GiB VRAM ceiling is the real constraint** on this machine, and it is the number any future local-model decision should be sized against — not the 5.8 GiB of system RAM.

