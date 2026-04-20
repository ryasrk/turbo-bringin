"""OpenAI-compatible client for testing inference modes."""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error


def chat_completion(
    prompt: str,
    base_url: str = "http://localhost:8080",
    model: str = "bonsai-8b",
    max_tokens: int = 256,
    temperature: float = 0.7,
    stream: bool = False,
    api_key: str = "",
) -> dict:
    """Send a chat completion request to the inference server."""
    url = f"{base_url}/v1/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
    }

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())
    except urllib.error.URLError as e:
        return {"error": str(e)}


def health_check(base_url: str = "http://localhost:8080") -> dict:
    """Check if the server is healthy."""
    url = f"{base_url}/health"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError):
        return {"status": "unavailable"}


def main():
    parser = argparse.ArgumentParser(description="Tenrary-X Inference Client")
    subparsers = parser.add_subparsers(dest="command")

    # Chat command
    chat_parser = subparsers.add_parser("chat", help="Send a chat message")
    chat_parser.add_argument("prompt", type=str, help="The prompt to send")
    chat_parser.add_argument("--mode", choices=["standard", "turboquant"], default="standard")
    chat_parser.add_argument("--max-tokens", type=int, default=256)
    chat_parser.add_argument("--temperature", type=float, default=0.7)
    chat_parser.add_argument("--api-key", type=str, default="")

    # Health command
    health_parser = subparsers.add_parser("health", help="Check server health")
    health_parser.add_argument("--mode", choices=["standard", "turboquant"], default="standard")

    # Benchmark command
    bench_parser = subparsers.add_parser("bench", help="Quick latency benchmark")
    bench_parser.add_argument("--mode", choices=["standard", "turboquant"], default="standard")
    bench_parser.add_argument("--api-key", type=str, default="")

    args = parser.parse_args()

    port_map = {"standard": 8080, "turboquant": 8081}

    if args.command == "chat":
        port = port_map[args.mode]
        base_url = f"http://localhost:{port}"

        t0 = time.time()
        result = chat_completion(
            args.prompt,
            base_url=base_url,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            api_key=args.api_key,
        )
        elapsed = time.time() - t0

        if "error" in result:
            print(f"Error: {result['error']}")
            sys.exit(1)

        content = result["choices"][0]["message"]["content"]
        usage = result.get("usage", {})
        print(content)
        print(f"\n--- [{args.mode}] {elapsed:.2f}s | "
              f"prompt: {usage.get('prompt_tokens', '?')} tok | "
              f"completion: {usage.get('completion_tokens', '?')} tok ---")

    elif args.command == "health":
        port = port_map[args.mode]
        result = health_check(f"http://localhost:{port}")
        status = result.get("status", "unknown")
        print(f"{args.mode} server: {status}")

    elif args.command == "bench":
        port = port_map[args.mode]
        base_url = f"http://localhost:{port}"

        prompts = [
            "What is 15 * 17?",
            "Explain quantum computing in one sentence.",
            "Write a Python function to find the nth Fibonacci number.",
        ]

        print(f"Benchmarking {args.mode} mode (port {port})...")
        print("-" * 50)

        for prompt in prompts:
            t0 = time.time()
            result = chat_completion(prompt, base_url=base_url, max_tokens=128, temperature=0.1, api_key=args.api_key)
            elapsed = time.time() - t0

            if "error" in result:
                print(f"  ❌ {prompt[:40]}... Error: {result['error']}")
                continue

            usage = result.get("usage", {})
            tokens = usage.get("completion_tokens", 0)
            tps = tokens / elapsed if elapsed > 0 else 0
            print(f"  ✅ {prompt[:40]}... {elapsed:.2f}s | {tokens} tok | {tps:.1f} t/s")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
