#!/usr/bin/env bash
# ── Run All Benchmarks ──────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

source env/bin/activate 2>/dev/null || true

echo "═══════════════════════════════════════════════════════════"
echo "  Tenrary-X: Full Benchmark Suite"
echo "═══════════════════════════════════════════════════════════"
echo ""

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="results/run_${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"

MODEL_PATH="${MODEL_PATH:-$(find models/ -name '*.gguf' -type f | head -1)}"

if [[ -z "$MODEL_PATH" || ! -f "$MODEL_PATH" ]]; then
    echo "ERROR: No GGUF model found in models/"
    exit 1
fi

echo "Model:   $MODEL_PATH"
echo "Output:  $RESULTS_DIR/"
echo ""

# ── Step 1: Baseline Speed ──────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [1/5] Baseline Speed Benchmark"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
python3 benchmarks/bench_speed.py \
    --model-path "$MODEL_PATH" \
    --config config/baseline.yaml \
    --mode baseline \
    --output "$RESULTS_DIR/baseline_speed.json"

# ── Step 2: TurboQuant Speed ────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [2/5] TurboQuant Speed Benchmark"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
python3 benchmarks/bench_speed.py \
    --model-path "$MODEL_PATH" \
    --config config/turboquant.yaml \
    --mode turboquant \
    --output "$RESULTS_DIR/turboquant_speed.json"

# ── Step 3: Quality ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [3/5] Quality Benchmark (baseline vs TQ)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
python3 benchmarks/bench_quality.py \
    --model-path "$MODEL_PATH" \
    --config config/baseline.yaml \
    --mode baseline \
    --output "$RESULTS_DIR/baseline_quality.json"

python3 benchmarks/bench_quality.py \
    --model-path "$MODEL_PATH" \
    --config config/turboquant.yaml \
    --mode turboquant \
    --output "$RESULTS_DIR/turboquant_quality.json"

# ── Step 4: KV Scaling ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [4/5] KV Cache Scaling Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
python3 benchmarks/bench_kv_scaling.py \
    --model-path "$MODEL_PATH" \
    --config config/turboquant.yaml \
    --output "$RESULTS_DIR/kv_scaling.json"

# ── Step 5: Generate comparison report ──────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  [5/5] Generating Comparison Report"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
python3 benchmarks/generate_report.py \
    --results-dir "$RESULTS_DIR" \
    --output "$RESULTS_DIR/REPORT.md"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ All benchmarks complete!"
echo "  📊 Report: $RESULTS_DIR/REPORT.md"
echo "═══════════════════════════════════════════════════════════"
