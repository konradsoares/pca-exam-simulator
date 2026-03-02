const EXAM_SECONDS_PER_Q = 90;

let DATA = null;
let state = {
  mode: "timed",
  version: "A",
  count: 120,
  studyMode: "normal",
  examQs: [],
  answers: {},
  timers: {},
  currentIndex: 0,
};

const $ = (id) => document.getElementById(id);

async function loadQuestions() {
  const res = await fetch("questions.json");
  if (!res.ok) throw new Error("Failed to load questions.json");
  DATA = await res.json();
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

// Build choices: correct + 3 distractors (answers from same domain)
function buildChoices(q, pool) {
  const sameDomain = pool.filter(x => x.domain === q.domain && x.id !== q.id && x.answer && x.answer !== q.answer);
  const distractors = shuffle(sameDomain).map(x => x.answer);
  const uniq = [];
  for (const a of distractors) {
    if (!uniq.includes(a)) uniq.push(a);
    if (uniq.length === 3) break;
  }
  const choices = shuffle([q.answer, ...uniq]);
  return choices;
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

  // attach choices
  const enriched = selected.map(q => ({
    ...q,
    choices: buildChoices(q, qs)
  }));

  return enriched;
}

function resetAll() {
  // clear timers
  for (const k of Object.keys(state.timers)) {
    clearInterval(state.timers[k]);
  }
  state = {
    mode: $("mode").value,
    version: $("version").value,
    count: parseInt($("count").value, 10),
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

  // stop timer if any
  if (state.timers[qid]) {
    clearInterval(state.timers[qid]);
    delete state.timers[qid];
  }
}

function renderChoice(q, idx, choiceText) {
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

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function attachQuestionHandlers(container) {
  container.querySelectorAll("input[type=radio]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const qid = e.target.name.replace("q_", "");
      const q = state.examQs.find(x => x.id === qid);
      if (!q) return;

      // if already locked, ignore
      if (state.answers[qid]?.locked) return;

      const selected = e.target.value;
      const correct = selected === q.answer;

      state.answers[qid] = { selected, correct, locked: false, expired: false };
      lockQuestion(qid);

      // re-render current view so options disable immediately
      if (state.mode === "timed") {
        renderTimed();
      } else {
        renderUntimed(); // simple but re-renders; ok for 120 Q
      }
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
        ${q.choices.map((c, i) => renderChoice(q, i, c)).join("")}
      </div>

      <div class="row" style="margin-top:10px;">
        <button type="button" class="secondary" data-show-answer="${q.id}">${btnLabel}</button>
      </div>

      <div id="ans_${q.id}" class="card ${ansHiddenClass}" style="margin-top:10px;">
        <div class="muted small">Official answer:</div>
        <div><strong>${escapeHtml(q.answer || "(no answer in dataset)")}</strong></div>
        ${selected ? `<div class="muted small" style="margin-top:8px;">Your answer: ${escapeHtml(selected)}</div>` : ""}
      </div>
    </div>
  `;
}

function startTimerForQuestion(q) {
  const qid = q.id;

  // If already answered/locked, don’t start timer
  if (state.answers[qid]?.locked) return;

  let remaining = EXAM_SECONDS_PER_Q;

  const timerEl = document.getElementById(`timer_${qid}`);
  const tick = () => {
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    if (timerEl) timerEl.textContent = `${mm}:${ss}`;

    remaining -= 1;

    if (remaining < 0) {
      // time expired
      lockQuestion(qid, { expired: true });

      // re-render so inputs disable
      renderTimed();

      // auto-advance if not last
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

  // nav handlers
  $("prevBtn").onclick = () => { state.currentIndex -= 1; renderTimed(); };
  $("nextBtn").onclick = () => { state.currentIndex += 1; renderTimed(); };
  $("finishBtn").onclick = () => showResults();

  attachQuestionHandlers(exam);

  // start timer for current question
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
  // stop any timers just in case
  for (const k of Object.keys(state.timers)) clearInterval(state.timers[k]);
  state.timers = {};
}


function showResults() {
  // stop all timers
  for (const k of Object.keys(state.timers)) {
    clearInterval(state.timers[k]);
  }
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

    <p class="muted small">Tip: use “Show answer” on questions to review.</p>
  `;

  // Scroll to results
  results.scrollIntoView({ behavior: "smooth" });
}

async function startExam() {
  resetAll();

  if (!DATA) await loadQuestions();

  state.mode = $("mode").value;
  state.version = $("version").value;
  state.count = parseInt($("count").value, 10);
  state.studyMode = $("studyMode").value;

  state.examQs = buildExamSet(DATA.questions, state.version, state.count);

  // If study mode is auto-answer, do it immediately
  if (state.studyMode === "auto_answer_all") {
    autoAnswerAllCorrect();
  }

  if (state.mode === "timed") renderTimed();
  else renderUntimed();
}

$("startBtn").addEventListener("click", startExam);
$("resetBtn").addEventListener("click", resetAll);

// initial load
loadQuestions().catch(err => {
  console.error(err);
  alert("Failed to load questions.json. Make sure it exists in the repo root.");
});