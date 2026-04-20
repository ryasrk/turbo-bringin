#!/usr/bin/env bash
# ── Run TurboQuant Inference ────────────────────────────────────────
# llama.cpp inference with TurboQuant KV cache compression
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

source env/bin/activate 2>/dev/null || true

echo "═══════════════════════════════════════════════════════════"
echo "  Tenrary-X: TurboQuant Inference"
echo "═══════════════════════════════════════════════════════════"

# ── Find model ──────────────────────────────────────────────────────
MODEL_PATH="${MODEL_PATH:-$(find models/ -name '*.gguf' -type f | head -1)}"

if [[ -z "$MODEL_PATH" || ! -f "$MODEL_PATH" ]]; then
    echo "ERROR: No GGUF model found in models/"
    echo "Run: ./scripts/download_model.sh"
    exit 1
fi

echo "Model: $MODEL_PATH"
echo "Mode:  turboquant (KV cache compression)"
echo ""

# ── Run benchmark ───────────────────────────────────────────────────
python3 benchmarks/bench_speed.py \
    --model-path "$MODEL_PATH" \
    --config config/turboquant.yaml \
    --mode turboquant \
    --output results/turboquant_speed.json

echo ""
echo "── Quality evaluation ──"
python3 benchmarks/bench_quality.py \
    --model-path "$MODEL_PATH" \
    --config config/turboquant.yaml \
    --mode turboquant \
    --output results/turboquant_quality.json

echo ""
echo "── KV Scaling test ──"
python3 benchmarks/bench_kv_scaling.py \
    --model-path "$MODEL_PATH" \
    --config config/turboquant.yaml \
    --output results/kv_scaling.json

echo ""
echo "✅ TurboQuant results saved to results/"
