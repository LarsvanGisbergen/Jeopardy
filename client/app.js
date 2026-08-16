// @ts-check
"use strict";

/** @typedef {"draft" | "ready" | "archived"} PackStatus */

/**
 * @typedef {{
 *   question: string;
 *   answer: string;
 *   value: number;
 *   dailyDouble: boolean;
 * }} Clue
 */

/**
 * @typedef {{
 *   prompt: string;
 *   min: number;
 *   max: number;
 *   answer: number;
 *   step: number;
 *   incorrectMultiplier: number;
 * }} EliminationQuestion
 */

/**
 * @typedef {{
 *   name: string;
 *   clues: Clue[];
 * }} Category
 */

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   status: PackStatus;
 *   createdAt: string;
 *   updatedAt: string;
 *   board: {
 *     rows: number;
 *     cols: number;
 *     categories: Category[];
 *   };
 *   settings: {
 *     eliminationRound: {
 *       questions: EliminationQuestion[];
 *     };
 *   };
 * }} Pack
 */

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   status: PackStatus;
 *   updatedAt: string;
 *   parseError?: string;
 * }} PackListItem
 */

const app = document.getElementById("app");
if (!app) {
  throw new Error("App root was not found.");
}

/** @template T */
function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
  return /** @type {T} */ (value);
}

/**
 * @template T
 * @param {string} selector
 * @param {ParentNode} [parent]
 */
function q(selector, parent = document) {
  return /** @type {T | null} */ (parent.querySelector(selector));
}

/**
 * @template T
 * @param {string} selector
 * @param {ParentNode} [parent]
 */
function qa(selector, parent = document) {
  return /** @type {T[]} */ ([...parent.querySelectorAll(selector)]);
}

/**
 * @template T
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<T>}
 */
async function requestJson(url, init) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return data;
}

/**
 * @param {Pack} pack
 */
function normalizePack(pack) {
  if (!pack.settings) {
    pack.settings = /** @type {Pack["settings"]} */ ({ eliminationRound: { questions: [] } });
  }
  if (!pack.settings.eliminationRound) {
    pack.settings.eliminationRound = { questions: [] };
  }
  if (!Array.isArray(pack.settings.eliminationRound.questions)) {
    pack.settings.eliminationRound.questions = [];
  }
  pack.settings.eliminationRound.questions = pack.settings.eliminationRound.questions.map((question) => ({
    prompt: String(question?.prompt || ""),
    min: Number.isFinite(Number(question?.min)) ? Math.round(Number(question.min)) : 0,
    max: Number.isFinite(Number(question?.max)) ? Math.round(Number(question.max)) : 1000,
    answer: Number.isFinite(Number(question?.answer)) ? Math.round(Number(question.answer)) : 0,
    step: Number.isFinite(Number(question?.step)) && Number(question.step) > 0 ? Math.max(1, Math.round(Number(question.step))) : 1,
    incorrectMultiplier: Number.isFinite(Number(question?.incorrectMultiplier)) && Number(question.incorrectMultiplier) > 0
      ? Math.max(1, Math.round(Number(question.incorrectMultiplier)))
      : 1,
  }));
}

function setActiveNav() {
  const path = location.pathname.startsWith("/play") ? "/play" : "/build";
  qa("a[data-route-link]").forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    link.classList.toggle("active-link", link.dataset.routeLink === path);
  });
}

const buildState = {
  showArchived: false,
  /** @type {PackListItem[]} */
  packs: [],
  /** @type {Pack | null} */
  activePack: null,
  /** @type {{ valid: boolean; errors: string[]; warnings: string[] } | null} */
  validation: null,
};

const playState = {
  /** @type {PackListItem[]} */
  readyPacks: [],
  /** @type {Pack | null} */
  pack: null,
  selectedPackId: "",
  isLive: false,
  phase: "board",
  /** @type {{ id: string; name: string; score: number; }[]} */
  teams: [
    { id: crypto.randomUUID(), name: "Team 1", score: 0 },
    { id: crypto.randomUUID(), name: "Team 2", score: 0 },
  ],
  /** @type {Set<string>} */
  used: new Set(),
  awaitingNextRound: false,
  lastClueValue: 100,
  /** @type {{ c: number; r: number; clue: Clue; category: string } | null} */
  currentClue: null,
  eliminationIndex: 0,
  eliminationRevealed: false,
  eliminationStage: "guess",
  eliminationDraggingTeamId: "",
  /** @type {Map<string, number>} */
  eliminationAnswers: new Map(),
  /** @type {Map<string, number>} */
  lastPenaltyByTeam: new Map(),
  winnerName: "",
  winnerScore: 0,
  testMode: false,
};

const TEAM_COLORS = [
  "#2f80ed",
  "#ffbd2e",
  "#28d17c",
  "#8752eb",
  "#eb3b9c",
  "#13c7d9",
  "#ff6b2c",
  "#ef5b68",
  "#82c91e",
  "#9b6bff",
];

