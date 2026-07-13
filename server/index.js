// @ts-check
"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { randomUUID } = require("node:crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const CLIENT_DIR = path.join(ROOT_DIR, "client");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PACKS_DIR = path.join(DATA_DIR, "packs");
const INDEX_PATH = path.join(DATA_DIR, "index.json");
const PORT = Number(process.env.PORT || 8787);

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
 *   fileName?: string;
 *   parseError?: string;
 * }} PackIndexItem
 */

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function ensureDataDirs() {
  await fs.mkdir(PACKS_DIR, { recursive: true });
  try {
    await fs.access(INDEX_PATH);
  } catch {
    await writeJson(INDEX_PATH, { packs: [] });
  }
}

/**
 * @param {number} rows
 * @param {number} cols
 * @param {number} startValue
 * @param {number} step
 */
function buildDefaultCategories(rows, cols, startValue, step) {
  /** @type {Category[]} */
  const categories = [];
  for (let c = 0; c < cols; c += 1) {
    /** @type {Clue[]} */
    const clues = [];
    for (let r = 0; r < rows; r += 1) {
      clues.push({
        question: "",
        answer: "",
        value: startValue + r * step,
        dailyDouble: false,
      });
    }
    categories.push({
      name: `Category ${c + 1}`,
      clues,
    });
  }
  return categories;
}

/**
 * @param {{ title?: string; rows?: number; cols?: number; startValue?: number; valueStep?: number; }} [input]
 * @returns {Pack}
 */
function createPackTemplate(input = {}) {
  const rows = Number.isInteger(input.rows) ? /** @type {number} */ (input.rows) : 5;
  const cols = Number.isInteger(input.cols) ? /** @type {number} */ (input.cols) : 6;
  const startValue = Number.isFinite(input.startValue) ? Math.max(1, Number(input.startValue)) : 100;
  const valueStep = Number.isFinite(input.valueStep) ? Math.max(1, Number(input.valueStep)) : 100;
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    title: input.title?.trim() || "New Jeopardy Pack",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    board: {
      rows,
      cols,
      categories: buildDefaultCategories(rows, cols, startValue, valueStep),
    },
    settings: {
      eliminationRound: {
        questions: [
          {
            prompt: "",
            min: 0,
            max: 1000,
            answer: 500,
            step: 1,
          },
        ],
      },
    },
  };
}

/**
 * @param {string} filePath
 */
async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

/**
 * @returns {Promise<{ packs: PackIndexItem[] }>}
 */
async function readIndex() {
  await ensureDataDirs();
  try {
    const idx = await readJson(INDEX_PATH);
    if (!idx || !Array.isArray(idx.packs)) {
      return { packs: [] };
    }
    return idx;
  } catch {
    return { packs: [] };
  }
}

/**
 * @param {PackIndexItem[]} packs
 */
async function writeIndex(packs) {
  await writeJson(INDEX_PATH, { packs });
}

/**
 * @param {string} value
 */
function slugify(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || "pack";
}

/**
 * @param {string} title
 * @param {Set<string>} existing
 * @param {string | undefined} keepFileName
 */
function chooseFileName(title, existing, keepFileName) {
  const root = slugify(title);
  let candidate = `${root}.json`;
  let n = 2;
  while (existing.has(candidate) && candidate !== keepFileName) {
    candidate = `${root} ${n}.json`;
    n += 1;
  }
  return candidate;
}

/**
 * @param {string} fileName
 */
function filePathFromName(fileName) {
  return path.join(PACKS_DIR, fileName);
}

/**
 * @param {string} id
 * @returns {Promise<{ pack: Pack; fileName: string }>}
 */
async function loadPackRecord(id) {
  const idx = await readIndex();
  const known = idx.packs.find((item) => item.id === id);
  if (known?.fileName) {
    const knownPath = filePathFromName(known.fileName);
    try {
      const pack = /** @type {Pack} */ (await readJson(knownPath));
      if (pack.id === id) {
        return { pack, fileName: known.fileName };
      }
    } catch {
      // fall back to scan
    }
  }
  const files = await fs.readdir(PACKS_DIR);
  for (const fileName of files) {
    if (!fileName.endsWith(".json")) {
      continue;
    }
    const filePath = filePathFromName(fileName);
    try {
      const pack = /** @type {Pack} */ (await readJson(filePath));
      if (pack.id === id) {
        return { pack, fileName };
      }
    } catch {
      // ignore unreadable files
    }
  }
  throw new Error("Pack not found.");
}

