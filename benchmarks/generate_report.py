#!/usr/bin/env python3
"""Generate comparison report from benchmark results.

Reads JSON results from a benchmark run directory and produces
a Markdown report with tables and analysis.

Usage:
    python3 benchmarks/generate_report.py \
        --results-dir results/run_20260420_120000
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_json(path: Path) -> dict | None:
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return None


def format_table(headers: list[str], rows: list[list]) -> str:
    """Format a Markdown table."""
    col_widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            col_widths[i] = max(col_widths[i], len(str(cell)))

    lines = []
    header_line = "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |"
    sep_line = "| " + " | ".join("-" * col_widths[i] for i in range(len(headers))) + " |"
    lines.append(header_line)
    lines.append(sep_line)

    for row in rows:
        line = "| " + " | ".join(str(cell).ljust(col_widths[i]) for i, cell in enumerate(row)) + " |"
        lines.append(line)

    return "\n".join(lines)


def generate_report(results_dir: Path) -> str:
    """Generate full Markdown report."""
    sections = []

    sections.append("# Tenrary-X Benchmark Report")
    sections.append(f"\nGenerated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    sections.append(f"Results: `{results_dir}`\n")

    # ── Speed comparison ────────────────────────────────────────
    baseline_speed = load_json(results_dir / "baseline_speed.json")
    tq_speed = load_json(results_dir / "turboquant_speed.json")

    if baseline_speed or tq_speed:
        sections.append("## Speed Comparison\n")
        headers = ["Mode", "Context", "tok/s", "TTFT(ms)", "VRAM(MB)", "RAM(MB)"]
        rows = []

        for data in [baseline_speed, tq_speed]:
            if data:
                for r in data.get("results", []):
                    rows.append([
                        r["mode"],
                        r["context_length"],
                        r["tokens_per_sec"],
                        r["ttft_ms"],
                        r["vram_used_mb"],
                        r["ram_used_mb"],
                    ])

        sections.append(format_table(headers, rows))

        # Delta analysis
        if baseline_speed and tq_speed:
            sections.append("\n### Speed Delta\n")
            b_results = {r["context_length"]: r for r in baseline_speed.get("results", [])}
            t_results = {r["context_length"]: r for r in tq_speed.get("results", [])}

            for ctx in sorted(set(b_results) & set(t_results)):
                b = b_results[ctx]
                t = t_results[ctx]
                tps_delta = t["tokens_per_sec"] - b["tokens_per_sec"]
                vram_delta = t["vram_used_mb"] - b["vram_used_mb"]
                sections.append(f"- **{ctx} ctx**: tok/s {tps_delta:+.1f}, VRAM {vram_delta:+d} MB")

    # ── Quality comparison ──────────────────────────────────────
    baseline_quality = load_json(results_dir / "baseline_quality.json")
    tq_quality = load_json(results_dir / "turboquant_quality.json")

    if baseline_quality or tq_quality:
        sections.append("\n## Quality Comparison\n")
        headers = ["Mode", "Avg Coherence", "Avg Repetition", "Avg Keywords"]
        rows = []

        for data in [baseline_quality, tq_quality]:
            if data and data.get("summary"):
                s = data["summary"]
                rows.append([
                    data["mode"],
                    s["avg_coherence"],
                    s["avg_repetition"],
                    s["avg_keyword_match"],
                ])

        sections.append(format_table(headers, rows))

        # Per-prompt comparison
        if baseline_quality and tq_quality:
            sections.append("\n### Per-Prompt Detail\n")
            headers = ["Category", "Baseline Coherence", "TQ Coherence", "Baseline Keywords", "TQ Keywords"]
            rows = []
            b_results = baseline_quality.get("results", [])
            t_results = tq_quality.get("results", [])

            for b, t in zip(b_results, t_results):
                rows.append([
                    b["category"],
                    b["coherence"],
                    t["coherence"],
                    b["keyword_match"],
                    t["keyword_match"],
                ])

            sections.append(format_table(headers, rows))

    # ── KV Scaling ──────────────────────────────────────────────
    kv_scaling = load_json(results_dir / "kv_scaling.json")

    if kv_scaling:
        sections.append("\n## KV Cache Scaling\n")
        headers = ["Context", "Config", "tok/s", "VRAM(MB)", "Status"]
        rows = []

        for r in kv_scaling.get("results", []):
            status = "✅" if r["success"] else f"❌ {r.get('error', '')[:30]}"
            rows.append([
                r["context_length"],
                r["kv_config_name"],
                r["tokens_per_sec"],
                r["vram_used_mb"],
                status,
            ])

        sections.append(format_table(headers, rows))

    # ── Conclusions ─────────────────────────────────────────────
    sections.append("\n## Observations\n")
    sections.append("- [ ] TurboQuant speed impact: _fill after review_")
    sections.append("- [ ] TurboQuant VRAM savings: _fill after review_")
    sections.append("- [ ] Quality preserved: _fill after review_")
    sections.append("- [ ] Long context benefit: _fill after review_")
    sections.append("\n## Next Steps\n")
    sections.append("- [ ] Review raw outputs for hallucination/coherence")
    sections.append("- [ ] Test hybrid KV strategy if VRAM savings significant")
    sections.append("- [ ] Profile bottleneck (weight dequant vs KV vs attention)")

    return "\n".join(sections)


def main():
    parser = argparse.ArgumentParser(description="Generate benchmark comparison report")
    parser.add_argument("--results-dir", required=True)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    results_dir = Path(args.results_dir)
    if not results_dir.exists():
        print(f"ERROR: Results directory not found: {results_dir}")
        sys.exit(1)

    report = generate_report(results_dir)

    output_path = Path(args.output) if args.output else results_dir / "REPORT.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write(report)

    print(report)
    print(f"\n✅ Report saved to {output_path}")


if __name__ == "__main__":
    main()
