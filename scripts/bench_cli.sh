#!/usr/bin/env bash
# ── Quick CLI Benchmark ─────────────────────────────────────────────
# Direct llama-cli benchmarks — no Python dependencies needed
# Uses PrismML's llama.cpp with Q1_0 kernels
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

LLAMA_CLI="engines/llama-cpp-prismml/build/bin/llama-cli"
MODEL_PATH="${MODEL_PATH:-$(find models/ -name '*.gguf' -type f | head -1)}"

if [[ ! -x "$LLAMA_CLI" ]]; then
    echo "ERROR: llama-cli not found. Run ./setup.sh first."
    exit 1
fi

if [[ -z "$MODEL_PATH" || ! -f "$MODEL_PATH" ]]; then
    echo "ERROR: No GGUF model found. Run ./scripts/download_model.sh first."
    exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_FILE="results/cli_bench_${TIMESTAMP}.txt"
mkdir -p results

echo "═══════════════════════════════════════════════════════════" | tee "$RESULTS_FILE"
echo "  Tenrary-X: CLI Benchmark" | tee -a "$RESULTS_FILE"
echo "  Model: $MODEL_PATH" | tee -a "$RESULTS_FILE"
echo "  Time:  $(date)" | tee -a "$RESULTS_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$RESULTS_FILE"

# ── GPU info ────────────────────────────────────────────────────────
echo "" | tee -a "$RESULTS_FILE"
echo "── GPU Info ──" | tee -a "$RESULTS_FILE"
nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free \
    --format=csv,noheader 2>/dev/null | tee -a "$RESULTS_FILE" || echo "No GPU detected"

# ── Test 1: Reasoning ──────────────────────────────────────────────
echo "" | tee -a "$RESULTS_FILE"
echo "── Test 1: Reasoning (ctx=2048) ──" | tee -a "$RESULTS_FILE"
$LLAMA_CLI \
    -m "$MODEL_PATH" \
    -p "A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain step by step." \
    -n 256 \
    --temp 0.5 --top-p 0.85 --top-k 20 \
    -ngl 99 -c 2048 \
    --no-display-prompt \
    --single-turn \
    2>&1 | tee -a "$RESULTS_FILE"

# ── Test 2: Coding ─────────────────────────────────────────────────
echo "" | tee -a "$RESULTS_FILE"
echo "── Test 2: Coding (ctx=4096) ──" | tee -a "$RESULTS_FILE"
$LLAMA_CLI \
    -m "$MODEL_PATH" \
    -p "Write a Python function for binary search on a sorted list. Include type hints and error handling." \
    -n 512 \
    --temp 0.5 --top-p 0.85 --top-k 20 \
    -ngl 99 -c 4096 \
    --no-display-prompt \
    --single-turn \
    2>&1 | tee -a "$RESULTS_FILE"

# ── Test 3: Long context ──────────────────────────────────────────
echo "" | tee -a "$RESULTS_FILE"
echo "── Test 3: Knowledge (ctx=8192) ──" | tee -a "$RESULTS_FILE"
$LLAMA_CLI \
    -m "$MODEL_PATH" \
    -p "Explain the theory of relativity in detail, covering both special and general relativity. Include the key equations and their physical interpretations. Then explain how GPS satellites need to account for relativistic effects." \
    -n 512 \
    --temp 0.5 --top-p 0.85 --top-k 20 \
    -ngl 99 -c 8192 \
    --no-display-prompt \
    --single-turn \
    2>&1 | tee -a "$RESULTS_FILE"

echo "" | tee -a "$RESULTS_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$RESULTS_FILE"
echo "  ✅ Results saved to $RESULTS_FILE" | tee -a "$RESULTS_FILE"
echo "═══════════════════════════════════════════════════════════" | tee -a "$RESULTS_FILE"

# ── Extract timing from llama.cpp output ───────────────────────────
echo ""
echo "── Timing Summary ──"
grep -E "total time|eval time|load time|sample time" "$RESULTS_FILE" || echo "  (parse timing from output above)"
