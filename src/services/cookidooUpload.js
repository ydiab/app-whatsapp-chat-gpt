/**
 * Subida directa a Cookidoo (no API pública oficial).
 * Ingredientes en lista + pasos con annotations tipo INGREDIENT con
 * position { offset, length } sobre step.text.
 * Autenticación por COOKIES de sesión (ver cookidooAuth.js); CREATE/PATCH contra
 * https://cookidoo.{tld} (las rutas son las mismas que las del antiguo API móvil).
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
const {
	assignIngredientIndicesToRecipe,
	ingredientMentionedInText,
} = require("./cookidooParse");
const {
	buildCookidooSession,
	SESSION_EXPIRED_MESSAGE,
	isAuthError,
} = require("./cookidooAuth");

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function loadCookidooCredentials(credentialsPath) {
	const resolved = path.resolve(credentialsPath);
	const raw = await fs.readFile(resolved, "utf8");
	const data = JSON.parse(raw);
	// email/password ya no son necesarios: la sesión se obtiene por cookies
	// (cookies del navegador). Solo necesitamos la config del país/idioma.
	for (const key of ["countryCode", "cookidooBaseUrl", "language"]) {
		if (!data[key]) {
			throw new Error(`Falta el campo "${key}" en ${resolved}`);
		}
	}
	const yieldUnitText =
		data.yieldUnitText === null || data.yieldUnitText === undefined
			? "portion"
			: String(data.yieldUnitText);

	return {
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

const ADD_INGREDIENT_PATTERN =
	/\b(añad|agreg|ech|incorpor|pon(?:er|ga)|vert|deposit|introduc|mezcl|juntar|fund|derret|bati|tamiz|mont|integr|espolvore|amas|dilu)\w*/i;

/** Paso que solo programa/cocina lo que ya hay en el vaso (sin echar ingredientes nuevos). */
function isCookingOnlyStep(text, tmMode, mentionsIngredient) {
	const t = String(text || "").trim();
	if (!t) {
		return Boolean(tmMode);
	}
	if (ADD_INGREDIENT_PATTERN.test(t) || mentionsIngredient) {
		return false;
	}
	return Boolean(tmMode);
}

/** Cookidoo rechaza anotaciones superpuestas (p. ej. "chocolate" dentro de "chocolate negro"). */
function dropOverlappingPlacements(placed) {
	const sorted = [...placed].sort(
		(a, b) => b.length - a.length || a.offset - b.offset,
	);
	const kept = [];
	for (const item of sorted) {
		const overlaps = kept.some(
			(other) =>
				!(
					item.offset + item.length <= other.offset ||
					other.offset + other.length <= item.offset
				),
		);
		if (!overlaps) {
			kept.push(item);
		}
	}
	return kept.sort((a, b) => a.offset - b.offset);
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

function stripInternalStepNoise(text) {
	return String(text || "")
		.replace(/\s*\|\s*ingredient_indices\s*:\s*\[[^\]]*\]/gi, "")
		.replace(/\bingredient_indices\s*:\s*\[[^\]]*\]/gi, "")
		.trim();
}

