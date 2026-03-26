#!/usr/bin/env python3
"""
BlockRun Model Performance Benchmark v3
Measures end-to-end latency via non-streaming requests.
Uses real token counts from API usage response.
"""

import time
import json
import os
import sys
from datetime import datetime, timezone
from openai import OpenAI

MODELS = [
    # OpenAI
    "openai/gpt-5.4", "openai/gpt-5.4-pro",
    "openai/gpt-5.3", "openai/gpt-5.3-codex",
    "openai/gpt-5.2", "openai/gpt-5.2-pro",
    "openai/gpt-5-mini", "openai/gpt-5-nano",
    "openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4.1-nano",
    "openai/gpt-4o", "openai/gpt-4o-mini",
    "openai/o3", "openai/o3-mini", "openai/o4-mini",
    "openai/o1", "openai/o1-mini",
    # Anthropic
    "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "anthropic/claude-haiku-4.5",
    # Google
    "google/gemini-3.1-pro", "google/gemini-3-pro-preview", "google/gemini-3-flash-preview",
    "google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.5-flash-lite",
    # DeepSeek
    "deepseek/deepseek-chat", "deepseek/deepseek-reasoner",
    # Moonshot
    "moonshot/kimi-k2.5",
    # xAI
    "xai/grok-3", "xai/grok-3-mini",
    "xai/grok-4-fast-reasoning", "xai/grok-4-fast-non-reasoning",
    "xai/grok-4-1-fast-reasoning", "xai/grok-4-1-fast-non-reasoning",
    "xai/grok-4-0709",
    # MiniMax
    "minimax/minimax-m2.5",
    # NVIDIA
    "nvidia/gpt-oss-120b",
]

PROMPTS = [
    "Write a Python function that checks if a string is a valid IPv4 address. Include edge cases and a docstring.",
    "Write a Python function that finds the longest common subsequence of two strings. Include type hints and examples.",
    "Write a Python function that implements a simple LRU cache using OrderedDict. Include usage examples.",
]

NUM_REQUESTS = 2
MAX_TOKENS = 256


def benchmark_model(client: OpenAI, model: str) -> list:
    results = []
    for i in range(NUM_REQUESTS):
        prompt = PROMPTS[i % len(PROMPTS)]
        try:
            start = time.perf_counter()
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=MAX_TOKENS,
                stream=False,
                temperature=0.7,
            )
            latency = (time.perf_counter() - start) * 1000

            content = resp.choices[0].message.content or ""
            finish = resp.choices[0].finish_reason
            usage = resp.usage
            input_tokens = usage.prompt_tokens if usage else 0
            output_tokens = usage.completion_tokens if usage else 0
            total_tokens = usage.total_tokens if usage else 0

            # Tokens per second (output tokens / latency)
            tps = (output_tokens / (latency / 1000)) if latency > 0 and output_tokens > 0 else 0

            results.append({
                "request": i + 1,
                "latency_ms": round(latency, 0),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "tokens_per_sec": round(tps, 1),
                "output_chars": len(content),
                "finish_reason": finish,
                "status": "success",
            })
            print(f"  Run {i+1}: {latency:.0f}ms, {output_tokens} out tokens, {tps:.0f} tok/s, finish={finish}")

        except Exception as e:
            error_msg = str(e)[:200]
            results.append({"request": i + 1, "status": "error", "error": error_msg})
            print(f"  Run {i+1}: ERROR - {error_msg[:120]}")
            if "429" in error_msg or "rate" in error_msg.lower():
                print("  >> Rate limited, waiting 30s...")
                time.sleep(30)

        time.sleep(3)
    return results


def aggregate(results: list) -> dict:
    successes = [r for r in results if r["status"] == "success"]
    if not successes:
        return {"error_rate": 1.0, "runs": len(results)}

    latencies = [r["latency_ms"] for r in successes]
    tps_vals = [r["tokens_per_sec"] for r in successes if r["tokens_per_sec"] > 0]
    out_tokens = [r["output_tokens"] for r in successes]

    return {
        "runs": len(results),
        "successes": len(successes),
        "error_rate": round(1 - len(successes) / len(results), 2),
        "avg_latency_ms": round(sum(latencies) / len(latencies), 0),
        "min_latency_ms": round(min(latencies), 0),
        "max_latency_ms": round(max(latencies), 0),
        "avg_tokens_per_sec": round(sum(tps_vals) / len(tps_vals), 1) if tps_vals else 0,
        "avg_output_tokens": round(sum(out_tokens) / len(out_tokens), 0),
    }


