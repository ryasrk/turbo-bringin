#!/usr/bin/env python3
"""Speed/throughput benchmark for Bonsai models.

Measures:
  - Decode speed (tokens/sec)
  - Time-to-first-token (TTFT)
  - Peak VRAM usage
  - RAM usage

Usage:
    python3 benchmarks/bench_speed.py \
        --model-path models/bonsai-8b-1.5bit.gguf \
        --config config/baseline.yaml \
        --mode baseline

    python3 benchmarks/bench_speed.py \
        --model-path models/bonsai-8b-1.5bit.gguf \
        --config config/turboquant.yaml \
        --mode turboquant
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import psutil
import yaml

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


# ---------------------------------------------------------------------------
# GPU memory helper
# ---------------------------------------------------------------------------
def get_gpu_memory_mb() -> dict:
    """Get GPU memory usage in MB. Returns dict with total, used, free."""
    try:
        import subprocess

        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.total,memory.used,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split(",")
            return {
                "total_mb": int(parts[0].strip()),
                "used_mb": int(parts[1].strip()),
                "free_mb": int(parts[2].strip()),
            }
    except Exception:
        pass
    return {"total_mb": 0, "used_mb": 0, "free_mb": 0}


def get_ram_usage_mb() -> float:
    """Get current process RAM usage in MB."""
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / (1024 * 1024)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class SpeedResult:
    mode: str
    context_length: int
    tokens_per_sec: float
    ttft_ms: float
    vram_used_mb: int
    ram_used_mb: float
    prompt_tokens: int
    completion_tokens: int
    generation_time_s: float


@dataclass
class BenchmarkReport:
    model_path: str
    mode: str
    timestamp: str
    results: list[dict] = field(default_factory=list)
    system_info: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Benchmark prompts (matched to context lengths)
# ---------------------------------------------------------------------------
PROMPTS = {
    2048: "Explain the theory of relativity in detail, covering both special and general relativity. Include the key equations and their physical interpretations.",
    4096: "Write a comprehensive guide to building a web application from scratch. Cover frontend, backend, database design, authentication, deployment, testing, and monitoring. Include code examples for each section.",
    8192: "Write a detailed technical paper about transformer architectures. Cover the original attention mechanism, multi-head attention, positional encoding, layer normalization, and recent advances including sparse attention, linear attention, and mixture of experts. Include mathematical formulations and pseudocode.",
    16384: "Write an extensive textbook chapter on the history of computing, from Charles Babbage and Ada Lovelace through the development of electronic computers, transistors, integrated circuits, microprocessors, personal computers, the internet, mobile computing, cloud computing, and artificial intelligence. Include technical details, key figures, and the social impact of each era.",
}


def load_config(config_path: str) -> dict:
    """Load YAML config file."""
    with open(config_path) as f:
        return yaml.safe_load(f)


def load_model(model_path: str, config: dict):
    """Load model with llama-cpp-python."""
    try:
        from llama_cpp import Llama
    except ImportError:
        print("ERROR: llama-cpp-python not installed.")
        print("Install: CMAKE_ARGS='-DGGML_CUDA=on' pip install llama-cpp-python")
        sys.exit(1)

    model_cfg = config.get("model", {})
    kv_cfg = config.get("kv_cache", {})

    kwargs = {
        "model_path": model_path,
        "n_ctx": model_cfg.get("n_ctx", 8192),
        "n_gpu_layers": model_cfg.get("n_gpu_layers", 99),
        "n_threads": model_cfg.get("n_threads", 8),
        "n_batch": model_cfg.get("n_batch", 512),
        "verbose": False,
    }

    # KV cache settings
    if kv_cfg.get("cache_type_k"):
        kwargs["type_k"] = kv_cfg["cache_type_k"]
    if kv_cfg.get("cache_type_v"):
        kwargs["type_v"] = kv_cfg["cache_type_v"]
    if kv_cfg.get("flash_attention"):
        kwargs["flash_attn"] = True

    print(f"Loading model: {model_path}")
    print(f"  n_ctx={kwargs['n_ctx']}, n_gpu_layers={kwargs['n_gpu_layers']}")
    print(f"  KV: K={kv_cfg.get('cache_type_k', 'default')}, V={kv_cfg.get('cache_type_v', 'default')}")

    model = Llama(**kwargs)
    return model


def run_benchmark(
    model,
    prompt: str,
    context_length: int,
    mode: str,
    max_gen_tokens: int = 128,
    warmup_runs: int = 2,
    measure_runs: int = 5,
) -> SpeedResult:
    """Run speed benchmark for a single context length."""
    messages = [{"role": "user", "content": prompt}]

    # Warmup
    print(f"  Warming up ({warmup_runs} runs)...", end="", flush=True)
    for _ in range(warmup_runs):
        model.create_chat_completion(
            messages=messages,
            max_tokens=32,
            temperature=0.0,
        )
    print(" done")

    # Measure
    times = []
    ttfts = []
    token_counts = []

    print(f"  Measuring ({measure_runs} runs)...", end="", flush=True)
    for run_i in range(measure_runs):
        gc.collect()

        # Measure TTFT via streaming
        t_start = time.perf_counter()
        first_token_time = None
        total_tokens = 0

        for chunk in model.create_chat_completion(
            messages=messages,
            max_tokens=max_gen_tokens,
            temperature=0.0,
            stream=True,
        ):
            if first_token_time is None:
                first_token_time = time.perf_counter()
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            if delta.get("content"):
                total_tokens += 1

        t_end = time.perf_counter()

        gen_time = t_end - t_start
        ttft = (first_token_time - t_start) * 1000 if first_token_time else 0

        times.append(gen_time)
        ttfts.append(ttft)
        token_counts.append(total_tokens)

    print(" done")

    # Collect memory stats
    gpu_mem = get_gpu_memory_mb()
    ram_mb = get_ram_usage_mb()

    avg_time = float(np.mean(times))
    avg_tokens = float(np.mean(token_counts))
    tps = avg_tokens / avg_time if avg_time > 0 else 0

    return SpeedResult(
        mode=mode,
        context_length=context_length,
        tokens_per_sec=round(tps, 2),
        ttft_ms=round(float(np.mean(ttfts)), 2),
        vram_used_mb=gpu_mem["used_mb"],
        ram_used_mb=round(ram_mb, 1),
        prompt_tokens=len(prompt.split()),  # approximate
        completion_tokens=int(avg_tokens),
        generation_time_s=round(avg_time, 3),
    )


def main():
    parser = argparse.ArgumentParser(description="Speed benchmark for Bonsai models")
    parser.add_argument("--model-path", required=True, help="Path to GGUF model")
    parser.add_argument("--config", required=True, help="Path to YAML config")
    parser.add_argument("--mode", required=True, choices=["baseline", "turboquant"])
    parser.add_argument("--output", default="results/speed.json", help="Output JSON path")
    parser.add_argument("--warmup-runs", type=int, default=None)
    parser.add_argument("--measure-runs", type=int, default=None)
    parser.add_argument("--max-gen-tokens", type=int, default=None)
    args = parser.parse_args()

    config = load_config(args.config)
    bench_cfg = config.get("benchmark", {})

    warmup = args.warmup_runs or bench_cfg.get("warmup_runs", 2)
    measure = args.measure_runs or bench_cfg.get("measure_runs", 5)
    max_gen = args.max_gen_tokens or bench_cfg.get("max_gen_tokens", 128)
    context_lengths = bench_cfg.get("context_lengths", [2048, 4096, 8192])

    # Load model
    model = load_model(args.model_path, config)

    # System info
    gpu_info = get_gpu_memory_mb()
    report = BenchmarkReport(
        model_path=args.model_path,
        mode=args.mode,
        timestamp=datetime.now(timezone.utc).isoformat(),
        system_info={
            "gpu_total_mb": gpu_info["total_mb"],
            "ram_total_mb": round(psutil.virtual_memory().total / (1024 * 1024)),
            "cpu_count": os.cpu_count(),
        },
    )

    print(f"\n{'='*60}")
    print(f"  Speed Benchmark — {args.mode}")
    print(f"{'='*60}")

    for ctx_len in context_lengths:
        prompt = PROMPTS.get(ctx_len, PROMPTS[2048])
        print(f"\n── Context: {ctx_len} tokens ──")

        result = run_benchmark(
            model=model,
            prompt=prompt,
            context_length=ctx_len,
            mode=args.mode,
            max_gen_tokens=max_gen,
            warmup_runs=warmup,
            measure_runs=measure,
        )

        report.results.append(asdict(result))

        print(f"  tokens/sec: {result.tokens_per_sec}")
        print(f"  TTFT:       {result.ttft_ms} ms")
        print(f"  VRAM:       {result.vram_used_mb} MB")
        print(f"  RAM:        {result.ram_used_mb} MB")

    # Save results
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(asdict(report), f, indent=2)

    print(f"\n✅ Results saved to {output_path}")

    # Print summary table
    print(f"\n{'─'*72}")
    print(f"{'Mode':<12} {'Context':<10} {'tok/s':<10} {'TTFT(ms)':<10} {'VRAM(MB)':<10} {'RAM(MB)':<10}")
    print(f"{'─'*72}")
    for r in report.results:
        print(
            f"{r['mode']:<12} {r['context_length']:<10} "
            f"{r['tokens_per_sec']:<10} {r['ttft_ms']:<10} "
            f"{r['vram_used_mb']:<10} {r['ram_used_mb']:<10}"
        )
    print(f"{'─'*72}")


if __name__ == "__main__":
    main()