function formatScore(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString()}`;
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString();
}

function getTeamColor(team) {
  const index = Math.max(0, playState.teams.findIndex((candidate) => candidate.id === team.id));
  return TEAM_COLORS[index % TEAM_COLORS.length];
}

function getSortedTeams(teams = playState.teams) {
  const setupOrder = new Map(playState.teams.map((team, index) => [team.id, index]));
  return [...teams].sort((a, b) => b.score - a.score || Number(setupOrder.get(a.id)) - Number(setupOrder.get(b.id)));
}

/**
 * Capture leaderboard positions before a render so reordered rows can slide
 * smoothly from their previous position to their new one.
 * @param {HTMLElement} host
 */
function captureScoreOrder(host) {
  const positions = new Map();
  const order = [];
  qa("[data-score-team]", host).forEach((row) => {
    if (!(row instanceof HTMLElement) || !row.dataset.scoreTeam) return;
    order.push(row.dataset.scoreTeam);
    positions.set(row.dataset.scoreTeam, row.getBoundingClientRect());
  });
  return { positions, order };
}

/**
 * @param {HTMLElement} host
 * @param {{ positions: Map<string, DOMRect>; order: string[] }} previous
 */
function animateScoreOrder(host, previous) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const rows = qa("[data-score-team]", host).filter((row) => row instanceof HTMLElement);
  const nextOrder = rows.map((row) => /** @type {HTMLElement} */ (row).dataset.scoreTeam || "");
  if (!previous.order.length || previous.order.join("|") === nextOrder.join("|")) return;

  rows.forEach((row) => {
    if (!(row instanceof HTMLElement) || !row.dataset.scoreTeam) return;
    const from = previous.positions.get(row.dataset.scoreTeam);
    if (!from) return;
    const to = row.getBoundingClientRect();
    const deltaX = from.left - to.left;
    const deltaY = from.top - to.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
    row.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" },
      ],
      { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  });
}

async function renderRoute() {
  setActiveNav();
  if (location.pathname.startsWith("/play")) {
    await renderPlayView();
  } else {
    await renderBuildView();
  }
}

async function renderBuildView() {
  document.body.classList.remove("live-game-mode");
  document.body.classList.remove("play-route");
  const tpl = assert(/** @type {HTMLTemplateElement | null} */ (q("#build-view-template")), "Missing Build template.");
  app.innerHTML = "";
  app.appendChild(tpl.content.cloneNode(true));
  await refreshPackList();
  bindBuildCreateActions();
  renderPackList();
  renderEditorPanel();
}

function bindBuildCreateActions() {
  const createBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#create-pack-btn")), "Create button missing.");
  createBtn.addEventListener("click", async () => {
    const numericInputs = qa('input[type="number"]', app);
    const invalidInput = numericInputs.find((input) => input instanceof HTMLInputElement
      && (!input.checkValidity() || !Number.isInteger(Number(input.value))));
    if (invalidInput instanceof HTMLInputElement) {
      invalidInput.reportValidity();
      invalidInput.focus();
      return;
    }
    const title = assert(/** @type {HTMLInputElement | null} */ (q("#new-pack-title")), "Missing title input.").value;
    const rows = Number(assert(/** @type {HTMLInputElement | null} */ (q("#new-pack-rows")), "Missing rows input.").value);
    const cols = Number(assert(/** @type {HTMLInputElement | null} */ (q("#new-pack-cols")), "Missing cols input.").value);
    const startValue = Number(assert(/** @type {HTMLInputElement | null} */ (q("#new-pack-start-value")), "Missing start value input.").value);
    const valueStep = Number(assert(/** @type {HTMLInputElement | null} */ (q("#new-pack-step-value")), "Missing step input.").value);

    try {
      const { pack } = await requestJson("/api/packs", {
        method: "POST",
        body: JSON.stringify({ title, rows, cols, startValue, valueStep }),
      });
      normalizePack(pack);
      buildState.activePack = pack;
      buildState.validation = null;
      await refreshPackList();
      renderPackList();
      renderEditorPanel();
    } catch (error) {
      alert(`Create failed: ${String(error)}`);
    }
  });

  const archiveToggle = assert(/** @type {HTMLInputElement | null} */ (q("#show-archived-toggle")), "Archived toggle missing.");
  archiveToggle.checked = buildState.showArchived;
  archiveToggle.addEventListener("change", () => {
    buildState.showArchived = archiveToggle.checked;
    renderPackList();
  });
}

async function refreshPackList() {
  try {
    const data = await requestJson("/api/packs");
    buildState.packs = data.packs || [];
  } catch (error) {
    console.error(error);
    buildState.packs = [];
  }
}

function renderPackList() {
  const list = assert(/** @type {HTMLDivElement | null} */ (q("#pack-list")), "Pack list missing.");
  list.innerHTML = "";
  const packs = buildState.packs.filter((pack) => buildState.showArchived || pack.status !== "archived");
  if (packs.length === 0) {
    list.innerHTML = `<p class="muted">No packs found. Create your first pack above.</p>`;
    return;
  }

  for (const pack of packs) {
    const item = document.createElement("div");
    item.className = "pack-item";
    const isActive = buildState.activePack?.id === pack.id;
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(pack.title || "Untitled Pack")}</strong><br />
        <span class="status-chip status-${pack.status}">${pack.status.toUpperCase()}</span>
        <small class="muted"> Updated ${new Date(pack.updatedAt).toLocaleString()}</small>
        ${pack.parseError ? `<p class="validation-error">${escapeHtml(pack.parseError)}</p>` : ""}
      </div>
      <div class="dialog-actions">
        <button class="button ${isActive ? "button-primary" : ""}" data-pack-id="${pack.id}">
          ${isActive ? "Editing" : "Edit"}
        </button>
        <button class="button" data-delete-pack-id="${pack.id}" title="Delete this pack">Delete</button>
      </div>
    `;
    list.appendChild(item);
  }

  qa("button[data-pack-id]", list).forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) {
      return;
    }
    btn.addEventListener("click", async () => {
      const id = btn.dataset.packId;
      if (!id) {
        return;
      }
      try {
        const { pack } = await requestJson(`/api/packs/${encodeURIComponent(id)}`);
        normalizePack(pack);
        buildState.activePack = pack;
        buildState.validation = null;
        renderPackList();
        renderEditorPanel();
      } catch (error) {
        alert(`Could not load pack: ${String(error)}`);
      }
    });
  });

  qa("button[data-delete-pack-id]", list).forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) {
      return;
    }
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deletePackId;
      if (!id) {
        return;
      }
      const ok = window.confirm("Delete this pack permanently?");
      if (!ok) {
        return;
      }
      try {
        await requestJson(`/api/packs/delete?id=${encodeURIComponent(id)}`);
        if (buildState.activePack?.id === id) {
          buildState.activePack = null;
          buildState.validation = null;
        }
        await refreshPackList();
        renderPackList();
        renderEditorPanel();
      } catch (error) {
        alert(`Delete failed: ${String(error)}`);
      }
    });
  });
}

