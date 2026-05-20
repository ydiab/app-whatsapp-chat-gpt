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
	buildCookidooNativeChip,
	findIngredientLocationInText,
} = require("../utils/thermomixCookidoo");
const { validateRecipeForUpload } = require("../utils/validateRecipe");

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
 * Construye un paso en el formato que usa Cookidoo en recetas oficiales:
 *  - texto natural mencionando los ingredientes (sin la lista pegada al inicio)
 *  - INGREDIENT annotations sobre cada nombre de ingrediente del texto (negrita/enlace)
 *  - chip de cocción en formato nativo ("8 min/120°C//vel ." con doble barra para
 *    giro inverso e icono cuchara) al final del paso
 *  - TTS / MODE annotation sobre ese chip (icono de giro y de velocidad)
 *
 * Si algún ingrediente asignado al paso NO aparece en el texto, se prepende una
 * frase "Añadir 6 g de aceite, 140 g de pechuga de pollo. " para conservar el
 * enlace, manteniendo un tono natural.
 *
 * @param {{ text: string, tm_mode?: string, ingredient_indices?: number[] }} step
 * @param {{ text: string, localId: string, name: string }[]} rows
 * @param {{ withAnnotations?: boolean }} opts
 */
function buildStepInstruction(step, rows, opts = {}) {
	const withAnnotations = opts.withAnnotations !== false;
	const indices = [...new Set(step.ingredient_indices || [])]
		.filter((i) => i >= 0 && i < rows.length)
		.sort((a, b) => a - b);

	const body = step.text ? String(step.text).trim() : "";
	const userChip = resolveTmModeChip(step);

	let chipAnnotationTemplate = null;
	let nativeChip = null;
	if (userChip) {
		const found = findCookingAnnotationsInText(userChip);
		if (found.length > 0) {
			chipAnnotationTemplate = found[0];
			nativeChip = buildCookidooNativeChip(chipAnnotationTemplate);
		}
	}

	const placed = [];
	const missing = [];
	for (const idx of indices) {
		const row = rows[idx];
		const loc = body
			? findIngredientLocationInText(row.name, body)
			: null;
		if (loc) {
			placed.push({ idx, row, offset: loc.offset, length: loc.length });
		} else {
			missing.push({ idx, row });
		}
	}

	let prefix = "";
	const prefixAnns = [];
	if (missing.length > 0) {
		const startWord = "Añadir ";
		let cursor = startWord.length;
		let prefixBody = startWord;
		for (let k = 0; k < missing.length; k++) {
			const line = missing[k].row.text;
			prefixAnns.push({
				idx: missing[k].idx,
				offset: cursor,
				length: line.length,
			});
			prefixBody += line;
			cursor += line.length;
			if (k < missing.length - 1) {
				prefixBody += ", ";
				cursor += 2;
			}
		}
		prefixBody += body ? ". " : ".";
		prefix = prefixBody;
	}

	const textBody = prefix + body;
	const chipSep = nativeChip && textBody ? " " : "";
	const text = (textBody + chipSep + (nativeChip || "")).trim() || "paso";

	const instruction = { type: "STEP", text };

	if (!withAnnotations) {
		return instruction;
	}

	const annotations = [];

	for (const pa of prefixAnns) {
		annotations.push({
			type: "INGREDIENT",
			position: { offset: pa.offset, length: pa.length },
			data: {
				description: {
					text: rows[pa.idx].text,
					annotations: [],
				},
			},
		});
	}

	const prefixLen = prefix.length;
	for (const p of placed) {
		annotations.push({
			type: "INGREDIENT",
			position: {
				offset: prefixLen + p.offset,
				length: p.length,
			},
			data: {
				description: {
					text: p.row.text,
					annotations: [],
				},
			},
		});
	}

	if (chipAnnotationTemplate && nativeChip) {
		const chipOffset = textBody.length + chipSep.length;
		const { position: _ignored, ...rest } = chipAnnotationTemplate;
		annotations.push({
			...rest,
			position: { offset: chipOffset, length: nativeChip.length },
		});
	}

	annotations.sort((a, b) => a.position.offset - b.position.offset);
	if (annotations.length > 0) {
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

function cleanCookidooInstructions(instructions) {
	return (Array.isArray(instructions) ? instructions : [])
		.filter((s) => s?.type === "STEP" || s?.text)
		.map((step) => {
			const out = {
				type: "STEP",
				text: String(step.text || "").trim() || "paso",
			};
			if (Array.isArray(step.annotations) && step.annotations.length > 0) {
				out.annotations = step.annotations;
			}
			return out;
		});
}

function cleanCookidooIngredients(ingredients) {
	return (Array.isArray(ingredients) ? ingredients : [])
		.filter((i) => i?.text || i?.type === "INGREDIENT")
		.map((item) => {
			const row = { type: "INGREDIENT", text: String(item.text || "").trim() };
			if (item.localId) {
				row.localId = item.localId;
			}
			return row;
		})
		.filter((i) => i.text);
}

/**
 * Sube JSON Cookidoo casi tal cual (sin pasar por formato Mimi).
 * @param {{ content: object, meta?: object }} native
 */
async function uploadCookidooNativeToAccount(native, credentialsPath) {
	const content = native?.content;
	if (!content) {
		throw new Error("Falta recipeContent en el JSON de Cookidoo");
	}

	const ingredients = cleanCookidooIngredients(content.ingredients);
	const instructions = cleanCookidooInstructions(content.instructions);
	if (ingredients.length === 0) {
		throw new Error("El JSON de Cookidoo no tiene ingredientes");
	}
	if (instructions.length === 0) {
		throw new Error("El JSON de Cookidoo no tiene pasos");
	}

	const creds = await loadCookidooCredentials(credentialsPath);
	const accessToken = await cookidooRequestToken(creds);
	const baseOrigin = new URL(creds.cookidooBaseUrl).origin;
	const { language } = creds;
	const apiBase = `https://${creds.countryCode}.tmmobile.vorwerk-digital.com`;

	const title = String(content.name || native?.meta?.name || "Receta").trim();
	const servings = Number(content.yield?.value) || 4;
	const totalSeconds = Number(content.totalTime) || 1800;
	const activeSeconds = Number(content.prepTime) || Math.floor(totalSeconds * 0.35);
	const cookSeconds = Number(content.cookTime) || totalSeconds - activeSeconds;
	const hints =
		typeof content.hints === "string"
			? content.hints
			: Array.isArray(content.hints)
				? content.hints.join("\n\n")
				: "";

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
	const createJson = JSON.parse(createText);
	const cookidooRecipeId =
		createJson.recipeId || createJson.id || createJson.recipe?.recipeId;
	if (!cookidooRecipeId) {
		throw new Error("Cookidoo crear receta: no devolvió recipeId");
	}

	await delay(5000);
	const patchUrl = `${apiBase}/created-recipes/${encodeURIComponent(language)}/${encodeURIComponent(cookidooRecipeId)}`;

	const baseMeta = {
		name: title,
		image: content.image ?? null,
		isImageOwnedByUser: false,
		tools:
			Array.isArray(content.tools) && content.tools.length > 0
				? content.tools
				: creds.tools,
		yield: { value: servings, unitText: creds.yieldUnitText },
		prepTime: activeSeconds,
		cookTime: cookSeconds,
		totalTime: totalSeconds,
		hints: hints || "",
		workStatus: "PRIVATE",
		recipeMetadata: { requiresAnnotationsCheck: false },
	};

	const ingPayload = ingredients.map((row) =>
		row.localId
			? { type: "INGREDIENT", localId: row.localId, text: row.text }
			: { type: "INGREDIENT", text: row.text },
	);

	let ingRes = await patchJson(patchUrl, authHeaders, {
		...baseMeta,
		ingredients: ingPayload,
	});
	if (!ingRes.ok && ingRes.status === 400) {
		ingRes = await patchJson(patchUrl, authHeaders, {
			...baseMeta,
			ingredients: ingredients.map((row) => ({
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
	let stepRes = await patchJson(patchUrl, authHeaders, { instructions });
	if (!stepRes.ok && stepRes.status === 400) {
		stepRes = await patchJson(patchUrl, authHeaders, {
			instructions: instructions.map((s) => ({
				type: "STEP",
				text: s.text,
			})),
		});
	}
	if (!stepRes.ok && stepRes.status !== 204) {
		throw new Error(
			`Cookidoo pasos HTTP ${stepRes.status}: ${stepRes.responseText.slice(0, 500)}`,
		);
	}

	const recipeUrl = `${baseOrigin}/recipes/custom-recipes/${encodeURIComponent(cookidooRecipeId)}`;
	return { cookidooRecipeId, recipeUrl };
}

/**
 * @returns {{ cookidooRecipeId: string, recipeUrl: string }}
 */
async function uploadRecipeToCookidooAccount(recipe, credentialsPath) {
	validateRecipeForUpload(recipe);

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
	uploadCookidooNativeToAccount,
	loadCookidooCredentials,
	cookidooRequestToken,
};
