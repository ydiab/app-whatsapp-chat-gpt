/**
 * Convierte JSON de receta Cookidoo (GET created-recipes, export) al formato interno
 * usado por cookidooUpload / recipeStore.
 */

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
		throw new Error("JSON de Cookidoo inválido");
	}
	if (input.recipeContent && typeof input.recipeContent === "object") {
		return {
			meta: input,
			content: input.recipeContent,
		};
	}
	if (input.ingredients || input.instructions) {
		return { meta: {}, content: input };
	}
	throw new Error(
		"No reconozco el JSON: falta recipeContent o ingredients/instructions",
	);
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
		if (variants.some((v) => v && (needle === v || needle.includes(v) || v.includes(needle)))) {
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

/**
 * Reconstruye chip tipo "7 min / 100°C / Vel 2 giro inverso" desde anotación TTS/MODE.
 */
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

	if (annotation?.type === "MODE" && name === "browning" && data.temperature?.value) {
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
		data.speed === "soft" || data.speed === "cuchara" ? "soft" : data.speed || "1";
	const rev = data.direction === "CCW" ? " giro inverso" : "";
	parts.push(`Vel ${speed}${rev}`);
	return parts.filter(Boolean).join(" / ");
}

function parseCookidooStep(step, ingredients) {
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

function parseHints(hints) {
	if (typeof hints === "string") {
		return hints.trim();
	}
	if (Array.isArray(hints)) {
		return hints
			.map((h) => (typeof h === "string" ? h : h?.text))
			.filter(Boolean)
			.join("\n\n");
	}
	return "";
}

/**
 * @param {string|object} input JSON string u objeto Cookidoo
 * @returns {object} Receta formato interno
 */
function parseCookidooJson(input) {
	const { meta, content } = unwrapCookidooPayload(input);

	const ingredients = parseIngredientsList(content.ingredients);
	const instructions = Array.isArray(content.instructions)
		? content.instructions
		: [];

	const steps = instructions
		.filter((s) => s?.type === "STEP" || s?.text)
		.map((step, index) => {
			const parsed = parseCookidooStep(step, ingredients);
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
	const hints = parseHints(content.hints ?? meta.hints);

	return {
		title: String(content.name || meta.name || "Receta importada").trim(),
		description: hints || "",
		difficulty: "media",
		total_time_min,
		servings,
		ingredients,
		steps,
		tags: ["importada-cookidoo"],
		nutrition_notes: "",
		source: {
			cookidooRecipeId: meta.recipeId || null,
			importedAt: new Date().toISOString(),
		},
	};
}

function looksLikeCookidooJson(text) {
	const t = String(text || "").trim();
	if (!t.startsWith("{")) {
		return false;
	}
	return (
		t.includes("recipeContent") ||
		t.includes('"instructions"') ||
		t.includes('"ingredients"')
	);
}

module.exports = {
	parseCookidooJson,
	looksLikeCookidooJson,
	unwrapCookidooPayload,
};
