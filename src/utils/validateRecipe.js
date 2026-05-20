function validateRecipeForUpload(recipe) {
	if (!recipe || typeof recipe !== "object") {
		throw new Error("No hay datos de receta para subir.");
	}
	if (!String(recipe.title || "").trim()) {
		throw new Error("La receta no tiene título.");
	}
	if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
		throw new Error("La receta no tiene ingredientes.");
	}
	if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
		throw new Error("La receta no tiene pasos.");
	}
	const hasContent = recipe.steps.some(
		(s) => String(s?.text || "").trim() || String(s?.tm_mode || "").trim(),
	);
	if (!hasContent) {
		throw new Error("Los pasos de la receta están vacíos.");
	}
}

function isStoredRecipeUsable(stored) {
	if (!stored?.title) {
		return false;
	}
	return (
		Array.isArray(stored.ingredients) &&
		stored.ingredients.length > 0 &&
		Array.isArray(stored.steps) &&
		stored.steps.length > 0
	);
}

function recipeToUploadPayload(stored) {
	const { id, createdAt, source, cookidooNative, ...rest } = stored;
	return rest;
}

module.exports = {
	validateRecipeForUpload,
	isStoredRecipeUsable,
	recipeToUploadPayload,
};
