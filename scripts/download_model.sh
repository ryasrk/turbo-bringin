#!/usr/bin/env bash
# ── Download Bonsai GGUF model ──────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MODEL_DIR="$PROJECT_DIR/models"

mkdir -p "$MODEL_DIR"

echo "═══════════════════════════════════════════════════════════"
echo "  Bonsai Model Download"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Model: Bonsai-8B Q1_0 (prism-ml)"
echo "  → 1.16 GB, true 1-bit weights"
echo "  → Architecture: Qwen3-8B (36 layers, 32q/8kv heads)"
echo "  → Context: up to 65,536 tokens"
echo "  → Source: https://huggingface.co/prism-ml/Bonsai-8B-gguf"
echo ""

# Bonsai-8B Q1_0 from HuggingFace (prism-ml)
DEFAULT_MODEL_URL="https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B-Q1_0.gguf"
DEFAULT_MODEL_NAME="Bonsai-8B-Q1_0.gguf"

MODEL_URL="$DEFAULT_MODEL_URL"
MODEL_NAME="$DEFAULT_MODEL_NAME"

MODEL_PATH="$MODEL_DIR/$MODEL_NAME"

if [[ -f "$MODEL_PATH" ]]; then
    echo "Model already exists: $MODEL_PATH"
    echo "Skipping download."
    exit 0
fi

echo ""
echo "Downloading: $MODEL_URL"
echo "Saving to:   $MODEL_PATH"
echo ""

if command -v wget &>/dev/null; then
    wget -O "$MODEL_PATH" "$MODEL_URL"
elif command -v curl &>/dev/null; then
    curl -L -o "$MODEL_PATH" "$MODEL_URL"
else
    echo "ERROR: Neither wget nor curl found. Install one and retry."
    exit 1
fi

echo ""
echo "✅ Model downloaded: $MODEL_PATH"
echo "   Size: $(du -h "$MODEL_PATH" | cut -f1)"
