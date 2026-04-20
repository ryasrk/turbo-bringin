#!/usr/bin/env bash
# ── Tenrary-X: Environment & llama.cpp setup ─────────────────────────
# Builds PrismML's llama.cpp fork (Q1_0 kernels) for Bonsai inference
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "  Tenrary-X: Setup"
echo "═══════════════════════════════════════════════════════════"

# ── 1. Python venv (reuse TurboQuant-X cached env) ──────────────────
CACHED_ENV="$(cd "$SCRIPT_DIR/../llm-turboquant/turboquant-x" 2>/dev/null && pwd)/env" || CACHED_ENV=""

if [[ -n "$CACHED_ENV" && -d "$CACHED_ENV" && ! -d "env" ]]; then
    echo "[1/5] Linking to cached Python environment..."
    ln -sf "$CACHED_ENV" env
    echo "  → Symlinked env → $CACHED_ENV"
    echo "  → Has: PyTorch 2.11+CUDA, numpy, scipy, psutil, pyyaml, fastapi"
elif [[ ! -d "env" ]]; then
    echo "[1/5] Creating Python virtual environment..."
    python3 -m venv env
else
    echo "[1/5] Virtual environment already exists."
fi

source env/bin/activate

# ── 2. Install missing deps (tabulate, llama-cpp-python) ───────────
echo "[2/5] Installing missing Python dependencies..."
pip install --upgrade pip 2>/dev/null
pip install "tabulate>=0.9,<1.0" 2>/dev/null || echo "  tabulate install skipped"

# ── 3. Build PrismML llama.cpp fork (Q1_0 CUDA kernels) ────────────
echo "[3/5] Building PrismML llama.cpp (baseline + Q1_0 support)..."
LLAMA_DIR="$SCRIPT_DIR/engines/llama-cpp-prismml"

if [[ ! -d "$LLAMA_DIR" ]]; then
    mkdir -p engines
    git clone https://github.com/PrismML-Eng/llama.cpp "$LLAMA_DIR"
fi

cd "$LLAMA_DIR"
git pull --ff-only 2>/dev/null || true

# Find CUDA compiler
NVCC_PATH=$(find /usr/local/cuda* -name "nvcc" 2>/dev/null | head -1)
if [[ -n "$NVCC_PATH" ]]; then
    export CUDACXX="$NVCC_PATH"
    export PATH="$(dirname "$NVCC_PATH"):$PATH"
    echo "  CUDA compiler: $NVCC_PATH"
fi

cmake -B build -DGGML_CUDA=ON
cmake --build build -j$(nproc)
cd "$SCRIPT_DIR"

echo "  ✓ llama-cli:    $LLAMA_DIR/build/bin/llama-cli"
echo "  ✓ llama-server: $LLAMA_DIR/build/bin/llama-server"

# ── 4. Build TurboQuant-X engine (KV compression) ──────────────────
echo "[4/5] Setting up TurboQuant-X engine..."
TQ_DIR="$SCRIPT_DIR/../llm-turboquant/turboquant-x"

if [[ -d "$TQ_DIR" ]]; then
    echo "  Found TurboQuant-X at: $TQ_DIR"
    # Install TQ as editable package so benchmarks can import it
    pip install -e "$TQ_DIR" 2>/dev/null || echo "  (TQ deps optional — skipping pip install)"

    # Build C++ extension if cmake/pybind11 available
    if command -v cmake &>/dev/null; then
        cd "$TQ_DIR"
        if [[ -f "CMakeLists.txt" ]]; then
            echo "  Building TurboQuant C++ extension..."
            cmake -B build_tq && cmake --build build_tq -j$(nproc) 2>/dev/null || echo "  (C++ build optional)"
        fi
        cd "$SCRIPT_DIR"
    fi
else
    echo "  ⚠ TurboQuant-X not found at $TQ_DIR"
    echo "    TQ experiments will use llama.cpp native KV quant only"
fi

# ── 5. Directory structure ──────────────────────────────────────────
echo "[5/5] Creating directories..."
mkdir -p models results config scripts benchmarks/prompts docs engines

echo ""
echo "✅ Setup complete!"
echo ""
echo "Engines:"
echo "  Baseline:   engines/llama-cpp-prismml/build/bin/llama-cli"
echo "  TQ Server:  TurboQuant-X (via Python import)"
echo ""
echo "Next steps:"
echo "  1. Download Bonsai model:  ./scripts/download_model.sh"
echo "  2. Run baseline:           ./scripts/run_baseline.sh"
echo ""
