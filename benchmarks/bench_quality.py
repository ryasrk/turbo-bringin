#!/usr/bin/env python3
"""Quality benchmark for Bonsai models.

Evaluates output quality using standardized test prompts and scores:
  - Coherence (does the output make logical sense?)
  - Repetition (is there excessive repetition?)
  - Completeness (does it actually answer the question?)

Saves raw outputs for manual review alongside automated metrics.

Usage:
    python3 benchmarks/bench_quality.py \
        --model-path models/bonsai-8b-1.5bit.gguf \
        --config config/baseline.yaml \
        --mode baseline
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import yaml

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))


# ---------------------------------------------------------------------------
# Test prompts — standardized across all experiments
# ---------------------------------------------------------------------------
TEST_PROMPTS = [
    {
        "category": "reasoning",
        "prompt": "A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain your reasoning step by step.",
        "expected_keywords": ["9", "left", "all but"],
    },
    {
        "category": "reasoning",
        "prompt": "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets? Show your work.",
        "expected_keywords": ["5 minutes", "each machine"],
    },
    {
        "category": "coding",
        "prompt": "Write a Python function that finds the longest palindromic substring in a given string. Include type hints and a brief explanation of the algorithm.",
        "expected_keywords": ["def", "palindrom", "return"],
    },
    {
        "category": "coding",
        "prompt": "Write a Python function to implement binary search on a sorted list. Include error handling for edge cases.",
        "expected_keywords": ["def", "binary", "return", "mid"],
    },
    {
        "category": "knowledge",
        "prompt": "Explain the difference between TCP and UDP protocols. When would you choose one over the other?",
        "expected_keywords": ["TCP", "UDP", "reliable", "connection"],
    },
    {
        "category": "instruction_following",
        "prompt": "List exactly 5 programming languages that are commonly used for data science. Format each as a numbered list item.",
        "expected_keywords": ["Python", "1.", "2.", "3.", "4.", "5."],
    },
]


# ---------------------------------------------------------------------------
# Scoring functions
# ---------------------------------------------------------------------------
def score_repetition(text: str) -> float:
    """Score repetition (0.0 = high repetition, 1.0 = no repetition).

    Measures n-gram repetition rates.
    """
    words = text.lower().split()
    if len(words) < 10:
        return 1.0

    # 3-gram repetition
    trigrams = [tuple(words[i : i + 3]) for i in range(len(words) - 2)]
    if not trigrams:
        return 1.0

    trigram_counts = Counter(trigrams)
    repeated = sum(c - 1 for c in trigram_counts.values() if c > 1)
    repetition_rate = repeated / len(trigrams)

    # Score: lower repetition = higher score
    return max(0.0, 1.0 - repetition_rate * 2)


def score_coherence(text: str) -> float:
    """Score coherence (0.0 = incoherent, 1.0 = coherent).

    Basic heuristics:
    - Sentence count and average length
    - Vocabulary diversity
    - Structural markers
    """
    sentences = re.split(r"[.!?]+", text)
    sentences = [s.strip() for s in sentences if s.strip()]

    if not sentences:
        return 0.0

    words = text.lower().split()
    if len(words) < 5:
        return 0.3

    # Vocabulary diversity
    unique_ratio = len(set(words)) / len(words)

    # Sentence length consistency
    lengths = [len(s.split()) for s in sentences]
    avg_len = sum(lengths) / len(lengths)
    length_ok = 5 < avg_len < 50  # reasonable sentence length

    # Structural markers
    has_structure = any(
        marker in text.lower()
        for marker in ["first", "second", "because", "therefore", "however", "step"]
    )

    score = 0.0
    score += min(unique_ratio * 1.5, 0.4)  # up to 0.4 for vocabulary
    score += 0.3 if length_ok else 0.1  # 0.3 for reasonable length
    score += 0.2 if has_structure else 0.0  # 0.2 for structure
    score += 0.1 if len(sentences) >= 3 else 0.0  # 0.1 for multiple sentences

    return min(score, 1.0)


def score_keyword_match(text: str, keywords: list[str]) -> float:
    """Score keyword presence (0.0 = none found, 1.0 = all found)."""
    if not keywords:
        return 1.0

    found = sum(1 for kw in keywords if kw.lower() in text.lower())
    return found / len(keywords)


@dataclass
class QualityResult:
    category: str
    prompt: str
    response: str
    coherence: float
    repetition: float
    keyword_match: float
    response_length: int
    generation_time_s: float
    mode: str


@dataclass
class QualityReport:
    model_path: str
    mode: str
    timestamp: str
    results: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


def load_config(config_path: str) -> dict:
    with open(config_path) as f:
        return yaml.safe_load(f)


def load_model(model_path: str, config: dict):
    try:
        from llama_cpp import Llama
    except ImportError:
        print("ERROR: llama-cpp-python not installed.")
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

    if kv_cfg.get("cache_type_k"):
        kwargs["type_k"] = kv_cfg["cache_type_k"]
    if kv_cfg.get("cache_type_v"):
        kwargs["type_v"] = kv_cfg["cache_type_v"]
    if kv_cfg.get("flash_attention"):
        kwargs["flash_attn"] = True

    return Llama(**kwargs)


def evaluate_prompt(model, prompt_data: dict, mode: str, max_tokens: int = 512) -> QualityResult:
    """Run a single prompt and evaluate quality."""
    messages = [{"role": "user", "content": prompt_data["prompt"]}]

    t_start = time.perf_counter()
    response = model.create_chat_completion(
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.0,
    )
    t_end = time.perf_counter()

    text = response["choices"][0]["message"]["content"]

    return QualityResult(
        category=prompt_data["category"],
        prompt=prompt_data["prompt"],
        response=text,
        coherence=round(score_coherence(text), 3),
        repetition=round(score_repetition(text), 3),
        keyword_match=round(score_keyword_match(text, prompt_data.get("expected_keywords", [])), 3),
        response_length=len(text),
        generation_time_s=round(t_end - t_start, 3),
        mode=mode,
    )


def main():
    parser = argparse.ArgumentParser(description="Quality benchmark for Bonsai models")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--mode", required=True, choices=["baseline", "turboquant"])
    parser.add_argument("--output", default="results/quality.json")
    parser.add_argument("--max-tokens", type=int, default=512)
    args = parser.parse_args()

    config = load_config(args.config)
    model = load_model(args.model_path, config)

    report = QualityReport(
        model_path=args.model_path,
        mode=args.mode,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    print(f"\n{'='*60}")
    print(f"  Quality Benchmark — {args.mode}")
    print(f"{'='*60}")

    for i, prompt_data in enumerate(TEST_PROMPTS, 1):
        print(f"\n── [{i}/{len(TEST_PROMPTS)}] {prompt_data['category']} ──")
        print(f"  Prompt: {prompt_data['prompt'][:80]}...")

        result = evaluate_prompt(model, prompt_data, args.mode, args.max_tokens)
        report.results.append(asdict(result))

        print(f"  Coherence:  {result.coherence}")
        print(f"  Repetition: {result.repetition}")
        print(f"  Keywords:   {result.keyword_match}")
        print(f"  Length:     {result.response_length} chars")
        print(f"  Time:       {result.generation_time_s}s")

    # Summary
    coherences = [r["coherence"] for r in report.results]
    repetitions = [r["repetition"] for r in report.results]
    keywords = [r["keyword_match"] for r in report.results]

    report.summary = {
        "avg_coherence": round(sum(coherences) / len(coherences), 3),
        "avg_repetition": round(sum(repetitions) / len(repetitions), 3),
        "avg_keyword_match": round(sum(keywords) / len(keywords), 3),
        "total_prompts": len(TEST_PROMPTS),
    }

    # Save
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(asdict(report), f, indent=2)

    print(f"\n{'─'*60}")
    print(f"  Summary ({args.mode})")
    print(f"{'─'*60}")
    print(f"  Avg Coherence:     {report.summary['avg_coherence']}")
    print(f"  Avg Repetition:    {report.summary['avg_repetition']}")
    print(f"  Avg Keyword Match: {report.summary['avg_keyword_match']}")
    print(f"\n✅ Results saved to {output_path}")


if __name__ == "__main__":
    main()
