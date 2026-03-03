const EXAM_SECONDS_PER_Q = 90;

let DATA = null;
let state = {
  mode: "timed",
  version: "A",
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

function setsEqual(aSet, bSet) {
  if (aSet.size !== bSet.size) return false;
  for (const v of aSet) if (!bSet.has(v)) return false;
  return true;
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

    const singleAnswer = q.correct_answer ?? q.answer ?? null;
    const multiAnswers = Array.isArray(q.correct_answers) ? q.correct_answers : null;

    if (!domainCounters[domain]) domainCounters[domain] = 0;
    domainCounters[domain] += 1;

    const slug = String(domain).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const id = q.id ?? `${slug || "q"}-${String(domainCounters[domain]).padStart(3, "0")}`;

    const isMulti = Boolean(multiAnswers) || /\(select all that apply\)/i.test(question);

    const incorrect = Array.isArray(q.incorrect_answers) ? q.incorrect_answers : [];

    let correctAnswers = null;
    if (isMulti) {
      if (multiAnswers) {
        correctAnswers = multiAnswers.map(x => String(x ?? "").trim()).filter(Boolean);
      } else if (singleAnswer) {
        correctAnswers = String(singleAnswer).split(",").map(s => s.trim()).filter(Boolean);
      } else {
        correctAnswers = [];
      }
      const seen = new Set();
      correctAnswers = correctAnswers.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
    }

    out.push({
      id,
      domain,
      question,
      answer: isMulti ? null : singleAnswer,
      incorrect_answers: incorrect,
      isMulti,
      correct_answers: correctAnswers,
    });
  }

  return out.filter(x => x.question && (x.isMulti ? (x.correct_answers && x.correct_answers.length > 0) : x.answer));
}

// Build choices from the provided incorrect answers (randomized) + correct answer
function buildChoicesFromProvided(q) {
  if (q.isMulti) {
    const pool = [];

    const addToken = (t) => {
      const s = String(t ?? "").trim();
      if (!s) return;
      if (!pool.includes(s)) pool.push(s);
    };

    (q.correct_answers || []).forEach(addToken);

    (q.incorrect_answers || []).forEach(v => {
      String(v ?? "")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean)
        .forEach(addToken);
    });

    return shuffle(pool);
  }

  const incorrect = Array.isArray(q.incorrect_answers) ? q.incorrect_answers : [];
  const uniq = [];
  for (const opt of incorrect) {
    const t = String(opt ?? "").trim();
    if (!t) continue;
    if (t === q.answer) continue;
    if (!uniq.includes(t)) uniq.push(t);
  }

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
  setFloatingFinishVisible(false);
}

function setFloatingFinishVisible(visible) {
  const btn = document.querySelector(".finishExamFloating");
  if (!btn) return;
  btn.style.display = visible ? "block" : "none";
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

  if (q.isMulti) {
    const selected = new Set(a?.selected || []);
    const lockedOptions = new Set(a?.lockedOptions || []);
    const isChecked = selected.has(choiceText);
    const isDisabled = lockedOptions.has(choiceText) || a?.expired;

    return `
      <label class="choice">
        <input type="checkbox" name="q_${qid}" value="${escapeHtml(choiceText)}" ${isChecked ? "checked" : ""} ${isDisabled ? "disabled" : ""} />
        <span>${escapeHtml(choiceText)}</span>
      </label>
    `;
  }

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
  container.querySelectorAll("input[type=radio], input[type=checkbox]").forEach(inp => {
    inp.addEventListener("change", (e) => {
      const qid = e.target.name.replace("q_", "");
      const q = state.examQs.find(x => x.id === qid);
      if (!q) return;

      if (q.isMulti) {
        const choice = e.target.value;

        if (!state.answers[qid]) {
          state.answers[qid] = { selected: [], correct: false, locked: false, expired: false, lockedOptions: [] };
        }

        const selected = new Set(state.answers[qid].selected || []);
        const lockedOptions = new Set(state.answers[qid].lockedOptions || []);

        if (lockedOptions.has(choice) || state.answers[qid].expired) return;

        if (e.target.checked) selected.add(choice);

        // Lock this option so it cannot be toggled again
        lockedOptions.add(choice);

        const correctSet = new Set(q.correct_answers || []);
        const isCorrectNow = setsEqual(selected, correctSet);

        state.answers[qid] = {
          ...state.answers[qid],
          selected: Array.from(selected),
          lockedOptions: Array.from(lockedOptions),
          correct: isCorrectNow,
        };

        if (state.mode === "timed") renderTimed();
        else renderUntimed();
        return;
      }

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
        <div><strong>${escapeHtml(q.isMulti ? (q.correct_answers || []).join(", ") : q.answer)}</strong></div>
        ${selected ? `<div class="muted small" style="margin-top:8px;">Your answer: ${escapeHtml(Array.isArray(selected) ? selected.join(", ") : selected)}</div>` : ""}
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
      if (q.isMulti) {
        if (!state.answers[qid]) state.answers[qid] = { selected: [], correct: false, locked: false, expired: false, lockedOptions: [] };
        state.answers[qid].expired = true;
        if (state.timers[qid]) {
          clearInterval(state.timers[qid]);
          delete state.timers[qid];
        }
      } else {
        lockQuestion(qid, { expired: true });
      }
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
          
        </div>
      </div>
      <hr/>
      ${renderQuestionCard(q, true)}
    </section>
  `;

  $("prevBtn").onclick = () => { state.currentIndex -= 1; renderTimed(); };
  $("nextBtn").onclick = () => { state.currentIndex += 1; renderTimed(); };
  
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
          
        </div>
      </div>
      <hr/>
      ${state.examQs.map(q => renderQuestionCard(q, false)).join("")}
    </section>
  `;

  
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

    const hasSelection = Array.isArray(a?.selected) ? a.selected.length > 0 : Boolean(a?.selected);
    const isLocked = Boolean(a?.locked) || Boolean(a?.expired) || (q.isMulti && (a?.lockedOptions?.length > 0));
    if (hasSelection || isLocked) {
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
  state.examQs = buildExamSet(allQs, state.version, allQs.length);

  setFloatingFinishVisible(true);

  if (state.studyMode === "auto_answer_all") {
    autoAnswerAllCorrect();
  }

  if (state.mode === "timed") renderTimed();
  else renderUntimed();
}

// Wire buttons
$("startBtn").addEventListener("click", startExam);
$("resetBtn").addEventListener("click", resetAll);


// Initial hint load for exam1.json (optional). If it fails, UI still works.
loadQuestions("exam1.json").catch(() => {});


// Hide floating finish until an exam is started
setFloatingFinishVisible(false);
