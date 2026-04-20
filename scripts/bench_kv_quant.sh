#!/usr/bin/env bash
# ── KV Cache Quantization Benchmark ────────────────────────────────
# Compare baseline (f16 KV) vs quantized KV cache configurations
# Uses llama.cpp native --cache-type-k and --cache-type-v flags
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

CUDA_PATH="${CUDA_HOME:-$(ls -d /usr/local/cuda*/bin 2>/dev/null | sort -V | tail -1)}"
if [[ -n "$CUDA_PATH" ]]; then
    export PATH="$CUDA_PATH:$PATH"
fi

ENGINE="engines/llama-cpp-prismml/build/bin/llama-cli"
MODEL="${MODEL_PATH:-$(find models/ -name '*.gguf' -print -quit 2>/dev/null)}"
if [[ -z "$MODEL" ]]; then
    echo "ERROR: No .gguf model found in models/" >&2
    exit 1
fi
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="results/kv_quant_${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"

# Test prompt (same reasoning test for fair comparison)
PROMPT="A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Explain step by step."

# KV cache configurations to test
declare -a KV_CONFIGS=(
    "f16:f16:baseline"
    "q8_0:q8_0:tq_quality"
    "q8_0:q4_0:tq_mixed"
    "q4_0:q4_0:tq_aggressive"
)

# Context lengths to test
declare -a CTX_SIZES=(2048 4096 8192 16384)

echo "═══════════════════════════════════════════════════════════"
echo "  Tenrary-X: KV Cache Quantization Benchmark"
echo "  Model: $MODEL"
echo "  Time:  $(date)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Configurations:"
echo "  1. f16/f16    — Baseline (no KV compression)"
echo "  2. q8_0/q8_0  — Quality (8-bit KV)"
echo "  3. q8_0/q4_0  — Mixed (8-bit K, 4-bit V)"
echo "  4. q4_0/q4_0  — Aggressive (4-bit KV)"
echo ""
echo "Context lengths: ${CTX_SIZES[*]}"
echo ""

# Summary file
SUMMARY="$RESULTS_DIR/summary.md"
cat > "$SUMMARY" << 'EOF'
# KV Cache Quantization Results

| Config | Context | KV Cache (MB) | Total VRAM (MB) | Prompt (t/s) | Gen (t/s) | Quality |
|--------|---------|---------------|-----------------|-------------|-----------|---------|
EOF

run_test() {
    local cache_k="$1"
    local cache_v="$2"
    local config_name="$3"
    local ctx="$4"
    local outfile="$RESULTS_DIR/${config_name}_ctx${ctx}.txt"

    echo "── $config_name | ctx=$ctx | cache_k=$cache_k cache_v=$cache_v ──"

    # Run inference
    $ENGINE \
        -m "$MODEL" \
        -p "$PROMPT" \
        -n 256 \
        -ngl 99 \
        -c "$ctx" \
        --temp 0.5 \
        --top-p 0.85 \
        --top-k 20 \
        --cache-type-k "$cache_k" \
        --cache-type-v "$cache_v" \
        --single-turn \
        --no-display-prompt \
        -rea off \
        2>&1 | tee "$outfile"

    echo ""

    # Extract metrics from output
    local prompt_speed=$(grep -oP 'Prompt: \K[0-9.]+' "$outfile" | tail -1)
    local gen_speed=$(grep -oP 'Generation: \K[0-9.]+' "$outfile" | tail -1)
    local kv_mb=$(grep -oP 'context\s+\K[0-9]+' "$outfile" | tail -1)
    local total_mb=$(grep -oP 'self\s+\K[0-9]+' "$outfile" | tail -1)

    # Check answer quality (should mention "9")
    local quality="?"
    if grep -q "9 sheep" "$outfile" || grep -q "9 sheep left" "$outfile"; then
        quality="✅"
    elif grep -q "9" "$outfile"; then
        quality="⚠️"
    else
        quality="❌"
    fi

    echo "| $config_name | $ctx | ${kv_mb:-?} | ${total_mb:-?} | ${prompt_speed:-?} | ${gen_speed:-?} | $quality |" >> "$SUMMARY"
    echo "  → Prompt: ${prompt_speed:-?} t/s | Gen: ${gen_speed:-?} t/s | KV: ${kv_mb:-?} MB | Quality: $quality"
    echo ""
}

# Run all combinations
for kv_config in "${KV_CONFIGS[@]}"; do
    IFS=':' read -r cache_k cache_v config_name <<< "$kv_config"
    for ctx in "${CTX_SIZES[@]}"; do
        run_test "$cache_k" "$cache_v" "$config_name" "$ctx"
    done
    echo ""
done

echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Results saved to $RESULTS_DIR/"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "── Summary ──"
cat "$SUMMARY"