/**
 * @param {string} id
 * @returns {Promise<Pack>}
 */
async function loadPack(id) {
  const record = await loadPackRecord(id);
  return record.pack;
}

/**
 * @param {Pack} pack
 * @param {string | undefined} previousFileName
 */
async function savePack(pack, previousFileName) {
  const files = await fs.readdir(PACKS_DIR);
  const existing = new Set(files.filter((name) => name.endsWith(".json")));
  const nextFileName = chooseFileName(pack.title, existing, previousFileName);
  await writeJson(filePathFromName(nextFileName), pack);
  if (previousFileName && previousFileName !== nextFileName) {
    try {
      await fs.unlink(filePathFromName(previousFileName));
    } catch {
      // ignore stale file cleanup errors
    }
  }
  return nextFileName;
}

/**
 * @param {Pack} pack
 * @returns {{ valid: boolean; errors: string[]; warnings: string[]; }}
 */
function validatePack(pack) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const rows = pack?.board?.rows;
  const cols = pack?.board?.cols;
  const categories = pack?.board?.categories;
  const eliminationQuestions = pack?.settings?.eliminationRound?.questions;

  if (!pack.title || !pack.title.trim()) {
    errors.push("Pack title is required.");
  }
  if (!Number.isInteger(rows) || rows < 1) {
    errors.push("Board rows must be a positive integer.");
  }
  if (!Number.isInteger(cols) || cols < 1) {
    errors.push("Board columns must be a positive integer.");
  }
  if (!Array.isArray(categories)) {
    errors.push("Board categories must be an array.");
    return { valid: false, errors, warnings };
  }
  if (categories.length !== cols) {
    errors.push(`Board must include exactly ${cols} categories.`);
  }

  const seenNames = new Map();
  categories.forEach((category, cIndex) => {
    if (!category || typeof category !== "object") {
      errors.push(`Category ${cIndex + 1} is invalid.`);
      return;
    }
    if (!category.name || !category.name.trim()) {
      errors.push(`Category ${cIndex + 1} name is required.`);
    } else {
      const normalized = category.name.trim().toLowerCase();
      const existing = seenNames.get(normalized);
      if (existing !== undefined) {
        warnings.push(`Duplicate category name: "${category.name.trim()}" (${existing + 1} and ${cIndex + 1}).`);
      } else {
        seenNames.set(normalized, cIndex);
      }
    }
    if (!Array.isArray(category.clues)) {
      errors.push(`Category ${cIndex + 1} clues must be an array.`);
      return;
    }
    if (category.clues.length !== rows) {
      errors.push(`Category ${cIndex + 1} must include exactly ${rows} clues.`);
      return;
    }
    category.clues.forEach((clue, rIndex) => {
      const tag = `Category ${cIndex + 1}, row ${rIndex + 1}`;
      if (!clue || typeof clue !== "object") {
        errors.push(`${tag}: clue is invalid.`);
        return;
      }
      if (!clue.question || !String(clue.question).trim()) {
        errors.push(`${tag}: question is required.`);
      }
      if (!clue.answer || !String(clue.answer).trim()) {
        errors.push(`${tag}: answer is required.`);
      }
      if (!Number.isFinite(Number(clue.value)) || Number(clue.value) <= 0) {
        errors.push(`${tag}: value must be a positive number.`);
      }
    });
  });

  if (!Array.isArray(eliminationQuestions)) {
    warnings.push("No elimination round configured. Round 2 will be skipped.");
  } else if (eliminationQuestions.length === 0) {
    warnings.push("Elimination round has zero questions. Round 2 will be skipped.");
  } else {
    eliminationQuestions.forEach((question, qIndex) => {
      const tag = `Elimination question ${qIndex + 1}`;
      if (!question || typeof question !== "object") {
        errors.push(`${tag}: entry is invalid.`);
        return;
      }
      if (!question.prompt || !String(question.prompt).trim()) {
        errors.push(`${tag}: prompt is required.`);
      }
      if (!Number.isFinite(Number(question.min))) {
        errors.push(`${tag}: min must be numeric.`);
      }
      if (!Number.isFinite(Number(question.max))) {
        errors.push(`${tag}: max must be numeric.`);
      }
      if (!Number.isFinite(Number(question.answer))) {
        errors.push(`${tag}: answer must be numeric.`);
      }
      if (!Number.isFinite(Number(question.step)) || Number(question.step) <= 0) {
        errors.push(`${tag}: step must be a positive number.`);
      }
      const min = Number(question.min);
      const max = Number(question.max);
      const answer = Number(question.answer);
      if (Number.isFinite(min) && Number.isFinite(max) && min >= max) {
        errors.push(`${tag}: min must be smaller than max.`);
      }
      if (Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(answer)) {
        if (answer < min || answer > max) {
          errors.push(`${tag}: answer must be between min and max.`);
        }
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * @param {Pack} pack
 * @param {PackStatus} status
 */
async function setPackStatus(pack, status) {
  if (status === "ready") {
    const result = validatePack(pack);
    if (!result.valid) {
      return { ok: false, result };
    }
  }
  pack.status = status;
  pack.updatedAt = new Date().toISOString();
  const record = await loadPackRecord(pack.id);
  const fileName = await savePack(pack, record.fileName);
  await syncPackToIndex(pack, fileName);
  return { ok: true };
}

/**
 * @param {Pack} pack
 * @param {string} fileName
 */
async function syncPackToIndex(pack, fileName) {
  const idx = await readIndex();
  const next = idx.packs.filter((item) => item.id !== pack.id);
  next.push({
    id: pack.id,
    title: pack.title,
    status: pack.status,
    updatedAt: pack.updatedAt,
    fileName,
  });
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await writeIndex(next);
}

/**
 * @param {string} id
 */
async function removePackFromIndex(id) {
  const idx = await readIndex();
  const next = idx.packs.filter((item) => item.id !== id);
  await writeIndex(next);
}

/**
 * @param {http.IncomingMessage} req
 */
async function parseJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }
  return JSON.parse(body);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 */
async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const pathName = url.pathname;

  if (method === "GET" && pathName === "/api/packs") {
    const idx = await readIndex();
    const known = new Map(idx.packs.map((pack) => [pack.id, pack]));
    let files = [];
    try {
      files = await fs.readdir(PACKS_DIR);
    } catch {
      files = [];
    }

    /** @type {PackIndexItem[]} */
    const discovered = [];
    for (const fileName of files) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const id = fileName.replace(/\.json$/, "");
      const filePath = path.join(PACKS_DIR, fileName);
      try {
        const pack = /** @type {Pack} */ (await readJson(filePath));
        discovered.push({
          id: pack.id || id,
          title: pack.title || known.get(pack.id || id)?.title || `Pack ${id}`,
          status: pack.status || "draft",
          updatedAt: pack.updatedAt || known.get(pack.id || id)?.updatedAt || new Date().toISOString(),
          fileName,
        });
      } catch (error) {
        discovered.push({
          id,
          title: known.get(id)?.title || `Broken pack (${id})`,
          status: known.get(id)?.status || "draft",
          updatedAt: known.get(id)?.updatedAt || new Date().toISOString(),
          fileName,
          parseError: "Invalid JSON file.",
        });
      }
    }

    const merged = discovered.length ? discovered : idx.packs;
    merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await writeIndex(merged.map(({ parseError, ...rest }) => rest));

    const statusFilter = url.searchParams.get("status");
    const filtered = merged.filter((item) => {
      if (statusFilter && item.status !== statusFilter) {
        return false;
      }
      return true;
    });
    return sendJson(res, 200, { packs: filtered });
  }

  if (method === "GET" && pathName === "/api/packs/delete") {
    const id = url.searchParams.get("id");
    if (!id) {
      return sendError(res, 400, "Missing pack id.");
    }
    try {
      const record = await loadPackRecord(id);
      await fs.unlink(filePathFromName(record.fileName));
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== "ENOENT" && String(error) !== "Error: Pack not found.") {
        return sendError(res, 500, "Failed to delete pack file.");
      }
    }
    await removePackFromIndex(id);
    return sendJson(res, 200, { ok: true, id });
  }

  if (method === "POST" && pathName === "/api/packs") {
    const body = await parseJsonBody(req);
    const pack = createPackTemplate(body);
    const fileName = await savePack(pack, undefined);
    await syncPackToIndex(pack, fileName);
    return sendJson(res, 201, { pack });
  }

  const packMatch = pathName.match(/^\/api\/packs\/([^/]+)$/);
  if (packMatch) {
    const id = packMatch[1];
    if (method === "GET") {
      try {
        const pack = await loadPack(id);
        return sendJson(res, 200, { pack });
      } catch (error) {
        if (String(error).includes("Unexpected token")) {
          return sendError(res, 422, "Pack JSON is invalid and cannot be loaded.");
        }
        return sendError(res, 404, "Pack not found.");
      }
    }
    if (method === "PUT") {
      try {
        const existingRecord = await loadPackRecord(id);
        const existing = existingRecord.pack;
        const body = await parseJsonBody(req);
        const now = new Date().toISOString();
        /** @type {Pack} */
        const nextPack = {
          ...existing,
          ...body,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now,
          status: body?.status === "ready" ? existing.status : (body?.status || existing.status),
        };
        const fileName = await savePack(nextPack, existingRecord.fileName);
        await syncPackToIndex(nextPack, fileName);
        return sendJson(res, 200, { pack: nextPack });
      } catch (error) {
        if (String(error).includes("Unexpected token")) {
          return sendError(res, 422, "Pack JSON is invalid and cannot be updated.");
        }
        return sendError(res, 404, "Pack not found.");
      }
    }
    if (method === "DELETE") {
      try {
        const record = await loadPackRecord(id);
        await fs.unlink(filePathFromName(record.fileName));
      } catch (error) {
        if (/** @type {{ code?: string }} */ (error).code !== "ENOENT" && String(error) !== "Error: Pack not found.") {
          return sendError(res, 500, "Failed to delete pack file.");
        }
      }
      await removePackFromIndex(id);
      return sendJson(res, 200, { ok: true, id });
    }
  }

  const validateMatch = pathName.match(/^\/api\/packs\/([^/]+)\/validate$/);
  if (validateMatch && method === "POST") {
    const id = validateMatch[1];
    try {
      const pack = await loadPack(id);
      const result = validatePack(pack);
      return sendJson(res, 200, result);
    } catch (error) {
      if (String(error).includes("Unexpected token")) {
        return sendError(res, 422, "Pack JSON is invalid and cannot be validated.");
      }
      return sendError(res, 404, "Pack not found.");
    }
  }

  const deleteMatch = pathName.match(/^\/api\/packs\/([^/]+)\/delete$/);
  if (deleteMatch && method === "POST") {
    const id = deleteMatch[1];
    try {
      const record = await loadPackRecord(id);
      await fs.unlink(filePathFromName(record.fileName));
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== "ENOENT" && String(error) !== "Error: Pack not found.") {
        return sendError(res, 500, "Failed to delete pack file.");
      }
    }
    await removePackFromIndex(id);
    return sendJson(res, 200, { ok: true, id });
  }

  const statusMatch = pathName.match(/^\/api\/packs\/([^/]+)\/status$/);
  if (statusMatch && method === "POST") {
    const id = statusMatch[1];
    let status;
    try {
      const body = await parseJsonBody(req);
      status = body?.status;
    } catch {
      return sendError(res, 400, "Invalid JSON body.");
    }
    if (!["draft", "ready", "archived"].includes(status)) {
      return sendError(res, 400, "Invalid status. Use draft, ready, or archived.");
    }
    try {
      const pack = await loadPack(id);
      const transition = await setPackStatus(pack, status);
      if (!transition.ok) {
        return sendJson(res, 409, {
          error: "Pack is not valid for Ready status.",
          ...transition.result,
        });
      }
      return sendJson(res, 200, { pack });
    } catch (error) {
      if (String(error).includes("Unexpected token")) {
        return sendError(res, 422, "Pack JSON is invalid and status cannot be changed.");
      }
      return sendError(res, 404, "Pack not found.");
    }
  }

  return sendError(res, 404, "API route not found.");
}

/**
 * @param {string} pathName
 */
function resolveStaticPath(pathName) {
  const normalized = pathName === "/" ? "/build" : pathName;
  const routeAliases = ["/build", "/play"];
  if (routeAliases.includes(normalized)) {
    return path.join(CLIENT_DIR, "index.html");
  }
  const safePath = path.normalize(normalized).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  return path.join(CLIENT_DIR, safePath);
}

/**
 * @param {http.ServerResponse} res
 * @param {string} filePath
 */
function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      return sendError(res, 400, "Missing request URL.");
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    const staticPath = resolveStaticPath(url.pathname);
    try {
      await fs.access(staticPath);
      return streamFile(res, staticPath);
    } catch {
      return sendError(res, 404, "File not found.");
    }
  } catch (error) {
    console.error(error);
    return sendError(res, 500, "Unexpected server error.");
  }
});

async function startServer() {
  await ensureDataDirs();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, () => {
      server.off("error", reject);
      console.log(`Jeopardy Suite running at http://localhost:${PORT}`);
      resolve();
    });
  });
  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}

module.exports = { startServer, server };
