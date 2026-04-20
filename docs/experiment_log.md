# Tenrary-X Experiment Log

## Model Info
- **Model**: Bonsai-8B Q1_0 (prism-ml) — 1.16 GB GGUF
- **Architecture**: Qwen3-8B dense (36 layers, 32q/8kv heads, SwiGLU, RoPE)
- **Hardware**: NVIDIA GeForce RTX 4060 Laptop GPU (8187 MiB VRAM)
- **OS**: Linux
- **Engine**: PrismML llama.cpp fork (build b8846-d104cf1b6)

---

## Baseline Results (2026-04-20)

### Memory Breakdown

| Context | Model (MB) | KV Cache (MB) | Compute (MB) | Total GPU (MB) | Free (MB) |
|---------|-----------|---------------|--------------|----------------|-----------|
| 2048    | 1015      | 288           | 304          | 1608           | 5468      |
| 4096    | 1015      | 576           | 304          | 1896           | 5180      |
| 8192    | 1015      | 1152          | 304          | 2472           | 4604      |

### Speed

| Test | Context | Prompt (t/s) | Generation (t/s) |
|------|---------|-------------|------------------|
| Reasoning | 2048 | 477.0 | 87.4 |
| Coding | 4096 | 580.8 | 87.7 |
| Knowledge | 8192 | 953.9 | 89.6 |

### Quality (Baseline)
- Reasoning: ✅ Correct (sheep problem solved perfectly)
- Coding: ✅ Complete binary search with type hints, error handling, docstring
- Knowledge: ✅ Detailed relativity explanation with LaTeX equations

### Key Observations
1. **KV cache scales linearly**: 288→576→1152 MB (doubles per 2x context)
2. **Generation speed constant**: ~87-90 tok/s regardless of context length
3. **Massive VRAM headroom**: 8K only uses 2.5 GB of 8 GB — can go 16K+ easily
4. **Model itself tiny**: Only 1015 MB for weights (1-bit compression working)
5. **Bottleneck is NOT model loading** — it's KV cache at long context

---

## Eksperimen A — KV Cache Scaling (Baseline)

| Context | KV Cache (MB) | Total VRAM (MB) | % of 8GB |
|---------|---------------|-----------------|----------|
| 2K      | 288           | 1608            | 19.6%    |
| 4K      | 576           | 1896            | 23.2%    |
| 8K      | 1152          | 2472            | 30.2%    |
| 16K*    | ~2304         | ~3624           | ~44.3%   |
| 32K*    | ~4608         | ~5928           | ~72.4%   |

*Projected from linear scaling pattern (144 MB per 1K context)

### TurboQuant KV Comparison (COMPLETED)
| Context | Baseline KV (f16) | q8_0 KV | q4_0 KV (+FA) | q4_0 Savings |
|---------|-------------------|---------|---------------|--------------|
| 2K      | 288 MB            | 153 MB  | 81 MB         | **72%**      |
| 4K      | 576 MB            | 306 MB  | 162 MB        | **72%**      |
| 8K      | 1152 MB           | 612 MB  | 324 MB        | **72%**      |
| 16K     | 2304 MB           | 1224 MB | 648 MB        | **72%**      |

### Speed Comparison
| Config | Avg Gen (t/s) | vs Baseline |
|--------|---------------|-------------|
| f16 baseline | 92.3 | — |
| q8_0 (no FA) | 85.6 | -7.3% |
| q4_0/q4_0 + FA | 84.9 | -8.0% |
| q8_0/q4_0 + FA | 36.3 | ❌ -60.7% BUG |

### Critical Discovery
- **Mixed K/V quant (q8_0 keys + q4_0 values) triggers slow path → 60% speed regression**
- Symmetric quant (same type for K and V) works perfectly
- q4_0/q4_0 + FA = best tradeoff (72% VRAM savings, 8% speed loss)

---

## Eksperimen B — Stability Test (COMPLETED)
- Coherence: baseline ✅ all correct | q8_0 ✅ all correct | q4_0 ⚠️ 1/4 error (8K ctx)
- Repetition: No repetition observed in any config
- Hallucination: q4_0 at 8K produced wrong math (said "8" instead of "9")

## Eksperimen C — Throughput vs Latency (COMPLETED)
- tokens/sec: baseline ~92 t/s | q8_0 ~86 t/s | q4_0+FA ~85 t/s
- First token latency: Not measured (prompt processing >400 t/s all configs)

---

## Risiko & Catatan
- Bonsai sudah extreme low-bit (1-1.5 bit) → KV compression might have diminishing returns
- Monitor for quality degradation carefully
- KV cache IS the VRAM bottleneck (not weights) → TQ has high potential here
- At 32K context, KV alone would use 4.6 GB — TQ could enable 65K context on 8GB GPU
