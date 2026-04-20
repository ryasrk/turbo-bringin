# Tenrary-X Inference

Production inference service for Bonsai-8B with two modes:

## Modes

| Mode | KV Cache | Flash Attn | VRAM Savings | Port | Best For |
|------|----------|------------|--------------|------|----------|
| **standard** | f16/f16 | off | — | 8080 | Quality-critical tasks |
| **turboquant** | q4_0/q4_0 | on | **72%** | 8081 | Long context, multi-user |

Both modes provide identical accuracy (verified: 90% on 10-prompt benchmark).
TurboQuant saves 72% KV cache VRAM with only ~8% speed reduction.

## Quick Start

```bash
# Start standard mode
./run.sh standard

# Start turboquant mode (recommended for production)
./run.sh turboquant

# Start both
./run.sh both
```

## API (OpenAI-Compatible)

The server exposes an OpenAI-compatible API at `/v1/chat/completions`:

```bash
# Standard mode
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}], "max_tokens": 256}'

# TurboQuant mode  
curl http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}], "max_tokens": 256}'
```

## Python Client

```bash
# Chat
python client.py chat "What is 15 * 17?" --mode standard
python client.py chat "Explain quantum computing" --mode turboquant

# Health check
python client.py health --mode turboquant

# Benchmark
python client.py bench --mode turboquant
```

## Configuration

### Standard Mode
- Context: 8192 tokens (default)
- KV Cache: ~288 MB at 2K, ~1152 MB at 8K
- Speed: ~92 t/s generation

### TurboQuant Mode
- Context: 16384 tokens (default, higher because VRAM savings allow it)
- KV Cache: ~81 MB at 2K, ~648 MB at 16K
- Speed: ~85 t/s generation
- Max achievable context on RTX 4060: ~142K tokens

## Architecture

```
[Client] → HTTP → [llama-server (OpenAI API)] → [Bonsai-8B + CUDA]
                         ↓
                   KV Cache Config
                   (f16 or q4_0+FA)
```

The inference service wraps PrismML's llama-server with pre-configured optimal settings derived from our benchmarks.
