const EXAM_SECONDS_PER_Q = 90;

let DATA = null;
let state = {
  mode: "timed",
  version: "A",
  count: 60,
  studyMode: "normal",
  examFile: "exam1.json",
  examQs: [],
  answers: {},
  timers: {},
  currentIndex: 0,
};

const $ = (id) => document.getElementById(id);

async function loadQuestions(examFile) {
  const res = await fetch(examFile);
  if (!res.ok) throw new Error(`Failed to load ${examFile}`);
  DATA = await res.json();
  return DATA;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickN(arr, n) {
  return arr.slice(0, Math.min(n, arr.length));
}

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Supports both of these JSON shapes:
 * 1) { questions: [...] }
 * 2) [ ... ] (array of question objects)
 *
 * Expected input question object (your new format):
 * { domain, question, correct_answer, incorrect_answers }
 *
 * Normalized output:
 * { id, domain, question, answer, incorrect_answers }
 */
function normalizeQuestions(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.questions ?? []);

  const out = [];
  const domainCounters = {};
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] || {};
    const domain = q.domain ?? q.dominio ?? "General";
    const question = q.question ?? q.pergunta ?? "";
    const answer = q.correct_answer ?? q.answer ?? null;
    const incorrect = q.incorrect_answers ?? [];

    if (!domainCounters[domain]) domainCounters[domain] = 0;
    domainCounters[domain] += 1;

    // make an id if not present
    const slug = String(domain).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const id = q.id ?? `${slug || "q"}-${String(domainCounters[domain]).padStart(3, "0")}`;

    out.push({
      id,
      domain,
      question,
      answer,
      incorrect_answers: Array.isArray(incorrect) ? incorrect : [],
    });
  }
  return out.filter(x => x.question && x.answer); // ignore malformed rows
}

// Build choices from the provided incorrect answers (randomized) + correct answer
function buildChoicesFromProvided(q) {
  const incorrect = Array.isArray(q.incorrect_answers) ? q.incorrect_answers : [];
  // Remove duplicates + remove correct answer if it somehow appears in incorrect
  const uniq = [];
  for (const opt of incorrect) {
    const t = String(opt ?? "").trim();
    if (!t) continue;
    if (t === q.answer) continue;
    if (!uniq.includes(t)) uniq.push(t);
  }

  // PCA-style question usually has 4 options; if fewer, keep what's available
  const pickedIncorrect = pickN(shuffle(uniq), 3);

  return shuffle([q.answer, ...pickedIncorrect]);
}

function buildExamSet(all, version, count) {
  const qs = [...all];

  let selected;
  if (version === "A") {
    selected = shuffle(qs);
  } else {
    // Version B: shuffle within each domain, then concatenate
    const byDomain = {};
    for (const q of qs) {
      byDomain[q.domain] = byDomain[q.domain] || [];
      byDomain[q.domain].push(q);
    }
    const domains = Object.keys(byDomain).sort();
    selected = [];
    for (const d of domains) selected.push(...shuffle(byDomain[d]));
  }

  selected = pickN(selected, count);

  // attach randomized choices
  return selected.map(q => ({
    ...q,
    choices: buildChoicesFromProvided(q)
  }));
}

function resetAll() {
  for (const k of Object.keys(state.timers)) clearInterval(state.timers[k]);

  state = {
    mode: $("mode").value,
    version: $("version").value,
    count: (Number.isFinite(parseInt($("count").value, 10)) ? parseInt($("count").value, 10) : 60),
    studyMode: $("studyMode").value,
    examFile: $("examFile")?.value || "exam1.json",
    examQs: [],
    answers: {},
    timers: {},
    currentIndex: 0,
  };

  $("exam").classList.add("hidden");
  $("results").classList.add("hidden");
  $("exam").innerHTML = "";
  $("results").innerHTML = "";
}

function lockQuestion(qid, { expired=false } = {}) {
  if (!state.answers[qid]) state.answers[qid] = { selected: null, correct: false, locked: false, expired: false };
  state.answers[qid].locked = true;
  state.answers[qid].expired = expired;

  if (state.timers[qid]) {
    clearInterval(state.timers[qid]);
    delete state.timers[qid];
  }
}

function renderChoice(q, choiceText) {
  const qid = q.id;
  const a = state.answers[qid];
  const locked = a?.locked;

  const checked = a?.selected === choiceText ? "checked" : "";
  const disabled = locked ? "disabled" : "";

  return `
    <label class="choice">
      <input type="radio" name="q_${qid}" value="${escapeHtml(choiceText)}" ${checked} ${disabled} />
      <span>${escapeHtml(choiceText)}</span>
    </label>
  `;
}

