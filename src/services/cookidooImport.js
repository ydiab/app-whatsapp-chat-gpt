const {
	looksLikeCookidooUrl,
	extractCookidooUrl,
	extractRecipeIdFromUrl,
} = require("./cookidooParse");
const { fetchCookidooRecipe } = require("./cookidooFetch");
const {
	pushConversationMessage,
	setCurrentRecipeText,
	resetConversation,
} = require("../store/conversationStore");
const { inferServingsChange, scaleRecipe } = require("../utils/scaleRecipe");

function formatImportedRecipeForAi(recipe, { scaledFrom } = {}) {
	const ingLines = (recipe.ingredients || [])
		.map((item) =>
			[item.quantity, item.name].filter(Boolean).join(" de ").trim(),
		)
		.filter(Boolean)
		.map((line) => `- ${line}`)
		.join("\n");

	const stepLines = (recipe.steps || [])
		.map((step, index) => {
			const n = step.order ?? index + 1;
			const chip = step.tm_mode ? ` (${step.tm_mode})` : "";
			return `${n}. ${step.text || ""}${chip}`.trim();
		})
		.join("\n");

	const calories = recipe.calories_per_serving
		? `~${recipe.calories_per_serving} kcal/ración`
		: recipe.nutrition_notes || "";

	const servingsLine = scaledFrom
		? `Raciones: ${recipe.servings} (ya escalada desde ${scaledFrom}; NO vuelvas a multiplicar)`
		: `Raciones originales: ${recipe.servings || "?"}`;

	const respectLines = scaledFrom
		? [
				"IMPORTANTE: estas cantidades Y los tiempos YA están adaptados a las raciones pedidas.",
				"Cópialos EXACTAMENTE. NO multipliques otra vez ni dejes los valores originales de las capturas.",
				"Cocción/sofrito un poco más largos; picar/mezclar y horno suben menos (no al doble). Velocidades, temperaturas y el precalentamiento del horno no se tocan.",
				"Solo conviértela a formato Thermomix (pasos con tiempo/temperatura/velocidad).",
			]
		: [
				"IMPORTANTE: respeta EXACTAMENTE estos ingredientes, cantidades y pasos.",
				"NO la mejores ni cambies proporciones por iniciativa propia.",
				"Solo conviértela a formato Thermomix y aplica ÚNICAMENTE la adaptación que pida la usuaria (raciones, calorías, sin gluten, etc.).",
				"Si la adaptación cambia las raciones o calorías, ajusta también los tiempos al nuevo volumen: cocción/sofrito un poco más (no el doble); picar/mezclar y horno aún menos; velocidades, temperaturas y precalentamiento iguales.",
			];

	return [
		`Receta original de Cookidoo (BASE FIJA): ${recipe.title}`,
		servingsLine,
		`Tiempo: ~${recipe.total_time_min || "?"} min`,
		calories ? `Nutrición original: ${calories}` : "",
		"",
		"Ingredientes:",
		ingLines || "(sin ingredientes)",
		"",
		"Pasos:",
		stepLines || "(sin pasos)",
		"",
		...respectLines,
		"En los pasos, menciona cada ingrediente con el MISMO nombre que en la lista (p. ej. jamón cocido, no jamón de York).",
		"No escribas ingredient_indices, corchetes de índice ni JSON en el texto que lee la usuaria.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function publicImportedRecipe(recipe) {
	const { _partial, _cookidooNative, _cookidooRecipeId, ...rest } = recipe;
	return rest;
}

/**
 * Deja la receta importada como BASE FIJA. Si pide otras raciones, escala las
 * cantidades EN CÓDIGO: el modelo copiaba el original y no multiplicaba.
 */
function seedImportedRecipe(userId, recipe, extraInstruction) {
	resetConversation(userId);

	const instruction = String(extraInstruction || "").trim();
	const change = inferServingsChange(instruction, recipe.servings);
	let toSeed = recipe;
	let scaledFrom = null;

	if (change) {
		toSeed = scaleRecipe(recipe, change.original, change.target);
		scaledFrom = change.original;
		console.log(
			`Escalado en código: ${change.original} → ${change.target} raciones (factor ${change.target}/${change.original})`,
		);
		const sample = (toSeed.ingredients || [])
			.slice(0, 3)
			.map((item) => `${item.quantity} ${item.name}`)
			.join("; ");
		if (sample) {
			console.log(`Ingredientes tras escalar: ${sample}`);
		}
		const timeSample = (toSeed.steps || [])
			.filter((step) => step.tm_mode)
			.slice(0, 4)
			.map((step) => step.tm_mode)
			.join(" · ");
		if (timeSample) {
			console.log(`Tiempos tras escalar: ${timeSample}`);
		}
	}

	const originalBlock = formatImportedRecipeForAi(toSeed, { scaledFrom });
	pushConversationMessage(userId, "user", originalBlock);
	setCurrentRecipeText(userId, originalBlock);

	if (instruction) {
		const followUp = scaledFrom
			? `Adaptación extra (además del cambio a ${toSeed.servings} raciones, ya aplicado en cantidades y tiempos de cocción): ${instruction}`
			: `Adaptación que quiero: ${instruction}`;
		pushConversationMessage(userId, "user", followUp);
	} else {
		pushConversationMessage(
			userId,
			"user",
			"Quiero esta receta tal cual, convertida a formato Thermomix, sin cambiar ingredientes ni cantidades.",
		);
	}
}

/**
 * Si el mensaje trae una URL de Cookidoo, descarga el JSON-LD y deja la receta
 * original en el historial para que Mimi la copie o la adapte.
 * @returns {Promise<{ imported: boolean, recipe?: object, extraInstruction?: string }>}
 */
async function seedCookidooUrlIfPresent({
	userId,
	userText,
	credentialsPath,
	cookiesPath,
}) {
	if (!looksLikeCookidooUrl(userText)) {
		return { imported: false };
	}

	const recipeId = extractRecipeIdFromUrl(userText);
	const pageUrl = extractCookidooUrl(userText);
	if (!recipeId) {
		throw new Error("No pude leer el id de receta en ese enlace de Cookidoo.");
	}

	const extraInstruction = String(userText || "")
		.replace(/https?:\/\/\S+/g, "")
		.trim();

	const raw = await fetchCookidooRecipe(
		recipeId,
		credentialsPath,
		cookiesPath,
		pageUrl,
	);
	const recipe = publicImportedRecipe(raw);

	if (!recipe.ingredients?.length) {
		throw new Error(
			"La página de Cookidoo no trajo ingredientes. Prueba otro enlace o pega el JSON.",
		);
	}

	seedImportedRecipe(userId, recipe, extraInstruction);

	return { imported: true, recipe, extraInstruction };
}

/**
 * Igual que seedCookidooUrlIfPresent pero a partir de capturas de pantalla:
 * extrae la receta de las imágenes con visión y la deja como BASE FIJA en el
 * historial para que Mimi la clone aplicando solo la adaptación pedida.
 * @param {object} args
 * @param {string} args.userId
 * @param {string[]} args.images data URLs o URLs http(s) de las capturas.
 * @param {string} [args.extraInstruction] adaptación pedida (texto del mensaje).
 * @param {object} args.recipeAi servicio con extractRecipeFromImages.
 * @returns {Promise<{ imported: boolean, recipe?: object, extraInstruction?: string }>}
 */
async function seedCookidooImagesIfPresent({
	userId,
	images,
	extraInstruction,
	recipeAi,
}) {
	const list = (Array.isArray(images) ? images : []).filter(
		(img) => typeof img === "string" && img.trim(),
	);
	if (list.length === 0) {
		return { imported: false };
	}

	const raw = await recipeAi.extractRecipeFromImages(list);
	const recipe = publicImportedRecipe(raw);

	if (!recipe.ingredients?.length) {
		throw new Error(
			"No pude leer los ingredientes de esas capturas. Prueba con imágenes más nítidas o que incluyan la lista completa.",
		);
	}

	console.log(
		`Capturas Cookidoo → "${recipe.title}" · ${recipe.servings ?? "?"} raciones · ${recipe.ingredients.length} ingredientes`,
	);

	seedImportedRecipe(userId, recipe, extraInstruction);

	return {
		imported: true,
		recipe,
		extraInstruction: String(extraInstruction || "").trim(),
	};
}

module.exports = {
	seedCookidooUrlIfPresent,
	seedCookidooImagesIfPresent,
	formatImportedRecipeForAi,
};