# Model pricing (USD per 1M tokens) — for cost calculation
PRICING = {
    "openai/gpt-5.4": (2.5, 15), "openai/gpt-5.4-pro": (2.5, 15),
    "openai/gpt-5.3": (2.5, 10), "openai/gpt-5.3-codex": (2.5, 10),
    "openai/gpt-5.2": (2.5, 10), "openai/gpt-5.2-pro": (2.5, 10),
    "openai/gpt-5-mini": (1.1, 4.4), "openai/gpt-5-nano": (0.5, 2),
    "openai/gpt-4.1": (2, 8), "openai/gpt-4.1-mini": (0.4, 1.6), "openai/gpt-4.1-nano": (0.1, 0.4),
    "openai/gpt-4o": (2.5, 10), "openai/gpt-4o-mini": (0.15, 0.6),
    "openai/o3": (2, 8), "openai/o3-mini": (1.1, 4.4), "openai/o4-mini": (1.1, 4.4),
    "openai/o1": (15, 60), "openai/o1-mini": (1.1, 4.4),
    "anthropic/claude-sonnet-4.6": (3, 15), "anthropic/claude-opus-4.6": (15, 75),
    "anthropic/claude-haiku-4.5": (0.8, 4),
    "google/gemini-3.1-pro": (1.25, 10), "google/gemini-3-pro-preview": (1.25, 10),
    "google/gemini-3-flash-preview": (0.15, 0.6),
    "google/gemini-2.5-pro": (1.25, 10), "google/gemini-2.5-flash": (0.15, 0.6),
    "google/gemini-2.5-flash-lite": (0.1, 0.4),
    "deepseek/deepseek-chat": (0.27, 1.1), "deepseek/deepseek-reasoner": (0.55, 2.19),
    "moonshot/kimi-k2.5": (0.6, 3),
    "xai/grok-3": (3, 15), "xai/grok-3-mini": (0.3, 0.5),
    "xai/grok-4-fast-reasoning": (0.2, 0.5), "xai/grok-4-fast-non-reasoning": (0.2, 0.5),
    "xai/grok-4-1-fast-reasoning": (0.2, 0.5), "xai/grok-4-1-fast-non-reasoning": (0.2, 0.5),
    "xai/grok-4-0709": (0.2, 1.5),
    "minimax/minimax-m2.5": (0.3, 1.1),
    "nvidia/gpt-oss-120b": (0, 0),
}


def main():
    client = OpenAI(api_key="x402", base_url="http://localhost:18789/v1")

    print("BlockRun Model Performance Benchmark v3")
    print("=" * 60)
    try:
        models = client.models.list()
        print(f"Connected. {len(models.data)} models available.")
    except Exception as e:
        print(f"Connection failed: {e}")
        sys.exit(1)

    print(f"Config: {NUM_REQUESTS} requests/model, {MAX_TOKENS} max tokens, non-streaming\n")

    all_results = {}
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    models_to_test = MODELS if len(sys.argv) <= 1 else sys.argv[1:]
    total = len(models_to_test)

    for idx, model in enumerate(models_to_test, 1):
        print(f"\n[{idx}/{total}] {model}")
        results = benchmark_model(client, model)
        agg = aggregate(results)
        all_results[model] = {"raw": results, "summary": agg}

        if agg.get("successes", 0) > 0:
            print(f"  >> {agg['avg_latency_ms']:.0f}ms avg, {agg.get('avg_tokens_per_sec', 0)} tok/s, ~{agg['avg_output_tokens']} tokens")
        else:
            print(f"  >> ALL FAILED")

        # Save incrementally
        output = {
            "benchmark": "BlockRun Model Performance",
            "version": "3.0",
            "timestamp": timestamp,
            "config": {"num_requests": NUM_REQUESTS, "max_tokens": MAX_TOKENS, "mode": "non-streaming"},
            "results": all_results,
        }
        with open(os.path.join(os.path.dirname(__file__), "..", "benchmark-results.json"), "w") as f:
            json.dump(output, f, indent=2)

    # === LEADERBOARD ===
    print("\n" + "=" * 100)
    print("BLOCKRUN MODEL PERFORMANCE LEADERBOARD")
    print(f"Date: {timestamp} | Mode: non-streaming | Max tokens: {MAX_TOKENS}")
    print("=" * 100)

    ranked = [(m, d["summary"]) for m, d in all_results.items() if d["summary"].get("successes", 0) > 0]
    ranked.sort(key=lambda x: x[1]["avg_latency_ms"])

    print(f"\n{'#':<4} {'Model':<40} {'Latency':<12} {'Tok/s':<9} {'Out Tok':<9} {'$/1M in':<9} {'$/1M out':<9}")
    print("-" * 92)
    for i, (model, s) in enumerate(ranked, 1):
        p = PRICING.get(model, (0, 0))
        tps = s.get("avg_tokens_per_sec", 0)
        print(f"{i:<4} {model:<40} {s['avg_latency_ms']:<12.0f} {tps:<9.1f} {s['avg_output_tokens']:<9.0f} ${p[0]:<8} ${p[1]:<8}")

    # Errors
    errors = [(m, d["summary"]) for m, d in all_results.items() if d["summary"].get("error_rate", 0) > 0]
    if errors:
        print(f"\nErrors:")
        for model, s in errors:
            print(f"  {model}: {s.get('error_rate', 1)*100:.0f}% failures")

    print(f"\nResults saved to benchmark-results.json")


if __name__ == "__main__":
    main()
