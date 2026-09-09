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
const { TASK_MODES } = require("../prompts/mimi");

const TM_HINT =
	/thermomix|cookidoo|varoma|giro inverso|vel(?:ocidad)?\s*(?:soft|\d)|vaso (?:de la )?(?:thermomix|máquina)/i;

function recipeLooksLikeThermomix(recipe) {
	if (recipe?.is_thermomix === true) {
		return true;
	}
	if (recipe?.is_thermomix === false) {
		return false;
	}

	const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
	if (steps.some((step) => String(step?.tm_mode || "").trim())) {
		return true;
	}

	const blob = [
		recipe?.title,
		...(recipe?.tags || []),
		...steps.map((step) => step?.text),
	]
		.filter(Boolean)
		.join(" ");
	return TM_HINT.test(blob);
}

function formatImportedRecipeForAi(recipe, { mode } = {}) {
	const isAdapt = mode === TASK_MODES.adaptar;
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

	const header = isAdapt
		? `MODO: ADAPTAR\nReceta Thermomix de partida (NO la reinventes): ${recipe.title}`
		: `MODO: TRADUCIR\nReceta de partida (no Thermomix; tradúcela al vaso sin cambiar el plato): ${recipe.title}`;

	const respectLines = isAdapt
		? [
				"Esta receta YA es de Thermomix. Tu trabajo es ADAPTARLA, no reescribirla.",
				"Mismos ingredientes, misma técnica, mismo orden de pasos.",
				"Si la usuaria pide raciones o calorías, escala cantidades y tiempos con criterio de cocina (no una regla de tres) para que quede rico.",
				"Velocidades y temperaturas: iguales. No fusiones ni partas pasos. No 'mejores' el plato.",
			]
		: [
				"Esta receta NO es de Thermomix. Tradúcela al vaso: mismos ingredientes y cantidades, técnica pasada a pasos con tiempo/temperatura/velocidad.",
				"No inventes un plato distinto ni añadas ingredientes por iniciativa propia.",
				"Si también pide raciones o calorías, aplica esa adaptación con criterio de cocina sobre la traducción.",
			];

	return [
		header,
		`Raciones originales: ${recipe.servings || "?"}`,
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
		"En los pasos, menciona cada ingrediente con el MISMO nombre que en la lista.",
		"No escribas ingredient_indices, corchetes de índice ni JSON en el texto que lee la usuaria.",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function publicImportedRecipe(recipe) {
	const { _partial, _cookidooNative, _cookidooRecipeId, ...rest } = recipe;
	return rest;
}

function followUpForImport(mode, instruction) {
	if (mode === TASK_MODES.adaptar) {
		return instruction
			? `ADAPTAR esta receta Thermomix a: ${instruction}. Quiero el MISMO plato, no una receta nueva. Escala cantidades y tiempos con criterio de cocina para que quede rico.`
			: "Quiero esta receta Thermomix TAL CUAL. No cambies ingredientes, cantidades, tiempos, velocidades ni técnica. Solo maquétala.";
	}

	return instruction
		? `TRADUCIR esta receta a Thermomix. Adaptación extra: ${instruction}. Mismos ingredientes; no inventes otro plato.`
		: "Traduce esta receta a Thermomix: mismos ingredientes y cantidades, técnica pasada al vaso.";
}

/**
 * Deja la receta importada como partida para ADAPTAR (ya TM) o TRADUCIR.
 * No escala en código: el modelo ajusta cantidades y tiempos con criterio de cocina.
 */
function seedImportedRecipe(
	userId,
	recipe,
	extraInstruction,
	{ assumedThermomix } = {},
) {
	resetConversation(userId);

	const instruction = String(extraInstruction || "").trim();
	const isThermomix =
		assumedThermomix === true ||
		(assumedThermomix !== false && recipeLooksLikeThermomix(recipe));
	const mode = isThermomix ? TASK_MODES.adaptar : TASK_MODES.traducir;

	const originalBlock = formatImportedRecipeForAi(recipe, { mode });
	pushConversationMessage(userId, "user", originalBlock);
	setCurrentRecipeText(userId, originalBlock);
	pushConversationMessage(userId, "user", followUpForImport(mode, instruction));
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

	seedImportedRecipe(userId, recipe, extraInstruction, {
		assumedThermomix: true,
	});

	return { imported: true, recipe, extraInstruction };
}

/**
 * Extrae la receta de capturas y la deja como partida para ADAPTAR o TRADUCIR.
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

	const mode = recipeLooksLikeThermomix(recipe)
		? TASK_MODES.adaptar
		: TASK_MODES.traducir;
	console.log(
		`Capturas → "${recipe.title}" · ${mode} · ${recipe.servings ?? "?"} raciones · ${recipe.ingredients.length} ingredientes`,
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
	recipeLooksLikeThermomix,
};