function renderEditorPanel() {
  const panel = assert(/** @type {HTMLElement | null} */ (q("#editor-panel")), "Editor panel missing.");
  const pack = buildState.activePack;
  if (!pack) {
    panel.innerHTML = `<h3>Editor</h3><p class="muted">Pick a pack to edit.</p>`;
    return;
  }
  normalizePack(pack);

  panel.innerHTML = `
    <h3>Editor: ${escapeHtml(pack.title)}</h3>
    <div class="editor-grid">
      <div class="editor-header">
        <label>Pack Title
          <input id="pack-title-input" type="text" value="${escapeAttr(pack.title)}" />
        </label>
        <label>Status
          <select id="pack-status-select">
            ${["draft", "ready", "archived"].map((status) => `<option value="${status}" ${pack.status === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </label>
        <div class="checkbox-row" style="align-self:end;">
          <button id="save-pack-btn" class="button button-primary">Save Draft</button>
          <button id="validate-pack-btn" class="button">Validate</button>
          <button id="set-status-btn" class="button">Set Status</button>
        </div>
      </div>

      <div>
        <h4>Validation</h4>
        <div id="validation-panel">
          ${renderValidationHtml()}
        </div>
      </div>

      <div class="board-editor">
        <h4>Board (${pack.board.cols} categories x ${pack.board.rows} clues)</h4>
        <div class="category-grid" id="category-grid" style="grid-template-columns: repeat(${pack.board.cols}, minmax(220px, 1fr));"></div>
      </div>

      <div class="board-editor">
        <div class="split-heading">
          <h4>Elimination Round (Numeric Slider Questions)</h4>
          <button id="add-elimination-question-btn" class="button">Add Slider Question</button>
        </div>
        <div id="elimination-editor-list" class="category-grid"></div>
      </div>
    </div>
  `;

  const categoryGrid = assert(/** @type {HTMLElement | null} */ (q("#category-grid", panel)), "Category grid missing.");
  pack.board.categories.forEach((category, cIndex) => {
    const col = document.createElement("section");
    col.className = "category-column";
    col.innerHTML = `
      <label>Category ${cIndex + 1}
        <input type="text" data-type="category-name" data-col="${cIndex}" value="${escapeAttr(category.name)}" />
      </label>
      <div id="clues-${cIndex}"></div>
    `;
    categoryGrid.appendChild(col);
    const clueHost = assert(/** @type {HTMLElement | null} */ (q(`#clues-${cIndex}`, col)), "Clue host missing.");

    category.clues.forEach((clue, rIndex) => {
      const clueCard = document.createElement("article");
      clueCard.className = "clue-editor";
      clueCard.innerHTML = `
        <strong>Row ${rIndex + 1}</strong>
        <label>Value
          <input type="number" min="1" step="1" data-type="clue-value" data-col="${cIndex}" data-row="${rIndex}" value="${clue.value}" />
        </label>
        <label>Question
          <textarea data-type="clue-question" data-col="${cIndex}" data-row="${rIndex}">${escapeHtml(clue.question)}</textarea>
        </label>
        <label>Answer
          <textarea data-type="clue-answer" data-col="${cIndex}" data-row="${rIndex}">${escapeHtml(clue.answer)}</textarea>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" data-type="clue-dd" data-col="${cIndex}" data-row="${rIndex}" ${clue.dailyDouble ? "checked" : ""} />
          Daily Double
        </label>
      `;
      clueHost.appendChild(clueCard);
    });
  });

  const eliminationHost = assert(/** @type {HTMLElement | null} */ (q("#elimination-editor-list", panel)), "Elimination editor missing.");
  pack.settings.eliminationRound.questions.forEach((question, index) => {
    const card = document.createElement("article");
    card.className = "clue-editor";
    card.innerHTML = `
      <div class="split-heading">
        <strong>Slider Question ${index + 1}</strong>
        <button class="button" data-remove-elim="${index}">Remove</button>
      </div>
      <label>Prompt
        <textarea data-elim="prompt" data-idx="${index}">${escapeHtml(question.prompt)}</textarea>
      </label>
      <div class="create-pack-grid">
        <label>Min
          <input type="number" step="1" data-elim="min" data-idx="${index}" value="${question.min}" />
        </label>
        <label>Max
          <input type="number" step="1" data-elim="max" data-idx="${index}" value="${question.max}" />
        </label>
        <label>Correct Answer
          <input type="number" step="1" data-elim="answer" data-idx="${index}" value="${question.answer}" />
        </label>
        <label>Step
          <input type="number" min="1" step="1" data-elim="step" data-idx="${index}" value="${question.step}" />
        </label>
        <label>Incorrect Multiplier
          <input type="number" required min="1" step="1" data-elim="incorrectMultiplier" data-idx="${index}" value="${question.incorrectMultiplier}" />
        </label>
      </div>
    `;
    eliminationHost.appendChild(card);
  });

  bindEditorActions(panel, pack);
}

function renderValidationHtml() {
  const validation = buildState.validation;
  if (!validation) {
    return `<p class="muted">Run validation to check if this pack can be marked Ready.</p>`;
  }
  const parts = [];
  parts.push(`<p><strong>${validation.valid ? "Valid for Ready" : "Not Ready yet"}</strong></p>`);
  if (validation.errors.length) {
    parts.push("<ul class=\"validation-list\">");
    validation.errors.forEach((item) => parts.push(`<li class="validation-error">${escapeHtml(item)}</li>`));
    parts.push("</ul>");
  }
  if (validation.warnings.length) {
    parts.push("<ul class=\"validation-list\">");
    validation.warnings.forEach((item) => parts.push(`<li class="validation-warning">${escapeHtml(item)}</li>`));
    parts.push("</ul>");
  }
  if (!validation.errors.length && !validation.warnings.length) {
    parts.push("<p class=\"muted\">No issues found.</p>");
  }
  return parts.join("");
}

/**
 * @param {HTMLElement} panel
 * @param {Pack} pack
 */
