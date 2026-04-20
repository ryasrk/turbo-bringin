#!/usr/bin/env python3
"""KV Cache Scaling benchmark.

Eksperimen A dari research plan:
Mengukur bagaimana KV cache compression mempengaruhi performa
di berbagai context length.

Tests:
  - VRAM usage at each context length (baseline vs TQ)
  - tokens/sec at each context length
  - whether TQ enables longer context that baseline can't fit

Usage:
    python3 benchmarks/bench_kv_scaling.py \
        --model-path models/bonsai-8b-1.5bit.gguf \
        --config config/turboquant.yaml
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

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


def get_gpu_memory_mb() -> dict:
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


# KV cache configs to compare
KV_CONFIGS = {
    "baseline_q8": {"cache_type_k": "q8_0", "cache_type_v": "q8_0"},
    "tq_quality": {"cache_type_k": "q8_0", "cache_type_v": "q4_0"},
}


@dataclass
class ScalingResult:
    kv_config_name: str
    context_length: int
    tokens_per_sec: float
    vram_used_mb: int
    ram_used_mb: float
    success: bool
    error: str = ""


@dataclass
class ScalingReport:
    model_path: str
    timestamp: str
    results: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


# Long prompt to fill context
FILL_PROMPT = (
    "The history of artificial intelligence spans decades of research and development. "
    "From early symbolic AI systems in the 1950s through neural networks, expert systems, "
    "machine learning, deep learning, and modern large language models, the field has undergone "
    "dramatic transformations. Each era brought new insights about the nature of intelligence "
    "and computation. Today, foundation models trained on vast datasets demonstrate remarkable "
    "capabilities in language understanding, code generation, and multimodal reasoning. "
) * 50  # ~350 words repeated to fill context


def load_config(config_path: str) -> dict:
    with open(config_path) as f:
        return yaml.safe_load(f)


def test_config_at_context(
    model_path: str,
    kv_name: str,
    kv_config: dict,
    context_length: int,
    model_cfg: dict,
    max_gen_tokens: int = 64,
    measure_runs: int = 3,
) -> ScalingResult:
    """Test a specific KV config at a specific context length."""
    try:
        from llama_cpp import Llama
    except ImportError:
        return ScalingResult(
            kv_config_name=kv_name,
            context_length=context_length,
            tokens_per_sec=0,
            vram_used_mb=0,
            ram_used_mb=0,
            success=False,
            error="llama-cpp-python not installed",
        )

    try:
        model = Llama(
            model_path=model_path,
            n_ctx=context_length,
            n_gpu_layers=model_cfg.get("n_gpu_layers", 99),
            n_threads=model_cfg.get("n_threads", 8),
            n_batch=model_cfg.get("n_batch", 512),
            type_k=kv_config["cache_type_k"],
            type_v=kv_config["cache_type_v"],
            flash_attn=True,
            verbose=False,
        )

        # Generate with enough tokens to see effect
        prompt = FILL_PROMPT[:context_length * 2]  # approximate chars to fill
        messages = [{"role": "user", "content": prompt}]

        times = []
        token_counts = []

        for _ in range(measure_runs):
            gc.collect()
            t_start = time.perf_counter()
            total_tokens = 0

            for chunk in model.create_chat_completion(
                messages=messages,
                max_tokens=max_gen_tokens,
                temperature=0.0,
                stream=True,
            ):
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                if delta.get("content"):
                    total_tokens += 1

            t_end = time.perf_counter()
            times.append(t_end - t_start)
            token_counts.append(total_tokens)

        gpu_mem = get_gpu_memory_mb()
        ram_mb = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)

        avg_time = float(np.mean(times))
        avg_tokens = float(np.mean(token_counts))
        tps = avg_tokens / avg_time if avg_time > 0 else 0

        del model
        gc.collect()

        return ScalingResult(
            kv_config_name=kv_name,
            context_length=context_length,
            tokens_per_sec=round(tps, 2),
            vram_used_mb=gpu_mem["used_mb"],
            ram_used_mb=round(ram_mb, 1),
            success=True,
        )

    except Exception as e:
        return ScalingResult(
            kv_config_name=kv_name,
            context_length=context_length,
            tokens_per_sec=0,
            vram_used_mb=0,
            ram_used_mb=0,
            success=False,
            error=str(e),
        )


def main():
    parser = argparse.ArgumentParser(description="KV Cache Scaling benchmark")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", default="results/kv_scaling.json")
    parser.add_argument("--measure-runs", type=int, default=3)
    args = parser.parse_args()

    config = load_config(args.config)
    model_cfg = config.get("model", {})
    bench_cfg = config.get("benchmark", {})
    context_lengths = bench_cfg.get("context_lengths", [2048, 4096, 8192, 16384])

    report = ScalingReport(
        model_path=args.model_path,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    print(f"\n{'='*72}")
    print(f"  KV Cache Scaling Benchmark")
    print(f"{'='*72}")

    for ctx_len in context_lengths:
        for kv_name, kv_config in KV_CONFIGS.items():
            print(f"\n── {kv_name} @ {ctx_len} tokens ──")

            result = test_config_at_context(
                model_path=args.model_path,
                kv_name=kv_name,
                kv_config=kv_config,
                context_length=ctx_len,
                model_cfg=model_cfg,
                measure_runs=args.measure_runs,
            )

            report.results.append(asdict(result))

            if result.success:
                print(f"  tok/s: {result.tokens_per_sec}  VRAM: {result.vram_used_mb} MB")
            else:
                print(f"  FAILED: {result.error}")

    # Build comparison table
    print(f"\n{'='*72}")
    print(f"  KV Cache Scaling — Comparison Table")
    print(f"{'='*72}")
    print(f"{'Context':<10} {'Config':<18} {'tok/s':<10} {'VRAM(MB)':<10} {'Status':<10}")
    print(f"{'─'*72}")
    for r in report.results:
        status = "✅" if r["success"] else f"❌ {r['error'][:20]}"
        print(
            f"{r['context_length']:<10} {r['kv_config_name']:<18} "
            f"{r['tokens_per_sec']:<10} {r['vram_used_mb']:<10} {status}"
        )

    # Save
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(asdict(report), f, indent=2)

    print(f"\n✅ Results saved to {output_path}")


if __name__ == "__main__":
    main()
