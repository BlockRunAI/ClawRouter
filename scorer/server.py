"""
ClawRouter Scorer — FastAPI service for ML-based request classification.

Classifies requests into:
  - tier: SIMPLE | MEDIUM | COMPLEX | REASONING
  - domain: stem | humanities | social_sciences | other

Uses ridge regression on embeddings from a local Ollama model.
Weights are pre-trained on the MMLU dataset.
"""

import json
import os
import time
from pathlib import Path

import numpy as np
import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
WEIGHTS_PATH = os.environ.get("WEIGHTS_PATH", str(Path(__file__).parent / "weights.json"))
SCORER_PORT = int(os.environ.get("SCORER_PORT", "8403"))

# ---------------------------------------------------------------------------
# Load weights
# ---------------------------------------------------------------------------

def load_weights(path: str) -> dict:
    with open(path) as f:
        w = json.load(f)
    result = {
        "embedding_model": w["embedding_model"],
        "embedding_dim": w["embedding_dim"],
        "subjects": w["subjects"],
        "tier_labels": w["tier_labels"],
        "subject_weights": np.array(w["subject_weights"]),
        "tier_weights": np.array(w["tier_weights"]),
        "subject_to_domain": w["subject_to_domain"],
    }
    if "domain_weights" in w:
        result["domain_weights"] = np.array(w["domain_weights"])
        result["domain_labels"] = w["domain_labels"]
    return result

WEIGHTS = load_weights(WEIGHTS_PATH)

# ---------------------------------------------------------------------------
# Embedding client
# ---------------------------------------------------------------------------

_http = httpx.AsyncClient(timeout=30.0)

async def get_embedding(text: str) -> np.ndarray:
    """Get embedding from Ollama."""
    resp = await _http.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": WEIGHTS["embedding_model"], "input": text},
    )
    resp.raise_for_status()
    emb = np.array(resp.json()["embeddings"][0])
    if emb.shape[0] != WEIGHTS["embedding_dim"]:
        raise ValueError(
            f"Embedding dim mismatch: got {emb.shape[0]}, "
            f"weights expect {WEIGHTS['embedding_dim']}. "
            f"Retrain weights or change OLLAMA embedding model."
        )
    return emb

# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def classify(emb: np.ndarray, question: str, choices: list[str]) -> dict:
    """Run full classification pipeline. Tier and domain are independent axes."""
    W = WEIGHTS
    x = np.append(emb, 1.0)

    # --- Domain: direct classifier if available, else subject lookup ---
    if "domain_weights" in W:
        domain = W["domain_labels"][int((x @ W["domain_weights"]).argmax())]
    else:
        subj_scores = x @ W["subject_weights"]
        pred_subj = W["subjects"][int(subj_scores.argmax())]
        domain = W["subject_to_domain"].get(pred_subj, "other")

    # --- Tier: pure quadratic classifier ---
    x_t = np.concatenate([emb, emb ** 2, [1.0]])
    tier = W["tier_labels"][int((x_t @ W["tier_weights"]).argmax())]

    # Subject (informational only)
    subj_scores = x @ W["subject_weights"]
    pred_subj = W["subjects"][int(subj_scores.argmax())]

    return {
        "tier": tier,
        "domain": domain,
        "predicted_subject": pred_subj,
        "keyword_subject": None,
    }

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="ClawRouter Scorer", version="1.0.0")


class ScoreRequest(BaseModel):
    question: str
    choices: list[str] = []


class ScoreResponse(BaseModel):
    tier: str
    domain: str
    predicted_subject: str
    keyword_subject: str | None
    latency_ms: float


@app.post("/score", response_model=ScoreResponse)
async def score(req: ScoreRequest):
    t0 = time.perf_counter()
    try:
        emb = await get_embedding(req.question)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama embedding failed: {e}")
    result = classify(emb, req.question, req.choices)
    latency = (time.perf_counter() - t0) * 1000
    return ScoreResponse(**result, latency_ms=round(latency, 1))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "embedding_model": WEIGHTS["embedding_model"],
        "embedding_dim": WEIGHTS["embedding_dim"],
        "n_subjects": len(WEIGHTS["subjects"]),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=SCORER_PORT)