function attachQuestionHandlers(container) {
  container.querySelectorAll("input[type=radio]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const qid = e.target.name.replace("q_", "");
      const q = state.examQs.find(x => x.id === qid);
      if (!q) return;

      if (state.answers[qid]?.locked) return;

      const selected = e.target.value;
      const correct = selected === q.answer;

      state.answers[qid] = { selected, correct, locked: false, expired: false };
      lockQuestion(qid);

      if (state.mode === "timed") renderTimed();
      else renderUntimed();
    });
  });

  container.querySelectorAll("[data-show-answer]").forEach(btn => {
    btn.addEventListener("click", () => {
      const qid = btn.getAttribute("data-show-answer");
      const ansDiv = container.querySelector(`#ans_${qid}`);
      if (!ansDiv) return;
      ansDiv.classList.toggle("hidden");
      btn.textContent = ansDiv.classList.contains("hidden") ? "Show answer" : "Hide answer";
    });
  });
}

function renderQuestionCard(q, showTimer) {
  const a = state.answers[q.id];
  const locked = a?.locked;
  const selected = a?.selected;
  const correct = a?.correct;

  const statusBadge = locked
    ? `<span class="badge ${correct ? "correct" : "wrong"}">${correct ? "Correct" : (a?.expired ? "Expired" : "Wrong")}</span>`
    : `<span class="badge">Open</span>`;

  const timerSlot = showTimer ? `<span class="timer" id="timer_${q.id}">01:30</span>` : "";

  const showAll = state.studyMode === "show_all_answers";
  const ansHiddenClass = showAll ? "" : "hidden";
  const btnLabel = showAll ? "Hide answer" : "Show answer";

  return `
    <div class="qcard ${locked ? "locked" : ""}" data-qid="${q.id}">
      <div class="qhead">
        <div>
          <div class="muted small">${escapeHtml(q.domain)} • ${escapeHtml(q.id)}</div>
          <h3>${escapeHtml(q.question)}</h3>
        </div>
        <div class="row">
          ${timerSlot}
          ${statusBadge}
        </div>
      </div>

      <div class="choices">
        ${q.choices.map(c => renderChoice(q, c)).join("")}
      </div>

      <div class="row" style="margin-top:10px;">
        <button type="button" class="secondary" data-show-answer="${q.id}">${btnLabel}</button>
      </div>

      <div id="ans_${q.id}" class="card ${ansHiddenClass}" style="margin-top:10px;">
        <div class="muted small">Official answer:</div>
        <div><strong>${escapeHtml(q.answer)}</strong></div>
        ${selected ? `<div class="muted small" style="margin-top:8px;">Your answer: ${escapeHtml(selected)}</div>` : ""}
      </div>
    </div>
  `;
}

function startTimerForQuestion(q) {
  const qid = q.id;
  if (state.answers[qid]?.locked) return;

  let remaining = EXAM_SECONDS_PER_Q;

  const timerEl = document.getElementById(`timer_${qid}`);
  const tick = () => {
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    if (timerEl) timerEl.textContent = `${mm}:${ss}`;

    remaining -= 1;

    if (remaining < 0) {
      lockQuestion(qid, { expired: true });
      renderTimed();

      if (state.currentIndex < state.examQs.length - 1) {
        state.currentIndex += 1;
        renderTimed();
      }
    }
  };

  tick();
  state.timers[qid] = setInterval(tick, 1000);
}

function renderTimed() {
  const exam = $("exam");
  exam.classList.remove("hidden");
  $("results").classList.add("hidden");

  const q = state.examQs[state.currentIndex];

  exam.innerHTML = `
    <section class="card">
      <div class="qhead">
        <div>
          <h2>Timed Exam</h2>
          <div class="muted">Question ${state.currentIndex + 1} of ${state.examQs.length}</div>
        </div>
        <div class="row">
          <button id="prevBtn" class="secondary" ${state.currentIndex === 0 ? "disabled" : ""}>Previous</button>
          <button id="nextBtn" class="secondary" ${state.currentIndex === state.examQs.length - 1 ? "disabled" : ""}>Next</button>
          <button id="finishBtn">Finish Exam</button>
        </div>
      </div>
      <hr/>
      ${renderQuestionCard(q, true)}
    </section>
  `;

  $("prevBtn").onclick = () => { state.currentIndex -= 1; renderTimed(); };
  $("nextBtn").onclick = () => { state.currentIndex += 1; renderTimed(); };
  $("finishBtn").onclick = () => showResults();

  attachQuestionHandlers(exam);
  startTimerForQuestion(q);
}

