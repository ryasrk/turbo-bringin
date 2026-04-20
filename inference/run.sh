#!/usr/bin/env bash
# ── Tenrary-X Inference Launcher ────────────────────────────────
# Launch inference server in standard or turboquant mode
#
# Usage:
#   ./run.sh standard           # f16 KV cache (max quality)
#   ./run.sh turboquant         # q4_0 KV + FA (72% VRAM savings)
#   ./run.sh both               # Launch both on ports 8080/8081
#   ./run.sh stop               # Stop all running servers

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

export PATH="/usr/local/cuda-12.8/bin:$PATH"

ENGINE="engines/llama-cpp-prismml/build/bin/llama-server"
MODEL="models/Bonsai-8B-Q1_0.gguf"

# Verify engine exists
if [[ ! -f "$ENGINE" ]]; then
    echo "Error: Engine not found at $ENGINE"
    echo "Run the build script first."
    exit 1
fi

# Verify model exists
if [[ ! -f "$MODEL" ]]; then
    echo "Error: Model not found at $MODEL"
    exit 1
fi

start_standard() {
    local port="${1:-8080}"
    local ctx="${2:-8192}"
    shift 2 2>/dev/null || true
    echo "Starting STANDARD mode on port $port (f16 KV, ctx=$ctx)..."
    $ENGINE \
        -m "$MODEL" \
        -ngl 99 \
        -c "$ctx" \
        -np 1 \
        --host 0.0.0.0 \
        --port "$port" \
        --cache-type-k f16 \
        --cache-type-v f16 \
        -fa off \
        "$@"
}

start_turboquant() {
    local port="${1:-8081}"
    local ctx="${2:-16384}"
    shift 2 2>/dev/null || true
    echo "Starting TURBOQUANT mode on port $port (q4_0 KV + FA, ctx=$ctx)..."
    $ENGINE \
        -m "$MODEL" \
        -ngl 99 \
        -c "$ctx" \
        -np 1 \
        --host 0.0.0.0 \
        --port "$port" \
        --cache-type-k q4_0 \
        --cache-type-v q4_0 \
        -fa on \
        "$@"
}

stop_servers() {
    echo "Stopping all llama-server processes..."
    pkill -f "llama-server.*Bonsai" 2>/dev/null && echo "Stopped." || echo "No servers running."
}

show_status() {
    echo "═══ Server Status ═══"
    if pgrep -f "llama-server.*Bonsai" > /dev/null 2>&1; then
        pgrep -af "llama-server.*Bonsai"
    else
        echo "No servers running."
    fi
}

case "${1:-help}" in
    standard)
        shift
        start_standard "$@"
        ;;
    turboquant|turbo|tq)
        shift
        start_turboquant "$@"
        ;;
    both)
        echo "═══ Starting Both Inference Modes ═══"
        echo ""
        start_standard 8080 8192 &
        STD_PID=$!
        echo "Standard server starting (PID: $STD_PID, port: 8080)..."
        sleep 3
        start_turboquant 8081 16384 &
        TQ_PID=$!
        echo "TurboQuant server starting (PID: $TQ_PID, port: 8081)..."
        sleep 3
        echo ""
        echo "═══ Both servers launched ═══"
        echo "  Standard  → http://localhost:8080 (f16 KV, 8K ctx)"
        echo "  TurboQuant→ http://localhost:8081 (q4_0+FA, 16K ctx)"
        echo ""
        echo "Dashboard will auto-switch between them."
        echo "Use './run.sh stop' to kill both."
        echo ""
        # Wait for both processes
        wait $STD_PID $TQ_PID
        ;;
    stop)
        stop_servers
        # Also stop the manager if running
        pkill -f "node.*manager.js" 2>/dev/null && echo "Manager stopped." || true
        ;;
    status)
        show_status
        # Check manager status
        if pgrep -f "node.*manager.js" > /dev/null 2>&1; then
            echo ""
            echo "Manager running — checking mode:"
            curl -s http://localhost:3002/status 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  (manager unreachable)"
        fi
        ;;
    serve)
        # Single-model managed mode (RECOMMENDED)
        # Runs one llama-server, switches mode via dashboard
        echo "═══ Starting Inference Manager (single model) ═══"
        shift
        node "$SCRIPT_DIR/manager.js" "${1:-turboquant}"
        ;;
    help|--help|-h)
        echo "Tenrary-X Inference Server"
        echo ""
        echo "Usage: $0 <mode> [port] [ctx_size] [extra_args...]"
        echo ""
        echo "Modes:"
        echo "  serve        ⭐ RECOMMENDED: Single-model manager (dashboard switches mode)"
        echo "  standard     f16 KV cache, no FA (port 8080, ctx 8192)"
        echo "  turboquant   q4_0 KV + Flash Attention (port 8081, ctx 16384)"
        echo "  both         Start both servers (uses 2x VRAM)"
        echo "  stop         Kill all running servers"
        echo "  status       Show running servers"
        echo ""
        echo "Examples:"
        echo "  $0 standard                    # Standard on :8080"
        echo "  $0 turboquant 9000 32768       # TurboQuant on :9000 with 32K ctx"
        echo "  $0 both                        # Both modes in parallel"
        echo ""
        echo "API (OpenAI-compatible):"
        echo "  curl http://localhost:8080/v1/chat/completions \\"
        echo "    -H 'Content-Type: application/json' \\"
        echo "    -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'"
        ;;
    *)
        echo "Unknown mode: $1"
        echo "Use: standard, turboquant, both, stop, status"
        exit 1
        ;;
esac
