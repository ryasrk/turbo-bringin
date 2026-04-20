#!/usr/bin/env bash
# ── Accuracy Benchmark ──────────────────────────────────────────────
# Tests model accuracy across KV configurations with diverse prompts
# Evaluates: math, logic, factual, coding, instruction following
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
RESULTS_DIR="results/accuracy_${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "  Tenrary-X: Accuracy Benchmark"
echo "  Model: $MODEL"
echo "  Time:  $(date)"
echo "═══════════════════════════════════════════════════════════"

# ── Test prompts with expected answers ──
declare -a PROMPTS=(
    "What is 15 * 17? Give only the number."
    "If a train travels at 60 km/h for 2.5 hours, how far does it travel? Answer in km only."
    "What is the capital of Indonesia?"
    "Sort these numbers in ascending order: 42, 7, 19, 3, 88, 15. Give only the sorted list."
    "Write a Python one-liner that reverses a string s."
    "What comes next in the pattern: 2, 6, 18, 54, ?"
    "Is the statement 'All mammals lay eggs' true or false?"
    "What is the chemical formula for water?"
    "If today is Wednesday, what day will it be in 10 days?"
    "Convert 100 Fahrenheit to Celsius. Give only the number rounded to 1 decimal."
)

declare -a EXPECTED=(
    "255"
    "150"
    "Jakarta"
    "3, 7, 15, 19, 42, 88"
    "s[::-1]"
    "162"
    "false"
    "H₂O"
    "Saturday"
    "37.8"
)

declare -a CATEGORIES=(
    "math"
    "math"
    "factual"
    "logic"
    "coding"
    "pattern"
    "logic"
    "factual"
    "reasoning"
    "math"
)

# KV configs to test
declare -a CONFIGS=(
    "f16:f16:off:baseline"
    "q8_0:q8_0:off:q8_quality"
    "q4_0:q4_0:on:q4_aggressive"
)

run_prompt() {
    local cache_k="$1"
    local cache_v="$2"
    local fa="$3"
    local prompt="$4"
    local outfile="$5"

    local cmd=("$ENGINE"
        -m "$MODEL"
        -p "$prompt"
        -n 128
        -ngl 99
        -c 2048
        --temp 0.1
        --top-p 0.9
        --top-k 10
        --cache-type-k "$cache_k"
        --cache-type-v "$cache_v"
        --single-turn
        --no-display-prompt
        -rea off
    )

    if [[ "$fa" == "on" ]]; then
        cmd+=(-fa on)
    fi

    # Use script to capture tty output (llama-cli conversation mode writes to tty directly)
    script -q -c "$(printf '%q ' "${cmd[@]}")" "$outfile" > /dev/null 2>&1 || true
}

echo ""

for config_entry in "${CONFIGS[@]}"; do
    IFS=':' read -r cache_k cache_v fa config_name <<< "$config_entry"
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Config: $config_name (cache_k=$cache_k, cache_v=$cache_v, FA=$fa)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    correct=0
    total=${#PROMPTS[@]}
    config_dir="$RESULTS_DIR/$config_name"
    mkdir -p "$config_dir"
    
    for i in "${!PROMPTS[@]}"; do
        prompt="${PROMPTS[$i]}"
        expected="${EXPECTED[$i]}"
        category="${CATEGORIES[$i]}"
        outfile="$config_dir/test_${i}_${category}.txt"
        
        echo -n "  [$category] Q: ${prompt:0:50}... "
        
        run_prompt "$cache_k" "$cache_v" "$fa" "$prompt" "$outfile"
        
        # Check if expected answer appears anywhere in the output file (fixed-string search)
        if grep -qiF "$expected" "$outfile" 2>/dev/null; then
            echo "✅ (found '$expected')"
            correct=$((correct + 1))
        else
            # Show a few lines from the response for debugging
            snippet=$(grep -a "^\S" "$outfile" 2>/dev/null | grep -v "^ggml\|^Loading\|^build\|^model\|^modal\|^avail\|^Exiting\|^llama_\|^Script" | head -3 | tr '\n' ' ')
            echo "❌ Expected '$expected' | Snippet: ${snippet:0:80}"
        fi
        
        # Save metadata
        echo "---" >> "$outfile"
        echo "Expected: $expected" >> "$outfile"
        echo "Category: $category" >> "$outfile"
    done
    
    accuracy=$((correct * 100 / total))
    echo ""
    echo "  Score: $correct/$total ($accuracy%)"
    echo "  $config_name: $correct/$total ($accuracy%)" >> "$RESULTS_DIR/summary.txt"
    echo ""
done

echo "═══════════════════════════════════════════════════════════"
echo "  Results saved to $RESULTS_DIR/"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "── Final Summary ──"
cat "$RESULTS_DIR/summary.txt"