function renderUntimed() {
  const exam = $("exam");
  exam.classList.remove("hidden");
  $("results").classList.add("hidden");

  exam.innerHTML = `
    <section class="card">
      <div class="qhead">
        <div>
          <h2>Untimed Exam</h2>
          <div class="muted">${state.examQs.length} questions • Answer locks when selected</div>
        </div>
        <div class="row">
          <button id="finishBtn">Finish Exam</button>
        </div>
      </div>
      <hr/>
      ${state.examQs.map(q => renderQuestionCard(q, false)).join("")}
    </section>
  `;

  $("finishBtn").onclick = () => showResults();
  attachQuestionHandlers(exam);
}

function autoAnswerAllCorrect() {
  for (const q of state.examQs) {
    state.answers[q.id] = {
      selected: q.answer,
      correct: true,
      locked: true,
      expired: false
    };
  }
  for (const k of Object.keys(state.timers)) clearInterval(state.timers[k]);
  state.timers = {};
}

function showResults() {
  for (const k of Object.keys(state.timers)) clearInterval(state.timers[k]);
  state.timers = {};

  const total = state.examQs.length;
  let answered = 0;
  let correct = 0;
  let expired = 0;

  const byDomain = {};

  for (const q of state.examQs) {
    const a = state.answers[q.id];
    const d = q.domain;
    byDomain[d] = byDomain[d] || { total: 0, answered: 0, correct: 0 };
    byDomain[d].total += 1;

    if (a?.locked) {
      byDomain[d].answered += 1;
      answered += 1;
      if (a.expired && !a.selected) expired += 1;
      if (a.correct) {
        byDomain[d].correct += 1;
        correct += 1;
      }
    }
  }

  const scorePct = total ? Math.round((correct / total) * 100) : 0;

  const results = $("results");
  results.classList.remove("hidden");
  results.innerHTML = `
    <h2>Results</h2>
    <div class="row">
      <span class="badge">Total: ${total}</span>
      <span class="badge">Answered/Locked: ${answered}</span>
      <span class="badge">Correct: ${correct}</span>
      <span class="badge">Score: ${scorePct}%</span>
      ${state.mode === "timed" ? `<span class="badge">Expired: ${expired}</span>` : ""}
    </div>

    <h3 style="margin-top:14px;">By domain</h3>
    <div class="card">
      ${Object.entries(byDomain).map(([d, s]) => {
        const pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
        return `<div class="row">
          <div style="min-width:320px;"><strong>${escapeHtml(d)}</strong></div>
          <span class="badge">Correct ${s.correct}/${s.total} (${pct}%)</span>
        </div>`;
      }).join("")}
    </div>
  `;

  results.scrollIntoView({ behavior: "smooth" });
}

async function startExam() {
  resetAll();

  // Load the selected exam file every time (supports multiple exams)
  const payload = await loadQuestions(state.examFile);
  const allQs = normalizeQuestions(payload);

  // If count says "All", use length; otherwise respect number
  const desiredCount = state.count;
  const finalCount = (Number.isFinite(desiredCount) ? Math.min(desiredCount, allQs.length) : allQs.length);

  state.examQs = buildExamSet(allQs, state.version, finalCount);

  if (state.studyMode === "auto_answer_all") {
    autoAnswerAllCorrect();
  }

  if (state.mode === "timed") renderTimed();
  else renderUntimed();
}

// Wire buttons
$("startBtn").addEventListener("click", startExam);
$("resetBtn").addEventListener("click", resetAll);

// When exam file changes, update the default count dropdown based on file size (best-effort)
$("examFile")?.addEventListener("change", async () => {
  try {
    const payload = await loadQuestions($("examFile").value);
    const allQs = normalizeQuestions(payload);
    // If the count select has an "All" option, update its label
    const countSel = $("count");
    if (countSel) {
      const allOpt = Array.from(countSel.options).find(o => o.value === "all");
      if (allOpt) allOpt.textContent = `All (${allQs.length})`;
    }
  } catch (e) {
    console.warn(e);
  }
});

// Initial hint load for exam1.json (optional). If it fails, UI still works.
loadQuestions("exam1.json").catch(() => {});
