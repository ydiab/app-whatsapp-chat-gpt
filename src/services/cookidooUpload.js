/**
 * Subida directa a Cookidoo (no API pública oficial).
 * Ingredientes en lista + pasos con el mismo texto de cada línea al inicio del paso
 * y annotations tipo INGREDIENT con position { offset, length } sobre step.text
 * (contrato documentado en @recode-software/cookidoo-api).
 * CREATE/PATCH contra el API móvil *.tmmobile.vorwerk-digital.com; el enlace web
 * de la receta sigue usando cookidooBaseUrl del JSON de credenciales.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { monotonicUlid } = require("../utils/ulid");
const {
	formatIngredientLine,
	resolveTmModeChip,
	findCookingAnnotationsInText,
} = require("../utils/thermomixCookidoo");

const COOKIDOO_TOKEN_AUTHORIZATION =
	"Basic a3VwZmVyd2Vyay1jbGllbnQtbndvdDpMczUwT04xd295U3FzMWRDZEpnZQ==";

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function loadCookidooCredentials(credentialsPath) {
	const resolved = path.resolve(credentialsPath);
	const raw = await fs.readFile(resolved, "utf8");
	const data = JSON.parse(raw);
	for (const key of [
		"email",
		"password",
		"countryCode",
		"cookidooBaseUrl",
		"language",
	]) {
		if (!data[key]) {
			throw new Error(`Falta el campo "${key}" en ${resolved}`);
		}
	}
	const yieldUnitText =
		data.yieldUnitText === null || data.yieldUnitText === undefined
			? "portion"
			: String(data.yieldUnitText);

	return {
		email: String(data.email),
		password: String(data.password),
		countryCode: String(data.countryCode).toLowerCase(),
		cookidooBaseUrl: String(data.cookidooBaseUrl).replace(/\/$/, ""),
		language: String(data.language),
		tools:
			Array.isArray(data.tools) && data.tools.length > 0
				? data.tools
				: ["TM7", "TM6"],
		yieldUnitText,
	};
}

async function cookidooRequestToken(creds) {
	const tokenUrl = `https://${creds.countryCode}.tmmobile.vorwerk-digital.com/ciam/auth/token`;
	const body = new URLSearchParams({
		grant_type: "password",
		username: creds.email,
		password: creds.password,
	});

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: COOKIDOO_TOKEN_AUTHORIZATION,
		},
		body,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Cookidoo login HTTP ${response.status}: ${text.slice(0, 280)}`,
		);
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("Cookidoo login: respuesta no JSON");
	}

	if (!data.access_token) {
		throw new Error("Cookidoo login: no access_token en la respuesta");
	}

	return data.access_token;
}

function normalizeForMatch(s) {
	return String(s)
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

const ADD_INGREDIENT_PATTERN =
	/\b(añad|agreg|ech|incorpor|pon(?:er|ga)|verter|deposite|introduc|mezclar\s+con|juntar)\w*/i;

/** Paso que solo programa/cocina lo que ya hay en el vaso (sin echar ingredientes nuevos). */
function isCookingOnlyStep(text, tmMode) {
	const t = String(text || "").trim();
	if (!t) {
		return Boolean(tmMode);
	}
	if (ADD_INGREDIENT_PATTERN.test(t)) {
		return false;
	}
	return Boolean(tmMode);
}

function stepAddsIngredients(text) {
	return ADD_INGREDIENT_PATTERN.test(String(text || ""));
}

function ingredientMentionedInText(ingredientName, stepText) {
	const needle = normalizeForMatch(ingredientName);
	if (needle.length < 2) {
		return false;
	}
	const hay = normalizeForMatch(stepText);
	const re = new RegExp(
		`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`,
		"i",
	);
	return re.test(hay) || hay.includes(needle);
}

function parseIndices(raw, n) {
	if (!Array.isArray(raw)) {
		return null;
	}
	return [...new Set(raw.map(Number))].filter(
		(x) => !Number.isNaN(x) && x >= 0 && x < n,
	);
}

