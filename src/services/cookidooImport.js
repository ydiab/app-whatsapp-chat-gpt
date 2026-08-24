const {
	looksLikeCookidooUrl,
	extractCookidooUrl,
	extractRecipeIdFromUrl,
} = require("./cookidooParse");
const { fetchCookidooRecipe } = require("./cookidooFetch");
const {
	pushConversationMessage,
	setCurrentRecipeText,
} = require("../store/conversationStore");

function formatImportedRecipeForAi(recipe) {
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

	return [
		`Receta original de Cookidoo (BASE FIJA): ${recipe.title}`,
		`Raciones originales: ${recipe.servings || "?"}`,
		`Tiempo: ~${recipe.total_time_min || "?"} min`,
		calories ? `Nutrición original: ${calories}` : "",
		"",
		"Ingredientes originales:",
		ingLines || "(sin ingredientes)",
		"",
		"Pasos originales:",
		stepLines || "(sin pasos)",
		"",
		"IMPORTANTE: respeta EXACTAMENTE estos ingredientes, cantidades y pasos.",
		"NO la mejores ni cambies proporciones por iniciativa propia.",
		"Solo conviértela a formato Thermomix y aplica ÚNICAMENTE la adaptación que pida la usuaria (raciones, calorías, sin gluten, etc.).",
		"Si la adaptación cambia las raciones o calorías, ajusta también los tiempos de cocción/sofrito/calentado al nuevo volumen (mantén velocidades y temperaturas; el horno convencional no cambia).",
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
 * Deja la receta importada como BASE FIJA en el historial y añade la instrucción
 * de adaptación (o "tal cual" si no hay ninguna). Compartido por la importación
 * desde URL y desde capturas de pantalla.
 */
function seedImportedRecipe(userId, recipe, extraInstruction) {
	const originalBlock = formatImportedRecipeForAi(recipe);
	pushConversationMessage(userId, "user", originalBlock);
	setCurrentRecipeText(userId, originalBlock);

	const instruction = String(extraInstruction || "").trim();
	if (instruction) {
		pushConversationMessage(
			userId,
			"user",
			`Adaptación que quiero: ${instruction}`,
		);
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
