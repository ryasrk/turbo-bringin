# Tenrary-X: Bonsai-8B Q1_0 Inference & TurboQuant KV Research

Research project for evaluating **Bonsai-8B** (prism-ml, true 1-bit Q1_0 weights,
1.16 GB) on consumer GPU (8GB VRAM) and measuring the impact of TurboQuant KV
cache compression on long-context scaling, throughput, and output quality.

## Model

| | |
|---|---|
| Model | [prism-ml/Bonsai-8B-gguf](https://huggingface.co/prism-ml/Bonsai-8B-gguf) |
| Architecture | Qwen3-8B dense: 36 layers, 32 query / 8 KV heads, SwiGLU, RoPE |
| Format | GGUF Q1_0 (1.125 effective bits/weight) |
| Size | 1.16 GB (14.2x smaller than FP16) |
| Context | Up to 65,536 tokens |
| Engine | [PrismML llama.cpp fork](https://github.com/PrismML-Eng/llama.cpp) (Q1_0 CUDA kernels) |

## Objectives

1. **Baseline** — Get Bonsai 1–1.5 bit 8B running stably on llama.cpp with full GPU offload
2. **Benchmark** — Measure tokens/sec, VRAM, RAM, output quality as ground truth
3. **TurboQuant** — Apply KV cache compression and compare against baseline
4. **Research** — KV cache scaling, stability, hybrid KV strategies

## Project Structure

```
tenrary-x/
├── README.md
├── setup.sh                  # Environment + PrismML llama.cpp + TQ engine setup
├── config/
│   ├── baseline.yaml         # Baseline llama.cpp config
│   └── turboquant.yaml       # TurboQuant experiment config
├── engines/
│   └── llama-cpp-prismml/    # PrismML llama.cpp fork (built by setup.sh)
├── scripts/
│   ├── download_model.sh     # Download Bonsai-8B Q1_0 GGUF
│   ├── run_baseline.sh       # Run baseline inference + benchmarks
│   ├── run_turboquant.sh     # Run TurboQuant inference + benchmarks
│   ├── bench_cli.sh          # Quick CLI benchmark (no Python needed)
│   └── run_all_benchmarks.sh # Full benchmark suite
├── benchmarks/
│   ├── bench_speed.py        # tokens/sec, TTFT, VRAM/RAM
│   ├── bench_quality.py      # coherence, repetition, hallucination scoring
│   ├── bench_kv_scaling.py   # KV cache scaling across context lengths
│   ├── generate_report.py    # Auto-generate Markdown comparison report
│   └── prompts/              # Standardized test prompts
├── results/
├── models/                   # GGUF model files
└── docs/
    └── experiment_log.md     # Running experiment log
```

## Quick Start

```bash
# 1. Setup environment
./setup.sh

# 2. Download model
./scripts/download_model.sh

# 3. Run baseline
./scripts/run_baseline.sh

# 4. Run TurboQuant experiment
./scripts/run_turboquant.sh

# 5. Run full benchmark suite
./scripts/run_all_benchmarks.sh
```

## Roadmap

| Step | Task | Status |
|------|------|--------|
| 1 | Bonsai stabil di llama.cpp | ⬜ |
| 2 | Benchmark baseline | ⬜ |
| 3 | Jalankan TurboQuant | ⬜ |
| 4 | Bandingkan baseline vs TQ | ⬜ |
| 5 | Eksperimen hybrid KV (opsional) | ⬜ |

## Hardware Requirements

| Component | Minimum |
|-----------|---------|
| GPU VRAM  | 8 GB |
| RAM       | 16 GB |
| Disk      | 10 GB (model + deps) |
| OS        | Linux |
