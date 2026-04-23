#!/usr/bin/env bash
# ── Tenrary-X: Run Dashboard + Inference Manager ───────────────
# Starts the inference manager (single model) and the Vite dashboard.
#
# Usage:
#   ./run_all.sh                  # Start both (default: turboquant mode)
#   ./run_all.sh standard         # Start both with standard mode
#   ./run_all.sh stop             # Stop everything
#
# Environment:
#   INFERENCE_PORT=18080          # Override inference server port

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f ".env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source ".env"
    set +a
fi

MODE="${1:-turboquant}"
INFERENCE_PORT="${INFERENCE_PORT:-18080}"
export INFERENCE_PORT

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

stop_all() {
    echo -e "${YELLOW}Stopping all services...${NC}"
    pkill -f "bun.*inference/manager\.js" 2>/dev/null && echo "  Manager stopped." || true
    pkill -f "node.*inference/manager\.js" 2>/dev/null || true
    pkill -f "llama-server.*Bonsai" 2>/dev/null && echo "  Inference server stopped." || true
    pkill -f "vite.*--port 3000" 2>/dev/null || true
    # Kill dashboard by port if vite pattern doesn't match
    lsof -ti:3000 2>/dev/null | xargs kill 2>/dev/null || true
    echo -e "${GREEN}All services stopped.${NC}"
}

case "$MODE" in
    stop)
        stop_all
        exit 0
        ;;
    status)
        echo "═══ Tenrary-X Status ═══"
        echo ""
        if pgrep -f "(bun|node).*manager.js" > /dev/null 2>&1; then
            echo -e "  Manager:   ${GREEN}running${NC}"
            python3 -c "import urllib.request,json; r=urllib.request.urlopen('http://localhost:3002/status'); d=json.loads(r.read()); print(f'  Mode:      {d[\"mode\"]} ({d[\"label\"]})')" 2>/dev/null || true
        else
            echo -e "  Manager:   ${RED}stopped${NC}"
        fi
        if pgrep -f "vite" > /dev/null 2>&1; then
            echo -e "  Dashboard: ${GREEN}running${NC} → http://localhost:3000"
        else
            echo -e "  Dashboard: ${RED}stopped${NC}"
        fi
        exit 0
        ;;
    standard|turboquant)
        # valid mode, continue
        ;;
    *)
        echo "Usage: $0 [standard|turboquant|stop|status]"
        exit 1
        ;;
esac

# ── Pre-flight checks ──────────────────────────────────────────
if [[ ! -f "inference/manager.js" ]]; then
    echo -e "${RED}Error: inference/manager.js not found${NC}"
    exit 1
fi

if [[ ! -f "dashboard/package.json" ]]; then
    echo -e "${RED}Error: dashboard/package.json not found${NC}"
    exit 1
fi

# Check node_modules
if [[ ! -d "dashboard/node_modules" ]]; then
    echo -e "${YELLOW}Installing dashboard dependencies...${NC}"
    (cd dashboard && npm install)
fi

# ── Stop existing services ─────────────────────────────────────
pkill -f "bun.*inference/manager\.js" 2>/dev/null || true
pkill -f "node.*inference/manager\.js" 2>/dev/null || true
pkill -f "llama-server.*Bonsai" 2>/dev/null || true
lsof -ti:3000 2>/dev/null | xargs kill 2>/dev/null || true
lsof -ti:"$INFERENCE_PORT" 2>/dev/null | xargs kill 2>/dev/null || true

# Wait for ports to free
sleep 1

# Verify inference port is free
if lsof -ti:"$INFERENCE_PORT" >/dev/null 2>&1 || ss -tlnp | grep -q ":${INFERENCE_PORT} " 2>/dev/null; then
    echo -e "${RED}Error: Port ${INFERENCE_PORT} is still in use. Cannot start inference server.${NC}"
    echo "  Check with: ss -tlnp | grep ${INFERENCE_PORT}"
    exit 1
fi

# ── Start Inference Manager ────────────────────────────────────
echo -e "${CYAN}═══ Tenrary-X ═══${NC}"
echo ""
echo -e "Starting inference manager (${GREEN}${MODE}${NC} mode)..."
bun inference/manager.js "$MODE" &
MANAGER_PID=$!

# Wait for manager to be ready (max 30s)
echo -n "  Waiting for inference server"
for i in $(seq 1 30); do
    if python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:${INFERENCE_PORT}/health')" 2>/dev/null; then
        echo -e " ${GREEN}ready!${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

if ! kill -0 $MANAGER_PID 2>/dev/null; then
    echo -e " ${RED}FAILED${NC}"
    echo "Manager process died. Check logs above."
    exit 1
fi

# ── Start Dashboard ────────────────────────────────────────────
echo ""
echo "Starting dashboard..."
(cd dashboard && npx vite --port 3000 --host) &
DASHBOARD_PID=$!

# Wait for dashboard
sleep 2

echo ""
echo -e "${GREEN}═══ All services running ═══${NC}"
echo ""
echo -e "  Dashboard:  ${CYAN}http://localhost:3000${NC}"
echo -e "  Inference:  http://localhost:${INFERENCE_PORT}"
echo -e "  Manager:    http://localhost:3002"
echo -e "  Mode:       ${GREEN}${MODE}${NC}"
echo ""
echo -e "  Switch mode from dashboard dropdown or:"
echo -e "    curl -X POST 'http://localhost:3002/switch?mode=standard'"
echo -e "    curl -X POST 'http://localhost:3002/switch?mode=turboquant'"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop all services."
echo ""

# ── Trap Ctrl+C to clean shutdown ─────────────────────────────
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    kill $DASHBOARD_PID 2>/dev/null
    kill $MANAGER_PID 2>/dev/null
    wait $DASHBOARD_PID 2>/dev/null
    wait $MANAGER_PID 2>/dev/null
    echo -e "${GREEN}Done.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait -n $MANAGER_PID $DASHBOARD_PID 2>/dev/null
echo -e "${RED}A service exited unexpectedly. Stopping all...${NC}"
cleanup