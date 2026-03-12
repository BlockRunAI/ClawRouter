#!/usr/bin/env python3
"""
Retrain scorer weights with per-question tier labels derived from a model cascade.

Tier assignment is independent of subject — a model cascade determines how hard
each question actually is:
  SIMPLE    → smallest model gets it right
  MEDIUM    → small fails, medium model gets it right
  COMPLEX   → medium fails, large model gets it right
  REASONING → all models fail

Usage:
    python retrain.py                          # full pipeline
    python retrain.py --skip-cascade           # reuse cached tier labels
    EMBED_MODEL=nomic-embed-text python retrain.py
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx
import numpy as np

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

EMBED_MODEL = os.environ.get("EMBED_MODEL", "qwen3-embedding:4b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", str(Path(__file__).parent / "weights.json"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "32"))
CACHE_DIR = Path(__file__).parent / ".retrain_cache"

# Model cascade: smallest → largest.  If model N gets it right, tier = TIERS[N].
CASCADE_MODELS = [
    os.environ.get("CASCADE_SMALL", "qwen3:0.6b"),
    os.environ.get("CASCADE_MEDIUM", "gemma3:4b"),
    os.environ.get("CASCADE_LARGE", "qwen3.5:9b"),
]
TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]  # len = len(CASCADE_MODELS) + 1

SUBJECT_TO_DOMAIN = {
    "abstract_algebra": "stem", "astronomy": "stem", "college_biology": "stem",
    "college_chemistry": "stem", "college_computer_science": "stem",
    "college_mathematics": "stem", "college_physics": "stem",
    "computer_security": "stem", "conceptual_physics": "stem",
    "electrical_engineering": "stem", "elementary_mathematics": "stem",
    "high_school_biology": "stem", "high_school_chemistry": "stem",
    "high_school_computer_science": "stem", "high_school_mathematics": "stem",
    "high_school_physics": "stem", "high_school_statistics": "stem",
    "machine_learning": "stem",
    "formal_logic": "humanities", "high_school_european_history": "humanities",
    "high_school_us_history": "humanities", "high_school_world_history": "humanities",
    "international_law": "humanities", "jurisprudence": "humanities",
    "logical_fallacies": "humanities", "moral_disputes": "humanities",
    "moral_scenarios": "humanities", "philosophy": "humanities",
    "prehistory": "humanities", "professional_law": "humanities",
    "world_religions": "humanities",
    "econometrics": "social_sciences", "high_school_geography": "social_sciences",
    "high_school_government_and_politics": "social_sciences",
    "high_school_macroeconomics": "social_sciences",
    "high_school_microeconomics": "social_sciences",
    "high_school_psychology": "social_sciences", "human_sexuality": "social_sciences",
    "professional_psychology": "social_sciences", "public_relations": "social_sciences",
    "security_studies": "social_sciences", "sociology": "social_sciences",
    "us_foreign_policy": "social_sciences",
    "anatomy": "other", "business_ethics": "other", "clinical_knowledge": "other",
    "college_medicine": "other", "global_facts": "other", "human_aging": "other",
    "management": "other", "marketing": "other", "medical_genetics": "other",
    "miscellaneous": "other", "nutrition": "other",
    "professional_accounting": "other", "professional_medicine": "other",
    "virology": "other",
}

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_mmlu():
    """Load MMLU test data with questions, choices, answers, and subjects."""
    try:
        from datasets import load_dataset
        ds = load_dataset("cais/mmlu", "all", split="test")
        data = []
        for row in ds:
            data.append({
                "question": row["question"],
                "subject": row["subject"],
                "choices": row["choices"],
                "answer": int(row["answer"]),  # 0-3
            })
        print(f"Loaded {len(data)} samples from MMLU")
        return data
    except ImportError:
        print("datasets package not found. Install with: pip install datasets")
        sys.exit(1)

# ---------------------------------------------------------------------------
# Model cascade for tier labeling
# ---------------------------------------------------------------------------

ANSWER_LETTERS = ["A", "B", "C", "D"]

def format_mcq(question: str, choices: list[str]) -> str:
    lines = [question]
    for i, c in enumerate(choices):
        lines.append(f"{ANSWER_LETTERS[i]}) {c}")
    lines.append("Answer with just the letter.")
    return "\n".join(lines)


def parse_answer(text: str) -> int | None:
    """Extract answer index (0-3) from model output."""
    text = text.strip()
    m = re.search(r'\b([A-D])\b', text[:20])
    if m:
        return ANSWER_LETTERS.index(m.group(1))
    return None


def evaluate_model(model: str, data: list[dict], indices: list[int]) -> list[bool]:
    """Run model on questions at given indices, return list of correct/incorrect."""
    client = httpx.Client(timeout=30.0)
    results = []
    t0 = time.time()
    for count, idx in enumerate(indices):
        d = data[idx]
        prompt = format_mcq(d["question"], d["choices"])
        try:
            resp = client.post(f"{OLLAMA_URL}/api/generate", json={
                "model": model, "prompt": prompt, "stream": False,
                "options": {"temperature": 0, "num_predict": 8},
            }, timeout=30.0)
            resp.raise_for_status()
            pred = parse_answer(resp.json().get("response", ""))
            results.append(pred == d["answer"])
        except Exception:
            results.append(False)
        if (count + 1) % 50 == 0 or count + 1 == len(indices):
            elapsed = time.time() - t0
            rate = (count + 1) / elapsed
            eta = (len(indices) - count - 1) / rate if rate > 0 else 0
            print(f"    {model}: {count+1}/{len(indices)} ({rate:.1f}/s, ETA {eta:.0f}s)", end="\r")
    print()
    client.close()
    return results


def assign_tiers_cascade(data: list[dict]) -> list[str]:
    """Assign tier labels via model cascade. Caches results per model."""
    CACHE_DIR.mkdir(exist_ok=True)
    n = len(data)
    tiers = [None] * n
    remaining = list(range(n))  # indices still unresolved

    for level, model in enumerate(CASCADE_MODELS):
        if not remaining:
            break
        cache_file = CACHE_DIR / f"cascade_{model.replace(':', '_').replace('/', '_')}.json"

        # Load cached results if available
        cached = {}
        if cache_file.exists():
            cached = {int(k): v for k, v in json.loads(cache_file.read_text()).items()}

        to_eval = [i for i in remaining if i not in cached]
        if to_eval:
            print(f"  Evaluating {len(to_eval)} questions with {model} (level {level})...")
            results = evaluate_model(model, data, to_eval)
            for idx, correct in zip(to_eval, results):
                cached[idx] = correct
            cache_file.write_text(json.dumps(cached))
        else:
            print(f"  {model}: using cached results for {len(remaining)} questions")

        # Assign tier to questions this model got right
        next_remaining = []
        for idx in remaining:
            if cached.get(idx, False):
                tiers[idx] = TIERS[level]
            else:
                next_remaining.append(idx)
        print(f"    → {len(remaining) - len(next_remaining)} classified as {TIERS[level]}, {len(next_remaining)} remaining")
        remaining = next_remaining

    # Anything left is REASONING
    for idx in remaining:
        tiers[idx] = TIERS[-1]
    if remaining:
        print(f"    → {len(remaining)} classified as {TIERS[-1]}")

    return tiers

# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_batch(texts: list[str], client: httpx.Client) -> np.ndarray:
    resp = client.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": EMBED_MODEL, "input": texts},
        timeout=120.0,
    )
    resp.raise_for_status()
    return np.array(resp.json()["embeddings"])


def embed_all(texts: list[str]) -> np.ndarray:
    client = httpx.Client()
    all_emb = []
    t0 = time.time()
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i:i + BATCH_SIZE]
        emb = embed_batch(batch, client)
        all_emb.append(emb)
        done = min(i + BATCH_SIZE, len(texts))
        elapsed = time.time() - t0
        rate = done / elapsed if elapsed > 0 else 0
        eta = (len(texts) - done) / rate if rate > 0 else 0
        print(f"  Embedded {done}/{len(texts)} ({rate:.0f}/s, ETA {eta:.0f}s)", end="\r")
    print()
    client.close()
    return np.vstack(all_emb)

# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train_weights(embeddings: np.ndarray, subjects: list[str], tiers: list[str]):
    subject_list = sorted(set(subjects))
    tier_labels = TIERS
    dim = embeddings.shape[1]

    from collections import Counter
    print(f"Training on {len(embeddings)} samples, {dim}-dim embeddings")
    print(f"Tier distribution: {dict(Counter(tiers))}")

    # Subject classifier: linear + bias
    Y_s = np.zeros((len(embeddings), len(subject_list)))
    for i, s in enumerate(subjects):
        Y_s[i, subject_list.index(s)] = 1
    X_s = np.concatenate([embeddings, np.ones((len(embeddings), 1))], axis=1)
    W_subj = np.linalg.solve(X_s.T @ X_s + 0.001 * np.eye(X_s.shape[1]), X_s.T @ Y_s)

    # Tier classifier: quadratic features + bias (independent of subject)
    Y_t = np.zeros((len(embeddings), len(tier_labels)))
    for i, t in enumerate(tiers):
        Y_t[i, tier_labels.index(t)] = 1
    X_t = np.concatenate([embeddings, embeddings ** 2, np.ones((len(embeddings), 1))], axis=1)
    W_tier = np.linalg.solve(X_t.T @ X_t + 0.01 * np.eye(X_t.shape[1]), X_t.T @ Y_t)

    print(f"  Subject weights: {W_subj.shape}, Tier weights: {W_tier.shape}")

    return {
        "embedding_model": EMBED_MODEL,
        "embedding_dim": dim,
        "subjects": subject_list,
        "tier_labels": tier_labels,
        "subject_weights": W_subj.tolist(),
        "tier_weights": W_tier.tolist(),
        "subject_to_domain": SUBJECT_TO_DOMAIN,
        "cascade_models": CASCADE_MODELS,
    }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-cascade", action="store_true", help="Reuse cached tier labels")
    args = parser.parse_args()

    print(f"Embedding model: {EMBED_MODEL}")
    print(f"Cascade models: {CASCADE_MODELS}")
    print(f"Output: {OUTPUT_PATH}\n")

    # Check Ollama
    try:
        resp = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=5.0)
        models = [m["name"] for m in resp.json().get("models", [])]
    except httpx.ConnectError:
        print(f"ERROR: Cannot connect to Ollama at {OLLAMA_URL}")
        sys.exit(1)

    data = load_mmlu()
    questions = [d["question"] for d in data]
    subjects = [d["subject"] for d in data]

    # --- Tier labels via cascade ---
    tier_cache = CACHE_DIR / "tier_labels.json"
    if args.skip_cascade and tier_cache.exists():
        print("Loading cached tier labels...")
        tiers = json.loads(tier_cache.read_text())
    else:
        print("Running model cascade for tier labeling...")
        tiers = assign_tiers_cascade(data)
        CACHE_DIR.mkdir(exist_ok=True)
        tier_cache.write_text(json.dumps(tiers))

    # --- Embeddings ---
    print(f"\nEmbedding {len(questions)} questions with {EMBED_MODEL}...")
    embeddings = embed_all(questions)

    # --- Train ---
    print("\nTraining classifiers...")
    weights = train_weights(embeddings, subjects, tiers)

    with open(OUTPUT_PATH, "w") as f:
        json.dump(weights, f)
    size_mb = os.path.getsize(OUTPUT_PATH) / 1024 / 1024
    print(f"\nSaved weights to {OUTPUT_PATH} ({size_mb:.1f} MB)")
    print("Restart the scorer service to use the new weights.")


if __name__ == "__main__":
    main()
