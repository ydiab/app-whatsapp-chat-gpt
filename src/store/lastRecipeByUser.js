/** Last structured recipe id created per WhatsApp user (for follow-up actions). */
const lastRecipeIdByWaId = new Map();

function setLastCreatedRecipeId(waId, recipeId) {
	lastRecipeIdByWaId.set(waId, recipeId);
}

function getLastCreatedRecipeId(waId) {
	return lastRecipeIdByWaId.get(waId);
}

module.exports = {
	setLastCreatedRecipeId,
	getLastCreatedRecipeId,
};
