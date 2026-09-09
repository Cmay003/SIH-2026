"""
SANJEEVNI - RAG Alert Generation Pipeline
===========================================
CLOUD-SIDE ONLY. This does not run on edge nodes (ESP32/RPi) - it runs on
your backend/cloud layer, when connectivity is available. Edge nodes send a
risk score + hazard type; this pipeline turns that into an actionable,
specific alert message by retrieving relevant SOP content.

Pipeline: SOP documents -> chunk -> embed -> store in Chroma (local, no
server needed) -> at alert time, retrieve top matching chunks for the
hazard/severity -> feed into an LLM call to generate a human-readable
alert.

NOT TESTED IN THIS SANDBOX: no internet access here to install chromadb/
sentence-transformers or call an LLM API. Written carefully and documented,
but you should run and verify this on your own machine (see README notes
at the bottom).

DEPENDENCIES: pip install chromadb sentence-transformers anthropic
"""

import os
import glob
import chromadb
from sentence_transformers import SentenceTransformer

COLLECTION_NAME = "sanjeevni_sops"
DB_PATH = "./chroma_db"
EMBEDDING_MODEL = "all-MiniLM-L6-v2"  # small, fast, runs locally, no API needed


def chunk_text(text: str, chunk_size: int = 400, overlap: int = 50) -> list[str]:
    """Simple sliding-window chunker by characters. Good enough for short
    SOP docs; for longer documents, chunk by paragraph/section instead."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end].strip())
        start += chunk_size - overlap
    return [c for c in chunks if c]


def build_knowledge_base(docs_folder: str = "./sample_sops"):
    """Run this once (or whenever SOP documents change) to populate the
    vector store. Safe to re-run - it recreates the collection each time."""
    client = chromadb.PersistentClient(path=DB_PATH)

    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass
    collection = client.create_collection(COLLECTION_NAME)

    embedder = SentenceTransformer(EMBEDDING_MODEL)

    doc_paths = glob.glob(os.path.join(docs_folder, "*.txt"))
    if not doc_paths:
        raise FileNotFoundError(
            f"No .txt files found in {docs_folder}. Add your SOP documents there first."
        )

    all_chunks, all_ids, all_metadata = [], [], []
    for path in doc_paths:
        source_name = os.path.basename(path)
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        chunks = chunk_text(text)
        for i, chunk in enumerate(chunks):
            all_chunks.append(chunk)
            all_ids.append(f"{source_name}_{i}")
            all_metadata.append({"source": source_name})

    embeddings = embedder.encode(all_chunks).tolist()
    collection.add(
        ids=all_ids,
        embeddings=embeddings,
        documents=all_chunks,
        metadatas=all_metadata,
    )
    print(f"Indexed {len(all_chunks)} chunks from {len(doc_paths)} documents.")
    return collection, embedder


def retrieve_context(
    query: str, collection, embedder, top_k: int = 3, source_filter: str | None = None
) -> list[dict]:
    """Retrieve the top_k most relevant SOP chunks for a query.

    source_filter restricts retrieval to chunks from a specific source file
    (e.g. "flood_response.txt"), which avoids cross-hazard bleed once you
    have multiple SOP docs with overlapping language ("high severity",
    "evacuate", etc.). Pass None to search across all documents."""
    query_embedding = embedder.encode([query]).tolist()
    where = {"source": source_filter} if source_filter else None
    results = collection.query(
        query_embeddings=query_embedding, n_results=top_k, where=where
    )
    return [
        {"text": doc, "source": meta["source"]}
        for doc, meta in zip(results["documents"][0], results["metadatas"][0])
    ]


def severity_band(risk_score: float) -> str:
    if risk_score > 0.7:
        return "HIGH"
    elif risk_score > 0.4:
        return "MEDIUM"
    return "LOW"


# Maps a hazard_type string to its SOP source file. Extend this as you add
# more hazard docs (pollution_response.txt, landslide_response.txt, etc.)
# Keep the keys lowercase - lookup below lowercases the input to match.
HAZARD_SOURCE_MAP = {
    "flood": "flood_response.txt",
    "forest fire": "fire_response.txt",
    "fire": "fire_response.txt",
    "gas leak": "gas_leak_response.txt",
    "gas": "gas_leak_response.txt",
}


def generate_alert_message(
    hazard_type: str,
    risk_score: float,
    location: str,
    collection,
    embedder,
    use_llm: bool = True,
) -> str:
    """
    Turns a risk score into an actionable alert message.

    use_llm=True calls an LLM (Anthropic API here) to write a natural,
    specific alert from the retrieved SOP context.
    use_llm=False falls back to a template - useful if you don't have an
    API key wired up yet, or want a guaranteed-deterministic demo fallback.
    """
    severity = severity_band(risk_score)
    query = f"{hazard_type} response {severity} severity procedure"
    source_filter = HAZARD_SOURCE_MAP.get(hazard_type.lower())
    if source_filter is None:
        print(
            f"[No SOP mapping for hazard_type='{hazard_type}' - searching all documents]"
        )
    context_chunks = retrieve_context(
        query, collection, embedder, top_k=3, source_filter=source_filter
    )
    context_text = "\n\n".join(
        f"[Source: {c['source']}]\n{c['text']}" for c in context_chunks
    )

    if not use_llm:
        return (
            f"[{severity} ALERT] {hazard_type.upper()} risk detected in {location}. "
            f"Risk score: {risk_score:.2f}. Follow standard {severity.lower()}-severity "
            f"procedure. Relevant guidance:\n\n{context_text}"
        )

    try:
        import anthropic

        client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from environment
        prompt = f"""You are generating a short, actionable disaster alert message for
{hazard_type} hazard in {location}. Risk score: {risk_score:.2f} ({severity} severity).

Relevant SOP guidance retrieved from the knowledge base:
{context_text}

Write a concise (3-5 sentence) alert message for residents/authorities that is
specific and actionable, based on the guidance above. Do not invent facts not
present in the guidance. If a shelter, route, or contact is named in the
guidance, include it."""

        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text
    except Exception as e:
        print(f"[LLM call failed: {e} - falling back to template]")
        return generate_alert_message(
            hazard_type, risk_score, location, collection, embedder, use_llm=False
        )


def main():
    print("Building knowledge base from sample_sops/ ...")
    collection, embedder = build_knowledge_base()

    print("\n" + "=" * 60)
    print("EXAMPLE: generating alerts for different scenarios")
    print("=" * 60)

    scenarios = [
        {"hazard_type": "flood", "risk_score": 0.85, "location": "Sector 4, Riverside"},
        {
            "hazard_type": "forest fire",
            "risk_score": 0.55,
            "location": "North Range Forest",
        },
        {
            "hazard_type": "gas leak",
            "risk_score": 0.92,
            "location": "Industrial Zone B",
        },
    ]

    for s in scenarios:
        print(
            f"\n--- {s['hazard_type'].upper()} | risk={s['risk_score']} | {s['location']} ---"
        )
        # use_llm=False here so this runs without needing an API key set up.
        # Flip to True once you have ANTHROPIC_API_KEY exported.
        message = generate_alert_message(
            **s, collection=collection, embedder=embedder, use_llm=False
        )
        print(message)


if __name__ == "__main__":
    main()