function bindEditorActions(panel, pack) {
  const titleInput = assert(/** @type {HTMLInputElement | null} */ (q("#pack-title-input", panel)), "Missing title input.");
  const statusSelect = assert(/** @type {HTMLSelectElement | null} */ (q("#pack-status-select", panel)), "Missing status select.");
  const saveBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#save-pack-btn", panel)), "Missing save button.");
  const validateBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#validate-pack-btn", panel)), "Missing validate button.");
  const setStatusBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#set-status-btn", panel)), "Missing status button.");
  const addElimBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#add-elimination-question-btn", panel)), "Missing elimination add button.");

  const numericInputsAreValid = () => {
    const inputs = qa('input[type="number"]', panel);
    const invalid = inputs.find((input) => input instanceof HTMLInputElement
      && ((input.hasAttribute("required") && !input.value.trim())
        || (input.value.trim() && (!input.checkValidity() || !Number.isInteger(Number(input.value))))));
    if (invalid instanceof HTMLInputElement) {
      invalid.reportValidity();
      invalid.focus();
      return false;
    }
    return true;
  };

  const syncFromInputs = () => {
    pack.title = titleInput.value.trim() || "Untitled Pack";
    pack.board.categories.forEach((category, cIndex) => {
      const catInput = /** @type {HTMLInputElement | null} */ (q(`input[data-type="category-name"][data-col="${cIndex}"]`, panel));
      if (catInput) {
        category.name = catInput.value;
      }
      category.clues.forEach((clue, rIndex) => {
        const valueInput = /** @type {HTMLInputElement | null} */ (q(`input[data-type="clue-value"][data-col="${cIndex}"][data-row="${rIndex}"]`, panel));
        const questionInput = /** @type {HTMLTextAreaElement | null} */ (q(`textarea[data-type="clue-question"][data-col="${cIndex}"][data-row="${rIndex}"]`, panel));
        const answerInput = /** @type {HTMLTextAreaElement | null} */ (q(`textarea[data-type="clue-answer"][data-col="${cIndex}"][data-row="${rIndex}"]`, panel));
        const ddInput = /** @type {HTMLInputElement | null} */ (q(`input[data-type="clue-dd"][data-col="${cIndex}"][data-row="${rIndex}"]`, panel));

        if (valueInput) clue.value = Math.max(1, Number(valueInput.value) || clue.value);
        if (questionInput) clue.question = questionInput.value;
        if (answerInput) clue.answer = answerInput.value;
        if (ddInput) clue.dailyDouble = ddInput.checked;
      });
    });
    pack.settings.eliminationRound.questions = pack.settings.eliminationRound.questions.map((question, index) => {
      const promptInput = /** @type {HTMLTextAreaElement | null} */ (q(`textarea[data-elim="prompt"][data-idx="${index}"]`, panel));
      const minInput = /** @type {HTMLInputElement | null} */ (q(`input[data-elim="min"][data-idx="${index}"]`, panel));
      const maxInput = /** @type {HTMLInputElement | null} */ (q(`input[data-elim="max"][data-idx="${index}"]`, panel));
      const answerInput = /** @type {HTMLInputElement | null} */ (q(`input[data-elim="answer"][data-idx="${index}"]`, panel));
      const stepInput = /** @type {HTMLInputElement | null} */ (q(`input[data-elim="step"][data-idx="${index}"]`, panel));
      const multiplierInput = /** @type {HTMLInputElement | null} */ (q(`input[data-elim="incorrectMultiplier"][data-idx="${index}"]`, panel));
      return {
        prompt: promptInput ? promptInput.value : question.prompt,
        min: minInput ? Number(minInput.value) : question.min,
        max: maxInput ? Number(maxInput.value) : question.max,
        answer: answerInput ? Number(answerInput.value) : question.answer,
        step: stepInput ? Math.max(1, Number(stepInput.value) || 1) : question.step,
        incorrectMultiplier: multiplierInput ? Number(multiplierInput.value) : question.incorrectMultiplier,
      };
    });
  };

  addElimBtn.addEventListener("click", () => {
    pack.settings.eliminationRound.questions.push({
      prompt: "",
      min: 0,
      max: 1000,
      answer: 500,
      step: 1,
      incorrectMultiplier: 1,
    });
    renderEditorPanel();
  });

  qa("button[data-remove-elim]", panel).forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.addEventListener("click", () => {
      const idx = Number(button.dataset.removeElim);
      if (!Number.isInteger(idx)) {
        return;
      }
      pack.settings.eliminationRound.questions.splice(idx, 1);
      renderEditorPanel();
    });
  });

  saveBtn.addEventListener("click", async () => {
    if (!numericInputsAreValid()) return;
    try {
      syncFromInputs();
      pack.status = pack.status === "ready" ? "draft" : pack.status;
      const { pack: saved } = await requestJson(`/api/packs/${encodeURIComponent(pack.id)}`, {
        method: "PUT",
        body: JSON.stringify(pack),
      });
      buildState.activePack = saved;
      await refreshPackList();
      renderPackList();
      renderEditorPanel();
    } catch (error) {
      alert(`Save failed: ${String(error)}`);
    }
  });

  validateBtn.addEventListener("click", async () => {
    if (!numericInputsAreValid()) return;
    try {
      syncFromInputs();
      await requestJson(`/api/packs/${encodeURIComponent(pack.id)}`, {
        method: "PUT",
        body: JSON.stringify(pack),
      });
      buildState.validation = await requestJson(`/api/packs/${encodeURIComponent(pack.id)}/validate`, {
        method: "POST",
      });
      const validationPanel = q("#validation-panel", panel);
      if (validationPanel) {
        validationPanel.innerHTML = renderValidationHtml();
      }
    } catch (error) {
      alert(`Validation failed: ${String(error)}`);
    }
  });

  setStatusBtn.addEventListener("click", async () => {
    if (!numericInputsAreValid()) return;
    const target = /** @type {PackStatus} */ (statusSelect.value);
    try {
      syncFromInputs();
      await requestJson(`/api/packs/${encodeURIComponent(pack.id)}`, {
        method: "PUT",
        body: JSON.stringify(pack),
      });
      const response = await fetch(`/api/packs/${encodeURIComponent(pack.id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      const data = await response.json();
      if (!response.ok) {
        buildState.validation = {
          valid: false,
          errors: data.errors || [data.error || "Status change failed."],
          warnings: data.warnings || [],
        };
        const validationPanel = q("#validation-panel", panel);
        if (validationPanel) {
          validationPanel.innerHTML = renderValidationHtml();
        }
        throw new Error(data.error || "Status change failed.");
      }
      buildState.activePack = data.pack;
      buildState.validation = null;
      await refreshPackList();
      renderPackList();
      renderEditorPanel();
    } catch (error) {
      alert(`Status update failed: ${String(error)}`);
    }
  });
}

async function renderPlayView() {
  const tpl = assert(/** @type {HTMLTemplateElement | null} */ (q("#play-view-template")), "Missing Play template.");
  app.innerHTML = "";
  app.appendChild(tpl.content.cloneNode(true));
  playState.isLive = false;
  document.body.classList.remove("live-game-mode");
  document.body.classList.add("play-route");

  try {
    const data = await requestJson("/api/packs?status=ready");
    playState.readyPacks = data.packs || [];
  } catch (error) {
    playState.readyPacks = [];
    console.error(error);
  }

  renderPlaySetup();
  bindDialogEvents();
  bindEliminationEvents();
}

function renderPlaySetup() {
  const packCards = assert(/** @type {HTMLDivElement | null} */ (q("#play-pack-cards")), "Pack cards missing.");
  const teamList = assert(/** @type {HTMLDivElement | null} */ (q("#team-list")), "Team list missing.");
  const addTeamBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#add-team-btn")), "Add team button missing.");
  const loadPackBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#load-pack-btn")), "Load pack button missing.");
  const testModeToggle = assert(/** @type {HTMLInputElement | null} */ (q("#test-mode-toggle")), "Test mode toggle missing.");

  if (!playState.readyPacks.some((pack) => pack.id === playState.selectedPackId)) {
    playState.selectedPackId = playState.readyPacks[0]?.id || "";
  }
  renderReadyPackCards(packCards);

  renderTeamInputs(teamList);
  testModeToggle.checked = Boolean(playState.testMode);
  testModeToggle.oninput = () => {
    playState.testMode = testModeToggle.checked;
  };

  addTeamBtn.onclick = () => {
    if (playState.teams.length >= TEAM_COLORS.length) return;
    playState.teams.push({ id: crypto.randomUUID(), name: `Team ${playState.teams.length + 1}`, score: 0 });
    renderTeamInputs(teamList);
    addTeamBtn.disabled = playState.teams.length >= TEAM_COLORS.length;
  };
  addTeamBtn.disabled = playState.teams.length >= TEAM_COLORS.length;

  loadPackBtn.onclick = async () => {
    const id = playState.selectedPackId;
    if (!id) {
      return;
    }
    try {
      const { pack } = await requestJson(`/api/packs/${encodeURIComponent(id)}`);
      normalizePack(pack);
      playState.pack = pack;
      playState.isLive = true;
      playState.phase = "board";
      document.body.classList.add("live-game-mode");
      playState.used = new Set();
      playState.awaitingNextRound = false;
      playState.eliminationIndex = 0;
      playState.eliminationRevealed = false;
      playState.eliminationStage = "guess";
      playState.eliminationDraggingTeamId = "";
      playState.eliminationAnswers = new Map();
      playState.winnerName = "";
      playState.winnerScore = 0;
      playState.teams = playState.teams.map((team, index) => ({
        ...team,
        name: team.name.trim() || `Team ${index + 1}`,
        score: 0,
      }));
      playState.lastClueValue = 100;
      renderPlayPhase();
    } catch (error) {
      alert(`Failed to load pack: ${String(error)}`);
    }
  };
  loadPackBtn.disabled = !playState.selectedPackId;
}

/**
 * @param {HTMLElement} container
 */
function renderReadyPackCards(container) {
  container.innerHTML = "";
  if (!playState.readyPacks.length) {
    container.innerHTML = `<p class="setup-empty muted">No ready packs found. Add a pack and mark it ready to start.</p>`;
    return;
  }
  playState.readyPacks.forEach((pack) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `play-pack-card ${pack.id === playState.selectedPackId ? "selected" : ""}`;
    card.dataset.readyPackId = pack.id;
    card.innerHTML = `
      <span class="pack-card-icon" aria-hidden="true"><img class="pack-logo" src="/icons/pack-logo.svg" alt="◫"></span>
      <span class="pack-card-copy">
        <strong>${escapeHtml(pack.title || "Untitled Pack")}</strong>
        <span class="muted">Ready to play</span>
      </span>
      <span class="pack-selected-check" aria-hidden="true">✓</span>
    `;
    container.appendChild(card);
  });
  qa("button[data-ready-pack-id]", container).forEach((card) => {
    if (!(card instanceof HTMLButtonElement)) return;
    card.addEventListener("click", async () => {
      playState.selectedPackId = card.dataset.readyPackId || "";
      renderReadyPackCards(container);
      const startButton = q("#load-pack-btn");
      if (startButton instanceof HTMLButtonElement) startButton.disabled = !playState.selectedPackId;
      try {
        const { pack } = await requestJson(`/api/packs/${encodeURIComponent(playState.selectedPackId)}`);
        const copy = q(`[data-ready-pack-id="${playState.selectedPackId}"] .pack-card-copy`, container);
        if (copy instanceof HTMLElement) {
          copy.innerHTML = `
            <strong>${escapeHtml(pack.title || "Untitled Pack")}</strong>
            <span class="muted">${pack.board.rows * pack.board.cols} questions <b>•</b> ${pack.board.cols} categories</span>
          `;
        }
      } catch {
        // The start action reports pack loading failures; keep setup selection responsive.
      }
    });
  });
  qa("button[data-ready-pack-id]", container).forEach((card) => {
    if (!(card instanceof HTMLButtonElement)) return;
    const id = card.dataset.readyPackId;
    if (!id) return;
    requestJson(`/api/packs/${encodeURIComponent(id)}`).then(({ pack }) => {
      const copy = q(".pack-card-copy", card);
      if (!(copy instanceof HTMLElement)) return;
      copy.innerHTML = `
        <strong>${escapeHtml(pack.title || "Untitled Pack")}</strong>
        <span class="muted">${pack.board.rows * pack.board.cols} questions <b>•</b> ${pack.board.cols} categories</span>
      `;
    }).catch(() => undefined);
  });
}

/**
 * @param {HTMLElement} container
 */
function renderTeamInputs(container) {
  container.innerHTML = "";
  playState.teams.forEach((team, index) => {
    const row = document.createElement("div");
    row.className = "team-row";
    const color = getTeamColor(team);
    row.innerHTML = `
      <span class="setup-team-icon" style="--team-color:${color}" aria-hidden="true"><img class="team-logo" src="/icons/team.svg" alt="♙"></span>
      <input type="text" aria-label="Team ${index + 1} name" data-team-id="${team.id}" value="${escapeAttr(team.name)}" />
      <button class="button team-delete-button" data-remove-team="${team.id}" ${playState.teams.length <= 1 ? "disabled" : ""} title="Remove ${escapeAttr(team.name)}" aria-label="Remove ${escapeAttr(team.name)}"><img class="remove-team-icon" src="/icons/trash.svg" alt="⌫"></button>
    `;
    container.appendChild(row);
  });

  qa("input[data-team-id]", container).forEach((input) => {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    input.addEventListener("input", () => {
      const id = input.dataset.teamId;
      const target = playState.teams.find((team) => team.id === id);
      if (target) {
        target.name = input.value;
      }
    });
  });

  qa("button[data-remove-team]", container).forEach((btn) => {
    if (!(btn instanceof HTMLButtonElement)) {
      return;
    }
    btn.addEventListener("click", () => {
      const id = btn.dataset.removeTeam;
      if (!id) {
        return;
      }
      playState.teams = playState.teams.filter((team) => team.id !== id);
      renderTeamInputs(container);
      const addButton = q("#add-team-btn");
      if (addButton instanceof HTMLButtonElement) addButton.disabled = playState.teams.length >= TEAM_COLORS.length;
    });
  });
}

function renderBoard() {
  const boardPanel = assert(/** @type {HTMLElement | null} */ (q("#play-board-panel")), "Board panel missing.");
  const boardEl = assert(/** @type {HTMLElement | null} */ (q("#game-board")), "Board missing.");
  const hostScorebar = assert(/** @type {HTMLElement | null} */ (q("#host-scorebar")), "Host score bar missing.");
  const titleEl = assert(/** @type {HTMLElement | null} */ (q("#active-pack-title")), "Title element missing.");
  const resetBtn = assert(/** @type {HTMLButtonElement | null} */ (q("#reset-board-btn")), "Reset board button missing.");

  const pack = playState.pack;
  if (!pack) {
    boardPanel.classList.add("hidden");
    playState.isLive = false;
    document.body.classList.remove("live-game-mode");
    return;
  }
  if (playState.phase !== "board") {
    boardPanel.classList.add("hidden");
    return;
  }

  boardPanel.classList.remove("hidden");
  titleEl.textContent = `${pack.title} (${pack.board.cols} x ${pack.board.rows})`;
  renderHostScorebar(hostScorebar);

  boardEl.innerHTML = "";
  boardEl.style.gridTemplateRows = `repeat(${pack.board.rows + 1}, minmax(0, 1fr))`;

  const header = document.createElement("div");
  header.className = "board-header-row";
  header.style.gridTemplateColumns = `repeat(${pack.board.cols}, minmax(0, 1fr))`;
  pack.board.categories.forEach((category) => {
    const cell = document.createElement("div");
    cell.className = "board-cell category";
    cell.textContent = category.name || "Unnamed";
    header.appendChild(cell);
  });
  boardEl.appendChild(header);

  for (let r = 0; r < pack.board.rows; r += 1) {
    const row = document.createElement("div");
    row.className = "board-values-row";
    row.style.gridTemplateColumns = `repeat(${pack.board.cols}, minmax(0, 1fr))`;
    for (let c = 0; c < pack.board.cols; c += 1) {
      const clue = pack.board.categories[c]?.clues[r];
      const key = `${c}:${r}`;
      const used = playState.used.has(key);
      const button = document.createElement("button");
      button.className = `board-cell value-btn ${used ? "used" : ""}`;
      button.textContent = used ? "USED" : `$${clue?.value ?? 0}`;
      button.disabled = used;
      button.addEventListener("click", () => openClue(c, r));
      row.appendChild(button);
    }
    boardEl.appendChild(row);
  }

  resetBtn.onclick = () => {
    playState.used = new Set();
    renderBoard();
  };
}

function renderPlayPhase() {
  const boardPanel = q("#play-board-panel");
  const eliminationPanel = q("#elimination-panel");
  const victoryPanel = q("#victory-panel");
  if (boardPanel instanceof HTMLElement) boardPanel.classList.add("hidden");
  if (eliminationPanel instanceof HTMLElement) eliminationPanel.classList.add("hidden");
  if (victoryPanel instanceof HTMLElement) victoryPanel.classList.add("hidden");

  if (playState.phase === "board") {
    renderBoard();
  } else if (playState.phase === "elimination") {
    renderEliminationRound();
  } else if (playState.phase === "victory") {
    renderVictory();
  }
}

function getActiveTeams() {
  return playState.teams.filter((team) => team.score > 0);
}

function getSortedActiveTeams() {
  return getSortedTeams(getActiveTeams());
}

function isBoardComplete() {
  const pack = playState.pack;
  if (!pack) return false;
  const total = pack.board.rows * pack.board.cols;
  return playState.used.size >= total;
}

/**
 * @param {HTMLElement} hostScorebar
 */
function renderHostScorebar(hostScorebar) {
  const previousScoreOrder = captureScoreOrder(hostScorebar);
  const correctScore = playState.lastClueValue;
  const incorrectPenalty = playState.lastClueValue / 2;
  const nextRoundButton = isBoardComplete()
    ? `<button id="next-round-btn" class="button button-primary" title="Proceed to elimination round">Start Next Round</button>`
    : "";
  hostScorebar.innerHTML = `
    <div class="host-scorebar-heading">
      <strong>TEAMS</strong>
    </div>
    <div class="host-scorebar-grid" id="host-scorebar-grid"></div>
    <div class="host-scorebar-footer">
      <span>Current:</span>
      <strong>${formatScore(correctScore)}</strong>
      ${nextRoundButton}
      ${playState.testMode ? '<button id="debug-use-all-btn" class="button button-small" title="Debug: use all board clues">Use All</button>' : ""}
    </div>
  `;
  const grid = assert(/** @type {HTMLElement | null} */ (q("#host-scorebar-grid", hostScorebar)), "Host score grid missing.");
  getSortedTeams().forEach((team) => {
    const row = document.createElement("div");
    row.className = "host-team-row";
    row.dataset.scoreTeam = team.id;
    const color = getTeamColor(team);
    row.innerHTML = `
      <div class="host-team-name">
        <span class="team-color-dot" style="background:${color}"></span>
        <h4>${escapeHtml(team.name.trim() || "Team")}</h4>
      </div>
      <strong class="team-score-number">${formatScore(team.score)}</strong>
      <div class="score-controls">
        <button class="button button-small" title="Subtract ${formatScore(incorrectPenalty)}" data-host-score="${team.id}" data-dir="minus">−</button>
        <button class="button button-small" title="Add ${formatScore(correctScore)}" data-host-score="${team.id}" data-dir="plus">＋</button>
      </div>
    `;
    grid.appendChild(row);
  });
  animateScoreOrder(hostScorebar, previousScoreOrder);

  qa("button[data-host-score]", hostScorebar).forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener("click", () => {
      const teamId = button.dataset.hostScore;
      const dir = button.dataset.dir;
      const target = playState.teams.find((team) => team.id === teamId);
      if (!target) return;
      if (dir === "minus") {
        target.score = Math.max(0, target.score - incorrectPenalty);
      } else {
        target.score += correctScore;
      }
      renderBoard();
    });
  });

  const useAllBtn = playState.testMode ? q("#debug-use-all-btn", hostScorebar) : null;
  if (useAllBtn instanceof HTMLButtonElement) {
    useAllBtn.addEventListener("click", () => {
      const pack = playState.pack;
      if (!pack) return;
      playState.used = new Set();
      for (let c = 0; c < pack.board.cols; c += 1) {
        for (let r = 0; r < pack.board.rows; r += 1) {
          playState.used.add(`${c}:${r}`);
        }
      }
      playState.awaitingNextRound = true;
      renderBoard();
    });
  }

  const nextRoundBtn = q("#next-round-btn", hostScorebar);
  if (nextRoundBtn instanceof HTMLButtonElement) {
    nextRoundBtn.addEventListener("click", () => {
      startEliminationRound();
    });
  }
}

function startEliminationRound() {
  const pack = playState.pack;
  if (!pack) return;
  const questions = pack.settings.eliminationRound.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    decideWinnerFromScores();
    return;
  }
  playState.phase = "elimination";
  playState.awaitingNextRound = false;
  playState.eliminationIndex = 0;
  playState.eliminationRevealed = false;
  playState.eliminationStage = "guess";
  playState.eliminationDraggingTeamId = "";
  playState.eliminationAnswers = new Map();
  renderPlayPhase();
}

function renderEliminationRound() {
  const panel = assert(/** @type {HTMLElement | null} */ (q("#elimination-panel")), "Elimination panel missing.");
  const pack = playState.pack;
  if (!pack) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const questions = pack.settings.eliminationRound.questions;
  if (!questions.length || playState.eliminationIndex >= questions.length) {
    decideWinnerFromScores();
    return;
  }
  const question = questions[playState.eliminationIndex];
  const activeTeams = getSortedActiveTeams();
  if (activeTeams.length <= 1) {
    decideWinnerFromScores();
    return;
  }

  const progress = assert(/** @type {HTMLElement | null} */ (q("#elimination-progress")), "Elimination progress missing.");
  const multiplier = assert(/** @type {HTMLElement | null} */ (q("#elimination-multiplier")), "Elimination multiplier missing.");
  const prompt = assert(/** @type {HTMLElement | null} */ (q("#elim-question-prompt")), "Elimination prompt missing.");
  const reveal = assert(/** @type {HTMLElement | null} */ (q("#elim-answer-reveal")), "Elimination reveal missing.");
  const minLabel = assert(/** @type {HTMLElement | null} */ (q("#elim-min-label")), "Elimination min label missing.");
  const maxLabel = assert(/** @type {HTMLElement | null} */ (q("#elim-max-label")), "Elimination max label missing.");
  const sliderStack = assert(/** @type {HTMLElement | null} */ (q("#team-slider-stack")), "Team slider stack missing.");
  const values = assert(/** @type {HTMLElement | null} */ (q("#elim-team-values")), "Elimination team values missing.");

  progress.textContent = `Question ${playState.eliminationIndex + 1} of ${questions.length}`;
  multiplier.textContent = `Multiplier × ${question.incorrectMultiplier}`;
  prompt.textContent = question.prompt || "(No elimination prompt entered)";
  reveal.textContent = formatNumber(question.answer);
  reveal.classList.toggle("hidden", !playState.eliminationRevealed);
  minLabel.textContent = String(question.min);
  maxLabel.textContent = String(question.max);

  sliderStack.innerHTML = "";
  values.innerHTML = "";
  activeTeams.forEach((team) => {
    const current = playState.eliminationAnswers.has(team.id) ? Number(playState.eliminationAnswers.get(team.id)) : question.min;
    playState.eliminationAnswers.set(team.id, current);
  });
  renderSharedSlider(sliderStack, question);

  bindSharedSliderDrag(sliderStack, question, () => undefined);
  renderEliminationTeamValues(values);
  updateEliminationActionButton();
}

/**
 * @param {HTMLElement} host
 * @param {EliminationQuestion} question
 */
function renderSharedSlider(host, question) {
  const activeTeams = getSortedActiveTeams();
  const denominator = question.max - question.min;
  const answerPct = denominator > 0 ? ((question.answer - question.min) / denominator) * 100 : 0;
  const laneRows = Math.max(1, Math.ceil(activeTeams.length / 2));
  host.style.setProperty("--lane-rows", String(laneRows));
  host.innerHTML = `
    <div class="shared-slider-track">
      <div class="shared-slider-answer ${playState.eliminationRevealed ? "" : "hidden"}" style="left:${Math.max(0, Math.min(100, answerPct))}%">
        <span class="shared-slider-answer-tag">Correct Answer<strong>${formatNumber(question.answer)}</strong></span>
      </div>
    </div>
  `;
  const track = assert(/** @type {HTMLElement | null} */ (q(".shared-slider-track", host)), "Shared slider track missing.");
  activeTeams.forEach((team, index) => {
    const guess = Number(playState.eliminationAnswers.get(team.id) ?? question.min);
    const pct = denominator > 0 ? ((guess - question.min) / denominator) * 100 : 0;
    const color = getTeamColor(team);
    const lane = Math.floor(index / 2) + 1;
    const compactLanes = window.innerHeight <= 760 || window.innerWidth <= 1180;
    const laneDistance = compactLanes ? 26 + lane * 22 : 42 + lane * 34;
    const laneClass = index % 2 === 0 ? "lane-above" : "lane-below";
    const pin = document.createElement("label");
    pin.className = `team-pin ${laneClass} ${playState.eliminationDraggingTeamId === team.id ? "is-dragging" : ""}`;
    pin.style.left = `${Math.max(0, Math.min(100, pct))}%`;
    pin.style.setProperty("--team-color", color);
    pin.style.setProperty("--lane-distance", `${laneDistance}px`);
    pin.dataset.elimTeam = team.id;
    pin.tabIndex = 0;
    pin.setAttribute("aria-label", `${team.name}: ${formatNumber(guess)}`);
    pin.innerHTML = `
      <span class="team-pin-connector"></span>
      <span class="team-pin-endpoint"></span>
      <span class="team-pin-tooltip">${formatNumber(guess)}</span>
      <span class="team-pin-marker"></span>
    `;
    track.appendChild(pin);
  });
}

/**
 * @param {HTMLElement} host
 * @param {EliminationQuestion} question
 * @param {() => void} onChange
 */
function bindSharedSliderDrag(host, question, onChange) {
  qa(".team-pin", host).forEach((pin) => {
    if (!(pin instanceof HTMLElement)) return;
    pin.addEventListener("pointerdown", (event) => {
      const teamId = pin.dataset.elimTeam;
      if (!teamId) return;
      const update = (clientX) => {
        const track = q(".shared-slider-track", host);
        if (!(track instanceof HTMLElement)) return;
        const rect = track.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const raw = question.min + pct * (question.max - question.min);
        const step = Math.max(1, Number(question.step) || 1);
        const stepped = Math.round(raw / step) * step;
        const value = Math.max(question.min, Math.min(question.max, stepped));
        playState.eliminationAnswers.set(teamId, value);
        playState.eliminationDraggingTeamId = teamId;
        renderSharedSlider(host, question);
        bindSharedSliderDrag(host, question, onChange);
        onChange();
      };
      const onMove = (moveEvent) => update(moveEvent.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        playState.eliminationDraggingTeamId = "";
        renderSharedSlider(host, question);
        bindSharedSliderDrag(host, question, onChange);
      };
      update(event.clientX);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });
}

async function applyEliminationScoring() {
  const pack = playState.pack;
  if (!pack) return;
  const question = pack.settings.eliminationRound.questions[playState.eliminationIndex];
  if (!question) return;
  playState.lastPenaltyByTeam = new Map();
  /** @type {{ teamId: string; from: number; to: number; penalty: number; }[]} */
  const changes = [];
  getActiveTeams().forEach((team) => {
    const guess = Number(playState.eliminationAnswers.get(team.id) ?? question.min);
    const penalty = Math.abs(guess - question.answer) * question.incorrectMultiplier;
    const from = team.score;
    const to = Math.max(0, team.score - penalty);
    const appliedPenalty = from - to;
    team.score = to;
    playState.lastPenaltyByTeam.set(team.id, appliedPenalty);
    changes.push({ teamId: team.id, from, to, penalty: appliedPenalty });
  });
  const values = q("#elim-team-values");
  if (values instanceof HTMLElement) {
    renderEliminationTeamValues(values);
  }
  await animateScoreDrops(changes);
  const slider = q("#team-slider-stack");
  if (slider instanceof HTMLElement) {
    renderSharedSlider(slider, question);
    bindSharedSliderDrag(slider, question, () => undefined);
  }
}

/**
 * @param {HTMLElement} host
 */
function renderEliminationTeamValues(host) {
  const previousScoreOrder = captureScoreOrder(host);
  host.innerHTML = "";
  host.insertAdjacentHTML("afterbegin", `<div class="host-scorebar-heading"><strong>TEAMS</strong></div>`);
  const visibleTeams = playState.teams.filter((team) => team.score > 0 || playState.lastPenaltyByTeam.has(team.id));
  getSortedTeams(visibleTeams).forEach((team) => {
    const hasPenalty = playState.lastPenaltyByTeam.has(team.id);
    const penalty = playState.lastPenaltyByTeam.get(team.id) || 0;
    const row = document.createElement("div");
    const color = getTeamColor(team);
    row.className = "host-team-row elim-score-card";
    row.dataset.scoreTeam = team.id;
    row.innerHTML = `
      <div class="elim-score-mainline">
        <div class="host-team-name">
          <span class="team-color-dot" style="background:${color}"></span>
          <h4>${escapeHtml(team.name)}</h4>
        </div>
        <div class="elim-score-main">
          <strong class="team-score-number ${penalty > 0 ? "score-drop-anim" : ""}" data-team-score="${team.id}">${formatScore(team.score)}</strong>
          ${penalty > 0 ? `<span class="score-penalty-pop">−${formatScore(penalty)}</span>` : ""}
          ${hasPenalty ? `<span class="score-penalty-result">−${formatScore(penalty)}</span>` : ""}
        </div>
      </div>
    `;
    host.appendChild(row);
  });
  animateScoreOrder(host, previousScoreOrder);
}

/**
 * @param {{ teamId: string; from: number; to: number; penalty: number; }[]} changes
 */
function animateScoreDrops(changes) {
  return new Promise((resolve) => {
    const start = performance.now();
    const duration = 620;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      changes.forEach((change) => {
        const el = q(`[data-team-score="${change.teamId}"]`);
        if (!(el instanceof HTMLElement)) return;
        const value = Math.round(change.from + (change.to - change.from) * eased);
        el.textContent = formatScore(value);
      });
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function moveToNextEliminationQuestion() {
  const pack = playState.pack;
  if (!pack) return;
  playState.lastPenaltyByTeam = new Map();
  if (getActiveTeams().length <= 1) {
    decideWinnerFromScores();
    return;
  }
  playState.eliminationIndex += 1;
  playState.eliminationRevealed = false;
  playState.eliminationStage = "guess";
  playState.eliminationDraggingTeamId = "";
  playState.eliminationAnswers = new Map();
  if (playState.eliminationIndex >= pack.settings.eliminationRound.questions.length) {
    decideWinnerFromScores();
    return;
  }
  renderEliminationRound();
}

function decideWinnerFromScores() {
  const contenders = playState.teams.filter((team) => team.score >= 0);
  if (!contenders.length) {
    playState.winnerName = "No Teams";
    playState.winnerScore = 0;
    playState.phase = "victory";
    renderPlayPhase();
    return;
  }
  const winner = contenders.reduce((best, team) => (team.score > best.score ? team : best), contenders[0]);
  playState.winnerName = winner.name;
  playState.winnerScore = winner.score;
  playState.phase = "victory";
  renderPlayPhase();
}

function renderVictory() {
  const panel = assert(/** @type {HTMLElement | null} */ (q("#victory-panel")), "Victory panel missing.");
  panel.classList.remove("hidden");
  const title = assert(/** @type {HTMLElement | null} */ (q("#victory-title")), "Victory title missing.");
  const scoreEl = assert(/** @type {HTMLElement | null} */ (q("#victory-score")), "Victory score missing.");
  title.textContent = `${playState.winnerName} Wins`;
  scoreEl.textContent = `Final Score: ${playState.winnerScore}`;
}

function bindEliminationEvents() {
  const actionBtn = q("#elim-action-btn");
  if (actionBtn instanceof HTMLButtonElement) {
    actionBtn.onclick = async () => {
      if (playState.eliminationStage === "guess") {
        playState.eliminationStage = "revealed";
        playState.eliminationRevealed = true;
        renderEliminationRound();
        return;
      }
      if (playState.eliminationStage === "revealed") {
        actionBtn.disabled = true;
        await applyEliminationScoring();
        playState.eliminationStage = "scored";
        updateEliminationActionButton();
        return;
      }
      if (playState.eliminationStage === "scored") {
        moveToNextEliminationQuestion();
        renderPlayPhase();
      }
    };
  }
}

function updateEliminationActionButton() {
  const actionBtn = q("#elim-action-btn");
  if (!(actionBtn instanceof HTMLButtonElement)) return;
  actionBtn.disabled = false;
  if (playState.eliminationStage === "guess") {
    actionBtn.textContent = "Reveal Answer";
  } else if (playState.eliminationStage === "revealed") {
    actionBtn.textContent = "Apply Penalties";
  } else {
    actionBtn.textContent = "Next Question";
  }
}

/**
 * @param {number} c
 * @param {number} r
 */
function openClue(c, r) {
  const pack = playState.pack;
  if (!pack) return;
  const clue = pack.board.categories[c]?.clues[r];
  if (!clue) return;
  const key = `${c}:${r}`;
  if (playState.used.has(key)) return;

  playState.currentClue = {
    c,
    r,
    clue,
    category: pack.board.categories[c]?.name || `Category ${c + 1}`,
  };

  const dialog = assert(/** @type {HTMLDialogElement | null} */ (q("#clue-dialog")), "Dialog missing.");
  const category = assert(/** @type {HTMLElement | null} */ (q("#dialog-category")), "Dialog category missing.");
  const value = assert(/** @type {HTMLElement | null} */ (q("#dialog-value")), "Dialog value missing.");
  const dailyDouble = assert(/** @type {HTMLElement | null} */ (q("#daily-double-banner")), "DD banner missing.");
  const question = assert(/** @type {HTMLElement | null} */ (q("#dialog-question")), "Question missing.");
  const answer = assert(/** @type {HTMLElement | null} */ (q("#dialog-answer")), "Answer missing.");

  category.textContent = playState.currentClue.category;
  const baseValue = Math.max(1, Number(clue.value) || 100);
  const roundValue = clue.dailyDouble ? baseValue * 2 : baseValue;
  value.textContent = clue.dailyDouble ? `$${baseValue} x2 = $${roundValue}` : `$${baseValue}`;
  question.textContent = clue.question || "(No question entered)";
  answer.textContent = clue.answer || "(No answer entered)";
  answer.classList.add("hidden");
  question.classList.remove("show");
  answer.classList.remove("show");
  dailyDouble.classList.toggle("hidden", !clue.dailyDouble);
  dailyDouble.classList.toggle("daily-double-active", !!clue.dailyDouble);
  value.classList.toggle("daily-double-value", !!clue.dailyDouble);
  playState.lastClueValue = roundValue;
  const hostScorebar = q("#host-scorebar");
  if (hostScorebar instanceof HTMLElement) {
    renderHostScorebar(hostScorebar);
  }

  dialog.showModal();
  window.setTimeout(() => {
    question.classList.add("show");
  }, 40);
}

function bindDialogEvents() {
  const dialog = q("#clue-dialog");
  if (!(dialog instanceof HTMLDialogElement)) {
    return;
  }
  const revealBtn = q("#reveal-answer-btn");
  const markUsedBtn = q("#mark-used-btn");
  const closeBtn = q("#close-dialog-btn");

  if (revealBtn instanceof HTMLButtonElement) {
    revealBtn.onclick = () => {
      const answer = q("#dialog-answer");
      if (answer instanceof HTMLElement) {
        answer.classList.remove("hidden");
        window.setTimeout(() => {
          answer.classList.add("show");
        }, 20);
      }
    };
  }

  if (markUsedBtn instanceof HTMLButtonElement) {
    markUsedBtn.onclick = () => {
      if (playState.currentClue) {
        playState.used.add(`${playState.currentClue.c}:${playState.currentClue.r}`);
      }
      dialog.close();
      if (isBoardComplete()) {
        playState.awaitingNextRound = true;
        renderBoard();
      } else {
        renderBoard();
      }
    };
  }

  if (closeBtn instanceof HTMLButtonElement) {
    closeBtn.onclick = () => {
      dialog.close();
    };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\"", "&quot;");
}

window.addEventListener("DOMContentLoaded", () => {
  renderRoute().catch((error) => {
    console.error(error);
    app.innerHTML = `<section class="panel"><h2>Error</h2><p>${escapeHtml(String(error))}</p></section>`;
  });
});
