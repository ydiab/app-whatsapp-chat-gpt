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
		"En los pasos, menciona cada ingrediente con el MISMO nombre que en la lista (p. ej. jamón cocido, no jamón de York).",
		"No escribas ingredient_indices, corchetes de índice ni JSON en el texto que lee la usuaria.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function publicImportedRecipe(recipe) {
	const {
		_partial,
		_cookidooNative,
		_cookidooRecipeId,
		...rest
	} = recipe;
	return rest;
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

	const originalBlock = formatImportedRecipeForAi(recipe);
	pushConversationMessage(userId, "user", originalBlock);
	setCurrentRecipeText(userId, originalBlock);

	if (extraInstruction) {
		pushConversationMessage(
			userId,
			"user",
			`Adaptación que quiero: ${extraInstruction}`,
		);
	} else {
		pushConversationMessage(
			userId,
			"user",
			"Quiero esta receta tal cual, convertida a formato Thermomix, sin cambiar ingredientes ni cantidades.",
		);
	}

	return { imported: true, recipe, extraInstruction };
}

module.exports = { seedCookidooUrlIfPresent, formatImportedRecipeForAi };
