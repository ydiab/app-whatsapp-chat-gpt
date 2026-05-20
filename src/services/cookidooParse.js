/**
 * Convierte JSON de receta al formato interno (Mimi / export / API Cookidoo).
 */

const { normalizeTmModeChip } = require("../utils/thermomixCookidoo");

function normalizeLine(s) {
	return String(s)
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

function unwrapCookidooPayload(input) {
	if (typeof input === "string") {
		const trimmed = input.trim();
		const jsonText = trimmed.startsWith("```")
			? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
			: trimmed;
		input = JSON.parse(jsonText);
	}
	if (!input || typeof input !== "object") {
		throw new Error("JSON de receta inválido");
	}
	if (input.recipeContent && typeof input.recipeContent === "object") {
		return {
			meta: input,
			content: input.recipeContent,
		};
	}
	if (input.ingredients || input.instructions || input.steps) {
		return { meta: input, content: input };
	}
	throw new Error(
		"No reconozco el JSON: falta recipeContent, ingredients o steps",
	);
}

/** JSON devuelto por la API Cookidoo (ingredientes con .text o type INGREDIENT). */
function isCookidooApiContent(content) {
	const ing = content?.ingredients;
	if (!Array.isArray(ing) || ing.length === 0) {
		return false;
	}
	return ing.some(
		(i) => i?.type === "INGREDIENT" || typeof i?.text === "string",
	);
}

/** JSON exportado por Mimi / asistente (name + quantity numérico + steps[].instruction). */
function isMimiExportContent(content) {
	const ing = content?.ingredients;
	if (!Array.isArray(ing) || ing.length === 0) {
		return false;
	}
	return ing.some(
		(i) => i?.name != null && (i?.quantity != null || i?.unit != null),
	);
}

function parseIsoDuration(value) {
	const s = String(value || "");
	const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
	if (!m) {
		return null;
	}
	const h = Number(m[1] || 0);
	const min = Number(m[2] || 0);
	const sec = Number(m[3] || 0);
	return h * 3600 + min * 60 + sec;
}

function parseYieldToServings(yieldValue) {
	if (yieldValue == null) {
		return 4;
	}
	if (typeof yieldValue === "object" && yieldValue.value != null) {
		return Number(yieldValue.value) || 4;
	}
	const m = String(yieldValue).match(/(\d+)/);
	return m ? Number(m[1]) : 4;
}

function parseExportIngredient(item) {
	const name = String(item.name || "").trim();
	const unit = String(item.unit || "g").trim().toLowerCase();
	const q = item.quantity;

	if (!name) {
		return { name: "", quantity: "" };
	}
	if (unit === "pizca" || unit === "pizcas") {
		return { name, quantity: "1 pizca" };
	}
	if (q != null && q !== "") {
		return { name, quantity: `${q} ${unit}`.trim() };
	}
	return { name, quantity: "" };
}

/**
 * Separa texto del paso y chip Thermomix (ej. "6 min/120°C/vel cuchara").
 */
function splitInstructionAndTm(instruction) {
	const full = String(instruction || "").trim();
	if (!full) {
		return { text: "", tm_mode: "" };
	}

	const patterns = [
		/\d+\s*min(?:utos?)?\s*\/\s*\d+\s*°\s*C(?:\s*\/\s*)?(?:giro\s*inverso(?:\s*\/\s*)?)?(?:vel(?:ocidad)?\.?\s*)?(?:cuchara|soft|[\d.,]+)/gi,
		/\d+\s*seg(?:undos?)?\s*\/\s*vel(?:ocidad)?\.?\s*[\d.,]+/gi,
		/\d+\s*s\s*\/\s*vel(?:ocidad)?\.?\s*[\d.,]+/gi,
	];

	let chipRaw = null;
	for (const re of patterns) {
		const matches = [...full.matchAll(re)];
		if (matches.length > 0) {
			chipRaw = matches[matches.length - 1][0];
		}
	}

	if (!chipRaw) {
		return { text: full, tm_mode: "" };
	}

	const tm_mode =
		normalizeTmModeChip(chipRaw.replace(/\//g, " / ")) || chipRaw;
	let text = full.replace(chipRaw, "").trim();
	text = text.replace(/\s*\.\s*Retire y reserve\.?\s*$/i, "").trim();

	return { text, tm_mode };
}

function inferIngredientIndicesForStep(stepText, ingredients) {
	const indices = [];
	const hay = normalizeLine(stepText);
	for (let i = 0; i < ingredients.length; i++) {
		const fullName = normalizeLine(ingredients[i].name);
		if (fullName.length < 3) continue;
		// Prueba el nombre completo primero, luego prefijos progresivamente
		// más cortos (p. ej. "esparragos trigueros" → "esparragos").
		const words = fullName.split(/\s+/);
		let matched = false;
		for (let len = words.length; len >= 1 && !matched; len--) {
			const candidate = words.slice(0, len).join(" ");
			if (candidate.length >= 3 && hay.includes(candidate)) {
				matched = true;
			}
		}
		if (matched) indices.push(i);
	}
	return [...new Set(indices)].sort((a, b) => a - b);
}

function ingredientDescriptionFromAnnotation(ann) {
	const desc = ann?.data?.description;
	if (typeof desc === "string") {
		return desc.trim();
	}
	if (desc && typeof desc.text === "string") {
		return desc.text.trim();
	}
	return "";
}

function parseIngredientText(line) {
	const text = String(line || "").trim();
	const deMatch = text.match(/^(\d+(?:[.,]\d+)?\s*g)\s+de\s+(.+)$/i);
	if (deMatch) {
		return {
			quantity: deMatch[1].replace(",", ".").trim(),
			name: deMatch[2].trim(),
		};
	}
	const gMatch = text.match(/^(\d+(?:[.,]\d+)?\s*g)\s+(.+)$/i);
	if (gMatch) {
		return {
			quantity: gMatch[1].replace(",", ".").trim(),
			name: gMatch[2].trim(),
		};
	}
	return { quantity: "", name: text };
}

function parseIngredientsList(rawIngredients) {
	const list = Array.isArray(rawIngredients) ? rawIngredients : [];
	return list
		.filter((item) => item?.type === "INGREDIENT" || item?.text)
		.map((item) => {
			const line =
				typeof item.text === "string"
					? item.text.trim()
					: ingredientDescriptionFromAnnotation({
							data: { description: item.description ?? item },
						});
			return parseIngredientText(line);
		})
		.filter((item) => item.name || item.quantity);
}

function findIngredientIndex(line, ingredients) {
	const needle = normalizeLine(line);
	if (!needle) {
		return -1;
	}
	for (let i = 0; i < ingredients.length; i++) {
		const ing = ingredients[i];
		const variants = [
			normalizeLine(`${ing.quantity} de ${ing.name}`),
			normalizeLine(`${ing.quantity} ${ing.name}`),
			normalizeLine(ing.name),
		];
		if (
			variants.some(
				(v) => v && (needle === v || needle.includes(v) || v.includes(needle)),
			)
		) {
			return i;
		}
	}
	return -1;
}

function formatTimePart(seconds) {
	const s = Number(seconds);
	if (!Number.isFinite(s) || s <= 0) {
		return null;
	}
	if (s < 60) {
		return `${Math.round(s)} seg`;
	}
	if (s % 60 === 0) {
		return `${s / 60} min`;
	}
	return `${Math.max(1, Math.round(s / 60))} min`;
}

function cookingDataToChip(annotation, textSlice) {
	if (textSlice) {
		return textSlice;
	}
	const data = annotation?.data || {};
	const name = annotation?.name;

	if (annotation?.type === "MODE" && name === "steaming") {
		const parts = [];
		const t = formatTimePart(data.time);
		if (t) parts.push(t);
		parts.push("Varoma");
		const speed = data.speed === "soft" ? "soft" : data.speed || "1";
		const rev = data.direction === "CCW" ? " giro inverso" : "";
		parts.push(`Vel ${speed}${rev}`);
		return parts.join(" / ");
	}

	if (
		annotation?.type === "MODE" &&
		name === "browning" &&
		data.temperature?.value
	) {
		const parts = [];
		const t = formatTimePart(data.time);
		if (t) parts.push(t);
		parts.push(`${data.temperature.value}°C`);
		parts.push("Vel 1");
		return parts.join(" / ");
	}

	const parts = [];
	const t = formatTimePart(data.time);
	if (t) parts.push(t);
	if (data.temperature?.value) {
		parts.push(`${data.temperature.value}°C`);
	} else if (data.accessory === "Varoma") {
		parts.push("Varoma");
	}
	const speed =
		data.speed === "soft" || data.speed === "cuchara"
			? "soft"
			: data.speed || "1";
	const rev = data.direction === "CCW" ? " giro inverso" : "";
	parts.push(`Vel ${speed}${rev}`);
	return parts.filter(Boolean).join(" / ");
}

function parseCookidooApiStep(step, ingredients) {
	const text = step?.text != null ? String(step.text) : "";
	const annotations = Array.isArray(step?.annotations) ? step.annotations : [];

	const ingAnns = annotations.filter(
		(a) => a.type === "INGREDIENT" || a.type === "MISSED_INGREDIENT",
	);
	const cookAnns = annotations.filter(
		(a) => a.type === "TTS" || a.type === "MODE",
	);

	const ingredientLines = ingAnns.map((ann) => {
		const fromText = text.slice(
			ann.position?.offset ?? 0,
			(ann.position?.offset ?? 0) + (ann.position?.length ?? 0),
		);
		return fromText.trim() || ingredientDescriptionFromAnnotation(ann);
	});

	const indices = [
		...new Set(
			ingredientLines
				.map((line) => findIngredientIndex(line, ingredients))
				.filter((i) => i >= 0),
		),
	].sort((a, b) => a - b);

	let tm_mode = "";
	if (cookAnns.length > 0) {
		const ann = cookAnns[0];
		const pos = ann.position || { offset: 0, length: 0 };
		const slice = text.slice(pos.offset, pos.offset + pos.length).trim();
		tm_mode = cookingDataToChip(ann, slice);
	}

	let bodyStart = 0;
	let bodyEnd = text.length;
	if (ingAnns.length > 0) {
		const last = ingAnns[ingAnns.length - 1];
		bodyStart = (last.position?.offset ?? 0) + (last.position?.length ?? 0);
	}
	if (cookAnns.length > 0) {
		bodyEnd = cookAnns[0].position?.offset ?? bodyEnd;
	}
	let stepText = text.slice(bodyStart, bodyEnd).replace(/^\n+|\n+$/g, "").trim();
	if (!stepText && text && !tm_mode) {
		stepText = text.trim();
	}

	return {
		text: stepText,
		tm_mode,
		ingredient_indices: indices,
	};
}

function parseMimiExportContent(meta, content) {
	const ingredients = (content.ingredients || [])
		.map(parseExportIngredient)
		.filter((i) => i.name);

	const rawSteps = content.steps || content.instructions || [];
	const steps = rawSteps.map((step, index) => {
		const instruction =
			step.instruction ?? step.text ?? step.description ?? "";
		const { text, tm_mode } = splitInstructionAndTm(instruction);
		const stepText = text || String(step.name || "").trim() || instruction;
		let indices = inferIngredientIndicesForStep(
			`${stepText} ${step.name || ""}`,
			ingredients,
		);
		if (indices.length === 0 && !tm_mode) {
			indices = inferIngredientIndicesForStep(instruction, ingredients);
		}

		return {
			order: step.order ?? index + 1,
			text: stepText,
			tm_mode,
			ingredient_indices: indices,
		};
	});

	const totalSec =
		parseIsoDuration(content.totalTime) ||
		parseIsoDuration(meta.totalTime) ||
		0;
	const prepSec =
		parseIsoDuration(content.preparationTime) ||
		parseIsoDuration(content.prepTime) ||
		0;
	const total_time_min =
		totalSec > 0
			? Math.max(1, Math.round(totalSec / 60))
			: prepSec > 0
				? Math.max(1, Math.round(prepSec / 60))
				: 30;

	const servings = parseYieldToServings(content.yield ?? meta.yield);
	const nutrition = content.nutrition;
	const nutrition_notes = nutrition
		? `~${nutrition.caloriesPerServing ?? "?"} kcal/porción · P ${nutrition.protein ?? "?"} · G ${nutrition.fat ?? "?"} · HC ${nutrition.carbohydrates ?? "?"}`
		: "";

	return {
		title: String(content.name || meta.name || "Receta importada").trim(),
		description: String(content.description || meta.description || "").trim(),
		difficulty: "media",
		total_time_min,
		servings,
		ingredients,
		steps,
		tags: Array.isArray(content.tags) ? content.tags : ["importada"],
		nutrition_notes,
		source: {
			format: "mimi-export",
			importedAt: new Date().toISOString(),
		},
	};
}

function parseCookidooApiContent(meta, content) {
	const ingredients = parseIngredientsList(content.ingredients);
	const instructions = Array.isArray(content.instructions)
		? content.instructions
		: [];

	const steps = instructions
		.filter((s) => s?.type === "STEP" || s?.text)
		.map((step, index) => {
			const parsed = parseCookidooApiStep(step, ingredients);
			return {
				order: index + 1,
				...parsed,
			};
		});

	const totalSeconds = Number(content.totalTime ?? meta.totalTime) || 0;
	const prepSeconds = Number(content.prepTime ?? meta.prepTime) || 0;
	const total_time_min =
		totalSeconds > 0
			? Math.max(1, Math.round(totalSeconds / 60))
			: prepSeconds > 0
				? Math.max(1, Math.round(prepSeconds / 60))
				: 30;

	const servings = Number(content.yield?.value ?? meta.yield?.value) || 4;
	const hints =
		typeof content.hints === "string"
			? content.hints
			: Array.isArray(content.hints)
				? content.hints.join("\n\n")
				: "";

	return {
		title: String(content.name || meta.name || "Receta importada").trim(),
		description: hints || String(content.description || "").trim(),
		difficulty: "media",
		total_time_min,
		servings,
		ingredients,
		steps,
		tags: ["importada-cookidoo"],
		nutrition_notes: "",
		source: {
			format: "cookidoo-api",
			cookidooRecipeId: meta.recipeId || null,
			importedAt: new Date().toISOString(),
		},
	};
}

/**
 * @param {string|object} input
 * @returns {object}
 */
function parseCookidooJson(input) {
	const { meta, content } = unwrapCookidooPayload(input);

	if (isCookidooApiContent(content)) {
		return parseCookidooApiContent(meta, content);
	}
	if (isMimiExportContent(content) || Array.isArray(content.steps)) {
		return parseMimiExportContent(meta, content);
	}
	return parseCookidooApiContent(meta, content);
}

function looksLikeRecipeJson(text) {
	const t = String(text || "").trim();
	if (!t.startsWith("{")) {
		return false;
	}
	return (
		t.includes("recipeContent") ||
		t.includes('"ingredients"') ||
		t.includes('"instructions"') ||
		t.includes('"steps"')
	);
}

module.exports = {
	parseCookidooJson,
	looksLikeCookidooJson: looksLikeRecipeJson,
	looksLikeRecipeJson,
	unwrapCookidooPayload,
	isCookidooApiContent,
};
