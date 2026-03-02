from docx import Document
import json
import re
from pathlib import Path

DOCX_PATH = Path("source/pca_exam_questions.docx")   # rename your file to this
OUT_PATH = Path("questions.json")

DOMAIN_HEADERS = [
    "Observability Concepts",
    "Prometheus Fundamentals",
    "PromQL",
    "Instrumentation and Exporters",
    "Recording & Alerting & Dashboarding",
]

def clean(s: str) -> str:
    s = re.sub(r"\s+", " ", s.strip())
    return s

def is_domain_line(line: str) -> str | None:
    for h in DOMAIN_HEADERS:
        if line.startswith(h):
            return h
    return None

def main():
    doc = Document(str(DOCX_PATH))
    lines = [clean(p.text) for p in doc.paragraphs]
    lines = [l for l in lines if l]

    # Find the start of the Answers section
    try:
        ans_idx = next(i for i, l in enumerate(lines) if "Answer of Questions" in l)
    except StopIteration:
        raise SystemExit("Could not find 'Answer of Questions' in DOCX. Adjust the script.")

    q_lines = lines[:ans_idx]
    a_lines = lines[ans_idx:]

    # --- Parse Questions by domain ---
    questions = []
    current_domain = None
    q_texts = []

    for l in q_lines:
        d = is_domain_line(l)
        if d:
            current_domain = d
            continue
        # skip percentage lines like "Observability Concepts (18%)"
        if re.search(r"\(\d+%\)", l):
            continue
        # question lines: treat any non-empty line under a domain as a question
        if current_domain:
            q_texts.append((current_domain, l))

    # --- Parse Answers by domain, in the same order ---
    answers = []
    current_domain = None

    for l in a_lines:
        d = is_domain_line(l)
        if d:
            current_domain = d
            continue
        if re.search(r"\(\d+%\)", l):
            continue
        if l.startswith("💡"):
            continue
        if current_domain:
            answers.append((current_domain, l))

    # Map answers to questions in order, per domain
    q_by_domain = {d: [] for d in DOMAIN_HEADERS}
    a_by_domain = {d: [] for d in DOMAIN_HEADERS}

    for d, q in q_texts:
        q_by_domain[d].append(q)
    for d, a in answers:
        # Skip lines that are clearly not answers (rare doc artifacts)
        a_by_domain[d].append(a)

    # Build final list
    id_counters = {d: 0 for d in DOMAIN_HEADERS}
    for d in DOMAIN_HEADERS:
        qs = q_by_domain[d]
        ans = a_by_domain[d]
        if len(ans) < len(qs):
            print(f"[WARN] Domain '{d}' has fewer answers ({len(ans)}) than questions ({len(qs)}).")
        for i, q in enumerate(qs):
            id_counters[d] += 1
            aid = id_counters[d]
            answer = ans[i] if i < len(ans) else ""
            questions.append({
                "id": f"{re.sub(r'[^a-z]+','', d.lower())[:6]}-{aid:03d}",
                "domain": d,
                "question": q,
                "answer": answer
            })

    payload = {
        "title": "PCA Exam Simulator",
        "version": "1.0",
        "questions": questions
    }

    OUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[OK] Wrote {len(questions)} questions to {OUT_PATH}")

if __name__ == "__main__":
    main()