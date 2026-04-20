"""Tenrary-X Inference Server

Production inference with two modes:
- standard: f16 KV cache (max quality)
- turboquant: q4_0 KV + Flash Attention (72% VRAM savings, same accuracy)

Uses llama-server (OpenAI-compatible API) under the hood.
"""

import subprocess
import signal
import sys
import os
import time
import argparse
import json
from pathlib import Path
from config import InferenceMode, ModelConfig, ServerConfig, get_mode_config


def build_server_command(
    mode: InferenceMode,
    model_cfg: ModelConfig,
    server_cfg: ServerConfig,
) -> list[str]:
    """Build the llama-server command for the given mode."""
    mode_cfg = get_mode_config(mode)

    project_dir = Path(__file__).parent.parent
    engine = str(project_dir / model_cfg.engine_path)
    model = str(project_dir / model_cfg.model_path)

    cmd = [
        engine,
        "-m", model,
        "-ngl", str(model_cfg.n_gpu_layers),
        "-c", str(model_cfg.ctx_size),
        "-np", str(model_cfg.parallel_slots),
        "--host", server_cfg.host,
        "--port", str(mode_cfg.port),
        "--cache-type-k", mode_cfg.cache_type_k,
        "--cache-type-v", mode_cfg.cache_type_v,
        "-fa", mode_cfg.flash_attn,
    ]

    if server_cfg.api_key:
        cmd.extend(["--api-key", server_cfg.api_key])

    return cmd


def start_server(mode: InferenceMode, model_cfg: ModelConfig, server_cfg: ServerConfig):
    """Start llama-server in the given mode."""
    mode_cfg = get_mode_config(mode)
    cmd = build_server_command(mode, model_cfg, server_cfg)

    print(f"╔══════════════════════════════════════════════════╗")
    print(f"║  Tenrary-X Inference Server                      ║")
    print(f"║  Mode: {mode.value:<42} ║")
    print(f"║  {mode_cfg.description:<48} ║")
    print(f"║  Port: {mode_cfg.port:<42} ║")
    print(f"║  Context: {model_cfg.ctx_size:<39} ║")
    print(f"║  KV Cache: {mode_cfg.cache_type_k}/{mode_cfg.cache_type_v:<36} ║")
    print(f"╚══════════════════════════════════════════════════╝")
    print()
    print(f"Command: {' '.join(cmd)}")
    print()

    process = subprocess.Popen(cmd)

    def handle_signal(signum, frame):
        print(f"\nShutting down {mode.value} server...")
        process.terminate()
        process.wait(timeout=10)
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    process.wait()
    return process.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Tenrary-X Inference Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python server.py standard              # Start with f16 KV cache
  python server.py turboquant            # Start with q4_0 KV + FA (72% VRAM savings)
  python server.py turboquant -c 32768   # TurboQuant with 32K context
  python server.py standard --port 9000  # Custom port
        """,
    )
    parser.add_argument(
        "mode",
        type=str,
        choices=["standard", "turboquant"],
        help="Inference mode: 'standard' (f16 KV) or 'turboquant' (q4_0 KV + FA)",
    )
    parser.add_argument("-c", "--ctx-size", type=int, default=8192, help="Context size (default: 8192)")
    parser.add_argument("--port", type=int, default=None, help="Override port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind (default: 0.0.0.0)")
    parser.add_argument("--api-key", type=str, default="", help="API key for authentication")
    parser.add_argument("--parallel", type=int, default=1, help="Number of parallel slots")
    parser.add_argument("--model", type=str, default=None, help="Override model path")

    args = parser.parse_args()

    mode = InferenceMode(args.mode)
    model_cfg = ModelConfig(ctx_size=args.ctx_size, parallel_slots=args.parallel)
    if args.model:
        model_cfg.model_path = args.model

    server_cfg = ServerConfig(host=args.host, api_key=args.api_key)

    # Override port if specified
    mode_cfg = get_mode_config(mode)
    if args.port:
        mode_cfg.port = args.port

    sys.exit(start_server(mode, model_cfg, server_cfg))


if __name__ == "__main__":
    main()
