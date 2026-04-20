#!/usr/bin/env bash
# ── Run Baseline Inference ──────────────────────────────────────────
# PrismML llama.cpp (Q1_0 kernels) — standard KV cache, no compression
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

source env/bin/activate 2>/dev/null || true

echo "═══════════════════════════════════════════════════════════"
echo "  Tenrary-X: Baseline Inference"
echo "═══════════════════════════════════════════════════════════"

# ── Find model ──────────────────────────────────────────────────────
MODEL_PATH="${MODEL_PATH:-$(find models/ -name '*.gguf' -type f | head -1)}"

if [[ -z "$MODEL_PATH" || ! -f "$MODEL_PATH" ]]; then
    echo "ERROR: No GGUF model found in models/"
    echo "Run: ./scripts/download_model.sh"
    exit 1
fi

# ── Find llama-cli ──────────────────────────────────────────────────
LLAMA_CLI="engines/llama-cpp-prismml/build/bin/llama-cli"
LLAMA_SERVER="engines/llama-cpp-prismml/build/bin/llama-server"

if [[ ! -x "$LLAMA_CLI" ]]; then
    echo "ERROR: llama-cli not found at $LLAMA_CLI"
    echo "Run: ./setup.sh"
    exit 1
fi

echo "Model:  $MODEL_PATH"
echo "Engine: $LLAMA_CLI"
echo "Mode:   baseline (standard KV cache)"
echo ""

# ── Quick smoke test ────────────────────────────────────────────────
echo "── Smoke test ──"
$LLAMA_CLI \
    -m "$MODEL_PATH" \
    -p "Hello, what is 2+2?" \
    -n 32 \
    --temp 0.5 \
    --top-p 0.85 \
    --top-k 20 \
    -ngl 99 \
    2>&1 | tail -5

echo ""
echo "── Running speed benchmark ──"
python3 benchmarks/bench_speed.py \
    --model-path "$MODEL_PATH" \
    --config config/baseline.yaml \
    --mode baseline \
    --output results/baseline_speed.json

echo ""
echo "── Running quality evaluation ──"
python3 benchmarks/bench_quality.py \
    --model-path "$MODEL_PATH" \
    --config config/baseline.yaml \
    --mode baseline \
    --output results/baseline_quality.json

echo ""
echo "✅ Baseline results saved to results/"