/** Si casi todos los pasos llevan el mismo listado completo, el modelo lo rellenó mal. */
function modelIndicesLookBogus(sortedSteps, n) {
	if (n === 0 || sortedSteps.length < 2) {
		return false;
	}
	const withIndices = sortedSteps.filter(
		(s) => Array.isArray(s.ingredient_indices) && s.ingredient_indices.length > 0,
	);
	if (withIndices.length < Math.ceil(sortedSteps.length * 0.6)) {
		return false;
	}
	const fullSet = new Set([...Array(n).keys()].map(String));
	return withIndices.every((s) => {
		const set = new Set(parseIndices(s.ingredient_indices, n).map(String));
		return set.size === fullSet.size && [...fullSet].every((k) => set.has(k));
	});
}

function inferIngredientIndicesPerStep(recipe) {
	const ingredients = recipe.ingredients || [];
	const sortedSteps = [...(recipe.steps || [])].sort(
		(a, b) => (a.order || 0) - (b.order || 0),
	);
	const n = ingredients.length;
	const perStep = sortedSteps.map(() => new Set());

	for (let i = 0; i < n; i++) {
		const name =
			ingredients[i].name != null ? String(ingredients[i].name).trim() : "";
		let bestStep = -1;
		let bestScore = -1;

		for (let j = 0; j < sortedSteps.length; j++) {
			const stepText = sortedSteps[j].text || "";
			if (!stepAddsIngredients(stepText)) {
				continue;
			}
			if (!ingredientMentionedInText(name, stepText)) {
				continue;
			}
			const score = normalizeForMatch(name).length;
			if (score > bestScore) {
				bestScore = score;
				bestStep = j;
			}
		}

		if (bestStep >= 0) {
			perStep[bestStep].add(i);
		}
	}

	return sortedSteps.map((step, j) => ({
		order: step.order ?? j + 1,
		text: step.text != null ? String(step.text).trim() : "",
		tm_mode: step.tm_mode != null ? String(step.tm_mode).trim() : "",
		ingredient_indices: [...perStep[j]],
	}));
}

/**
 * Ajusta ingredient_indices del modelo: pasos solo cocción → [], sin duplicar en todos los pasos.
 */
function resolveIngredientIndicesPerStep(recipe) {
	const ingredients = recipe.ingredients || [];
	const sortedSteps = [...(recipe.steps || [])].sort(
		(a, b) => (a.order || 0) - (b.order || 0),
	);
	const n = ingredients.length;
	const useInference =
		modelIndicesLookBogus(sortedSteps, n) ||
		sortedSteps.every(
			(s) =>
				!Array.isArray(s.ingredient_indices) || s.ingredient_indices.length === 0,
		);

	let steps = useInference
		? inferIngredientIndicesPerStep(recipe)
		: sortedSteps.map((step, j) => ({
				order: step.order ?? j + 1,
				text: step.text != null ? String(step.text).trim() : "",
				tm_mode: step.tm_mode != null ? String(step.tm_mode).trim() : "",
				ingredient_indices:
					parseIndices(step.ingredient_indices, n) ?? [],
			}));

	steps = steps.map((step) => {
		if (isCookingOnlyStep(step.text, step.tm_mode)) {
			return { ...step, ingredient_indices: [] };
		}
		if (step.ingredient_indices.length > 0 && !stepAddsIngredients(step.text)) {
			return { ...step, ingredient_indices: [] };
		}
		return step;
	});

	const claimed = new Map();
	for (let j = 0; j < steps.length; j++) {
		const kept = [];
		for (const i of steps[j].ingredient_indices) {
			if (claimed.has(i)) {
				continue;
			}
			claimed.set(i, j);
			kept.push(i);
		}
		steps[j] = { ...steps[j], ingredient_indices: kept };
	}

	return steps;
}