function inferIngredientIndicesPerStep(recipe) {
	const assigned = assignIngredientIndicesToRecipe(recipe);
	return [...(assigned.steps || [])].sort(
		(a, b) => (a.order || 0) - (b.order || 0),
	).map((step, j) => ({
		order: step.order ?? j + 1,
		text: stripInternalStepNoise(step.text),
		tm_mode: step.tm_mode != null ? String(step.tm_mode).trim() : "",
		ingredient_indices: Array.isArray(step.ingredient_indices)
			? step.ingredient_indices
			: [],
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
	const assignedCount = sortedSteps.reduce(
		(sum, step) =>
			sum + (parseIndices(step.ingredient_indices, n) || []).length,
		0,
	);
	const useInference =
		modelIndicesLookBogus(sortedSteps, n) ||
		sortedSteps.every(
			(s) =>
				!Array.isArray(s.ingredient_indices) || s.ingredient_indices.length === 0,
		) ||
		assignedCount < Math.ceil(n * 0.4);

	let steps = useInference
		? inferIngredientIndicesPerStep(recipe)
		: sortedSteps.map((step, j) => ({
				order: step.order ?? j + 1,
				text: stripInternalStepNoise(step.text),
				tm_mode: step.tm_mode != null ? String(step.tm_mode).trim() : "",
				ingredient_indices:
					parseIndices(step.ingredient_indices, n) ?? [],
			}));

	steps = steps.map((step) => {
		const mentionsAssigned = step.ingredient_indices.some((i) =>
			ingredientMentionedInText(ingredients[i]?.name, step.text),
		);
		if (isCookingOnlyStep(step.text, step.tm_mode, mentionsAssigned)) {
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
			quantity: item.quantity != null ? String(item.quantity).trim() : "",
		};
	});
}

function annotationMatchesText(text, ann) {
	const offset = Number(ann?.position?.offset);
	const length = Number(ann?.position?.length);
	if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
		return false;
	}
	if (offset < 0 || offset + length > text.length) {
		return false;
	}
	const slice = text.slice(offset, offset + length);
	if (ann.type === "TTS" || ann.type === "MODE") {
		return /^\d/.test(slice) && /vel/i.test(slice);
	}
	return true;
}

function keepValidAnnotations(text, annotations) {
	const valid = (annotations || []).filter((ann) =>
		annotationMatchesText(text, ann),
	);
	return dropOverlappingPlacements(
		valid.map((ann) => ({
			...ann,
			offset: ann.position.offset,
			length: ann.position.length,
		})),
	).map(({ offset, length, ...ann }) => ({
		...ann,
		position: { offset, length },
	}));
}

function buildIngredientAnnotation(row, offset, length) {
	return {
		type: "INGREDIENT",
		data: {
			description: row.text,
			notes: [],
		},
		position: { offset, length },
	};
}

function buildInlineIngredientAnnotations(text, indices, rows) {
	const placed = [];
	for (const idx of indices) {
		const row = rows[idx];
		if (!row?.name) continue;
		const loc = findIngredientLocationInText(row.name, text);
		if (!loc) continue;
		placed.push({ idx, row, offset: loc.offset, length: loc.length });
	}
	return dropOverlappingPlacements(placed).map((item) =>
		buildIngredientAnnotation(item.row, item.offset, item.length),
	);
}

function cookingAnnotationForUpload(template, nativeChip, chipOffset) {
	const data = template.data || {};
	const out = {
		type: "TTS",
		data: {
			time: data.time,
			speed: String(data.speed || "1"),
		},
		position: { offset: chipOffset, length: nativeChip.length },
	};
	if (data.direction === "CCW") {
		out.data.direction = "CCW";
	}
	if (
		data.temperature?.value &&
		!(template.type === "MODE" && template.name === "steaming")
	) {
		out.data.temperature = {
			value: String(data.temperature.value),
			unit: data.temperature.unit || "C",
		};
	}
	return out;
}

function removeCookingChipsFromText(body) {
	let text = String(body || "");
	for (let i = 0; i < 8; i++) {
		const found = findCookingAnnotationsInText(text);
		if (!found.length) break;
		const { offset, length } = found[0].position;
		const before = text.slice(0, offset).replace(/\s+$/, "");
		let after = text.slice(offset + length);
		if (!after.startsWith(".")) {
			after = after.replace(/^\s+/, after ? " " : "");
		}
		text = `${before}${after}`.replace(/\s+\./g, ".").replace(/\s{2,}/g, " ");
	}
	return text.trim();
}

const COOK_VERB_PATTERNS = [
	/\b(?:turbo)\p{L}*/giu,
	/\b(?:amas)\p{L}*/giu,
	/\b(?:tritur|troce|pic[ae]|pulveriz)\p{L}*/giu,
	/\b(?:mezcl|bati|mont|integra|remov)\p{L}*/giu,
	/\b(?:sofr|rehog|dor[ae]|poch)\p{L}*/giu,
	/\b(?:calent)\p{L}*/giu,
	/\b(?:program|cocin)\p{L}*/giu,
	/\b(?:emulsiona)\p{L}*/giu,
	/\b(?:cue[cz]|hirv|reduc|espes|tuest|fund)\p{L}*/giu,
];
const AFTER_COOK_PATTERN =
	/\b(?:retir|reserv|aclar|escurr|dej[ae]|sirv|repart|extiend|cubr|horne[ae])\w*/i;

function findLastCookVerb(sentence) {
	let best = null;
	for (const pattern of COOK_VERB_PATTERNS) {
		const re = new RegExp(pattern.source, "giu");
		let match = re.exec(sentence);
		while (match) {
			const word = match[0];
			if (/(?:ad|id)[oa]s?$/i.test(word)) {
				match = re.exec(sentence);
				continue;
			}
			if (!best || match.index >= best.index) {
				best = { index: match.index, length: match[0].length };
			}
			match = re.exec(sentence);
		}
	}
	return best;
}

/**
 * El TTS de la Thermomix llega hasta 120°C (más allá es horno u otro
 * electrodoméstico). Un chip a 180°C hace que Cookidoo devuelva 400 y el
 * reintento tira TODOS los programas de la receta, no solo el inválido.
 */
function isValidMachineProgram(template) {
	if (template.type === "MODE" && template.name === "steaming") {
		return true;
	}
	const temp = Number(template.data?.temperature?.value);
	return !temp || temp <= 120;
}

function placeChipAfterCookVerb(body, nativeChip) {
	const text = removeCookingChipsFromText(body);
	if (!nativeChip) {
		return { text, chipOffset: -1 };
	}

	let best = null;
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const dot = text.indexOf(".", searchFrom);
		const end = dot < 0 ? text.length : dot;
		const sentence = text.slice(searchFrom, end);
		if (/^\s*mientras\b/i.test(sentence)) {
			if (dot < 0) break;
			searchFrom = dot + 1;
			while (text[searchFrom] === " ") searchFrom += 1;
			continue;
		}
		const verb = findLastCookVerb(sentence);
		const isAfter = AFTER_COOK_PATTERN.test(sentence) && !verb;
		if (verb && !isAfter) {
			best = { sentenceStart: searchFrom, verb };
		}
		if (dot < 0) break;
		searchFrom = dot + 1;
		while (text[searchFrom] === " ") searchFrom += 1;
	}

	if (best) {
		const afterVerb = best.sentenceStart + best.verb.index + best.verb.length;
		const out = `${text.slice(0, afterVerb)} ${nativeChip}${text.slice(afterVerb)}`;
		return { text: out, chipOffset: afterVerb + 1 };
	}

	const firstDot = text.indexOf(".");
	if (firstDot > 0) {
		const out = `${text.slice(0, firstDot)} ${nativeChip}${text.slice(firstDot)}`;
		return { text: out, chipOffset: firstDot + 1 };
	}

	const sep = text ? " " : "";
	return {
		text: text + sep + nativeChip,
		chipOffset: text.length + sep.length,
	};
}

function buildStepInstruction(step, rows, opts = {}) {
	const withAnnotations = opts.withAnnotations !== false;
	const includeCookingAnnotations = opts.includeCookingAnnotations !== false;
	const indices = [...new Set(step.ingredient_indices || [])]
		.filter((i) => i >= 0 && i < rows.length)
		.sort((a, b) => a - b);

	const body = stripInternalStepNoise(step.text);
	const userChip =
		resolveTmModeChip({ tm_mode: step.tm_mode, text: "" }) ||
		resolveTmModeChip(step);
	let chipTemplate = null;
	let nativeChip = null;
	if (userChip) {
		const found = findCookingAnnotationsInText(userChip)[0];
		if (found && isValidMachineProgram(found)) {
			chipTemplate = found;
			nativeChip = buildCookidooNativeChip(found);
		}
	}

	const placed = placeChipAfterCookVerb(body, nativeChip);
	const text = placed.text || "paso";
	const instruction = { type: "STEP", text };
	if (!withAnnotations) {
		return instruction;
	}

	const annotations = buildInlineIngredientAnnotations(text, indices, rows);
	if (
		includeCookingAnnotations &&
		chipTemplate &&
		nativeChip &&
		placed.chipOffset >= 0 &&
		text.slice(placed.chipOffset, placed.chipOffset + nativeChip.length) ===
			nativeChip
	) {
		annotations.push(
			cookingAnnotationForUpload(chipTemplate, nativeChip, placed.chipOffset),
		);
	}

	const cleaned = keepValidAnnotations(text, annotations);
	if (cleaned.length > 0) {
		instruction.annotations = cleaned;
	}
	return instruction;
}

function buildInstructions(enrichedSteps, rows, opts = {}) {
	const built = enrichedSteps.map((step) =>
		buildStepInstruction(step, rows, opts),
	);
	return built.length > 0 ? built : [{ type: "STEP", text: "paso" }];
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
			const rawText = String(step.text || "");
			const hasAnns =
				Array.isArray(step.annotations) && step.annotations.length > 0;
			const out = {
				type: "STEP",
				text: hasAnns ? rawText : rawText.trim() || "paso",
			};
			if (hasAnns) {
				const cleaned = keepValidAnnotations(out.text, step.annotations);
				if (cleaned.length > 0) {
					out.annotations = cleaned;
				} else {
					out.text = rawText.trim() || "paso";
				}
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
 * @param {string} credentialsPath
 * @param {string} [cookiesPath]
 */
async function uploadCookidooNativeToAccount(native, credentialsPath, cookiesPath) {
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
	const { apiBase, baseOrigin, authHeaders } = await buildCookidooSession(
		creds,
		cookiesPath,
	);
	const { language } = creds;

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

	const createUrl = `${apiBase}/created-recipes/${encodeURIComponent(language)}`;
	const createRes = await fetch(createUrl, {
		method: "POST",
		headers: authHeaders,
		body: JSON.stringify({ recipeName: title }),
	});
	const createText = await createRes.text();
	if (!createRes.ok) {
		if (isAuthError(createRes.status)) {
			throw new Error(SESSION_EXPIRED_MESSAGE);
		}
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
		if (isAuthError(ingRes.status)) {
			throw new Error(SESSION_EXPIRED_MESSAGE);
		}
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
		if (isAuthError(stepRes.status)) {
			throw new Error(SESSION_EXPIRED_MESSAGE);
		}
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
async function uploadRecipeToCookidooAccount(recipe, credentialsPath, cookiesPath) {
	validateRecipeForUpload(recipe);

	const creds = await loadCookidooCredentials(credentialsPath);
	const { apiBase, baseOrigin, authHeaders } = await buildCookidooSession(
		creds,
		cookiesPath,
	);
	const { language } = creds;

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

	const createUrl = `${apiBase}/created-recipes/${encodeURIComponent(language)}`;
	const createRes = await fetch(createUrl, {
		method: "POST",
		headers: authHeaders,
		body: JSON.stringify({ recipeName: title }),
	});

	const createText = await createRes.text();
	if (!createRes.ok) {
		if (isAuthError(createRes.status)) {
			throw new Error(SESSION_EXPIRED_MESSAGE);
		}
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
		if (isAuthError(ingRes.status)) {
			throw new Error(SESSION_EXPIRED_MESSAGE);
		}
		throw new Error(
			`Cookidoo ingredientes HTTP ${ingRes.status}: ${ingRes.responseText.slice(0, 500)}`,
		);
	}

	await delay(2000);

	const patchInstructions = (opts) =>
		patchJson(patchUrl, authHeaders, {
			instructions: buildInstructions(enrichedSteps, rows, opts),
		});

	let stepRes = await patchInstructions({ withAnnotations: true });
	if (!stepRes.ok && stepRes.status === 400) {
		console.error(
			"Cookidoo rechazó ingredientes+TTS; reintento solo con programas de la máquina:",
			stepRes.responseText.slice(0, 800),
		);
		stepRes = await patchJson(patchUrl, authHeaders, {
			instructions: buildInstructions(enrichedSteps, rows, {
				withAnnotations: true,
				includeCookingAnnotations: true,
			}).map((built) => {
				if (Array.isArray(built.annotations)) {
					built.annotations = built.annotations.filter(
						(a) => a.type === "TTS" || a.type === "MODE",
					);
					if (built.annotations.length === 0) delete built.annotations;
				}
				return built;
			}),
		});
	}
	if (!stepRes.ok && stepRes.status === 400) {
		console.error(
			"Cookidoo rechazó los programas TTS; reintento solo con enlaces de ingredientes:",
			stepRes.responseText.slice(0, 500),
		);
		stepRes = await patchInstructions({
			withAnnotations: true,
			includeCookingAnnotations: false,
		});
	}
	if (!stepRes.ok && stepRes.status === 400) {
		console.error(
			"Cookidoo rechazó los enlaces de ingredientes en los pasos; reintento sin anotaciones:",
			stepRes.responseText.slice(0, 500),
		);
		stepRes = await patchInstructions({ withAnnotations: false });
	}

	if (!stepRes.ok && stepRes.status !== 204) {
		if (isAuthError(stepRes.status)) {
			throw new Error(SESSION_EXPIRED_MESSAGE);
		}
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
};