function buildIngredientRows(recipe) {
	const ingredients = recipe.ingredients || [];
	return ingredients.map((item) => {
		const text = formatIngredientLine(item);
		const name =
			item.name != null
				? String(item.name).trim()
				: text.split(/\s+/).slice(1).join(" ");
		return {
			localId: monotonicUlid(),
			text,
			name,
		};
	});
}

/**
 * Anotaciones INGREDIENT alineadas con substring exacto en `text` (offset/length).
 * @param {string} text
 * @param {string[]} lines
 * @returns {object[]}
 */
function buildIngredientAnnotations(text, lines) {
	const annotations = [];
	let searchStart = 0;
	for (const line of lines) {
		if (!line) continue;
		const offset = text.indexOf(line, searchStart);
		if (offset < 0) continue;
		annotations.push({
			type: "INGREDIENT",
			data: {
				description: line,
				notes: [],
			},
			position: { offset, length: line.length },
		});
		searchStart = offset + line.length;
	}
	annotations.sort((a, b) => a.position.offset - b.position.offset);
	return annotations;
}

/**
 * @param {{ text: string, tm_mode?: string, ingredient_indices?: number[] }} step
 * @param {{ text: string, localId: string }[]} rows
 * @param {{ withAnnotations?: boolean }} opts
 */
function buildStepInstruction(step, rows, opts = {}) {
	const withAnnotations = opts.withAnnotations !== false;
	const indices = [...new Set(step.ingredient_indices || [])]
		.filter((i) => i >= 0 && i < rows.length)
		.sort((a, b) => a - b);
	const lines = indices.map((i) => rows[i].text).filter(Boolean);
	const body = step.text ? String(step.text).trim() : "";
	const tmChip = resolveTmModeChip(step);

	const textParts = [];
	if (lines.length > 0) {
		textParts.push(lines.join("\n"));
	}
	if (body) {
		textParts.push(body);
	}
	if (tmChip) {
		textParts.push(tmChip);
	}
	const text = textParts.join("\n\n") || "paso";

	const instruction = {
		type: "STEP",
		text,
	};

	if (!withAnnotations) {
		return instruction;
	}

	const annotations = [];

	if (lines.length > 0) {
		const ing = buildIngredientAnnotations(text, lines);
		if (ing.length === lines.length) {
			annotations.push(...ing);
		}
	}

	if (tmChip) {
		const cooking = findCookingAnnotationsInText(text);
		const match = cooking.find(
			(a) =>
				text.slice(a.position.offset, a.position.offset + a.position.length) ===
				tmChip,
		);
		if (match) {
			annotations.push(match);
		} else {
			const offset = text.indexOf(tmChip);
			const fallback = findCookingAnnotationsInText(tmChip)[0];
			if (offset >= 0 && fallback) {
				annotations.push({
					...fallback,
					position: { offset, length: tmChip.length },
				});
			}
		}
	}

	if (annotations.length > 0) {
		annotations.sort((a, b) => a.position.offset - b.position.offset);
		instruction.annotations = annotations;
	}

	return instruction;
}

async function patchJson(url, authHeaders, body) {
	const response = await fetch(url, {
		method: "PATCH",
		headers: authHeaders,
		body: JSON.stringify(body),
	});
	const responseText = await response.text();
	return { ok: response.ok, status: response.status, responseText };
}

/**
 * @returns {{ cookidooRecipeId: string, recipeUrl: string }}
 */
async function uploadRecipeToCookidooAccount(recipe, credentialsPath) {
	const creds = await loadCookidooCredentials(credentialsPath);
	const accessToken = await cookidooRequestToken(creds);

	const baseOrigin = new URL(creds.cookidooBaseUrl).origin;
	const { language } = creds;
	const apiBase = `https://${creds.countryCode}.tmmobile.vorwerk-digital.com`;

	const title = recipe.title || "Receta";
	const servings = Number(recipe.servings) || 4;
	const totalMin = Number(recipe.total_time_min) || 30;
	const totalSeconds = Math.max(60, totalMin * 60);
	const activeSeconds = Math.min(
		totalSeconds,
		Math.max(0, Math.floor(totalSeconds * 0.35)),
	);
	const cookSeconds = Math.max(0, totalSeconds - activeSeconds);

	const hintParts = [];
	if (recipe.description) hintParts.push(String(recipe.description));
	if (recipe.nutrition_notes) hintParts.push(String(recipe.nutrition_notes));
	const hints = hintParts.join("\n\n");

	const authHeaders = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${accessToken}`,
	};

	const createUrl = `${apiBase}/created-recipes/${encodeURIComponent(language)}`;
	const createRes = await fetch(createUrl, {
		method: "POST",
		headers: authHeaders,
		body: JSON.stringify({ recipeName: title }),
	});

	const createText = await createRes.text();
	if (!createRes.ok) {
		throw new Error(
			`Cookidoo crear receta HTTP ${createRes.status}: ${createText.slice(0, 400)}`,
		);
	}

	let createJson;
	try {
		createJson = JSON.parse(createText);
	} catch {
		throw new Error("Cookidoo crear receta: respuesta no JSON");
	}

	const cookidooRecipeId =
		createJson.recipeId || createJson.id || createJson.recipe?.recipeId;
	if (!cookidooRecipeId) {
		throw new Error(
			"Cookidoo crear receta: no devolvió recipeId en la respuesta",
		);
	}

	await delay(5000);

	const patchUrl = `${apiBase}/created-recipes/${encodeURIComponent(language)}/${encodeURIComponent(cookidooRecipeId)}`;

	const rows = buildIngredientRows(recipe);
	const enrichedSteps = resolveIngredientIndicesPerStep(recipe);

	const baseMeta = {
		name: title,
		image: null,
		isImageOwnedByUser: false,
		tools: creds.tools,
		yield: { value: servings, unitText: creds.yieldUnitText },
		prepTime: activeSeconds,
		cookTime: cookSeconds,
		totalTime: totalSeconds,
		hints: hints || "",
		workStatus: "PRIVATE",
		recipeMetadata: {
			requiresAnnotationsCheck: false,
		},
	};

	const ingredientsPayload = rows.map((row) => ({
		type: "INGREDIENT",
		localId: row.localId,
		text: row.text,
	}));

	let ingRes = await patchJson(patchUrl, authHeaders, {
		...baseMeta,
		ingredients: ingredientsPayload,
	});

	if (!ingRes.ok && ingRes.status === 400) {
		ingRes = await patchJson(patchUrl, authHeaders, {
			...baseMeta,
			ingredients: rows.map((row) => ({
				type: "INGREDIENT",
				text: row.text,
			})),
		});
	}

	if (!ingRes.ok && ingRes.status !== 204) {
		throw new Error(
			`Cookidoo ingredientes HTTP ${ingRes.status}: ${ingRes.responseText.slice(0, 500)}`,
		);
	}

	await delay(2000);

	const patchInstructions = (withAnnotations) =>
		patchJson(patchUrl, authHeaders, {
			instructions: enrichedSteps.map((step) =>
				buildStepInstruction(step, rows, { withAnnotations }),
			),
		});

	let stepRes = await patchInstructions(true);
	if (!stepRes.ok && stepRes.status === 400) {
		stepRes = await patchInstructions(false);
	}

	if (!stepRes.ok && stepRes.status !== 204) {
		throw new Error(
			`Cookidoo pasos HTTP ${stepRes.status}: ${stepRes.responseText.slice(0, 500)}`,
		);
	}

	const recipeUrl = `${baseOrigin}/recipes/custom-recipes/${encodeURIComponent(cookidooRecipeId)}`;
	return { cookidooRecipeId, recipeUrl };
}

module.exports = {
	uploadRecipeToCookidooAccount,
};
