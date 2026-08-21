const { randomUUID } = require("node:crypto");
const {
	getConversation,
	pushConversationMessage,
	setRecipeReady,
	setCurrentRecipeText,
} = require("../store/conversationStore");
const { setLastCreatedRecipeId } = require("../store/lastRecipeByUser");
const { recipeStore } = require("../store/recipeStore");
const { validateRecipeForUpload } = require("../utils/validateRecipe");
const { prepareConversationForAi } = require("./conversationContext");

/**
 * Compacta historial si hace falta, pide propuesta a Mimi y opcionalmente
 * estructura la receta para Cookidoo cuando está completa.
 */
async function runChatTurn(userId, recipeAi, { channel = "whatsapp" } = {}) {
	const conversation = getConversation(userId);
	await prepareConversationForAi(conversation, recipeAi);

	const proposalResult = await recipeAi.generateThermomixProposal(
		conversation,
		{
			channel,
		},
	);
	const proposal =
		typeof proposalResult === "string"
			? proposalResult
			: String(proposalResult?.content ?? "").trim();
	const isComplete = Boolean(
		typeof proposalResult === "object" && proposalResult?.isComplete,
	);

	if (!proposal) {
		throw new Error("La propuesta de receta llegó vacía");
	}

	pushConversationMessage(userId, "assistant", proposal);

	if (isComplete) {
		setCurrentRecipeText(userId, proposal);
	}

	let recipe = null;
	let prepError = null;

	if (isComplete) {
		try {
			recipe = await recipeAi.generateRecipeForCookidoo(conversation);
			validateRecipeForUpload(recipe);
			const recipeId = randomUUID();
			recipeStore.set(recipeId, {
				id: recipeId,
				createdAt: new Date().toISOString(),
				...recipe,
			});
			setLastCreatedRecipeId(userId, recipeId);
			setRecipeReady(userId, true);
		} catch (error) {
			prepError = error;
			setRecipeReady(userId, false);
		}
	} else {
		setRecipeReady(userId, false);
	}

	return {
		conversation,
		proposal,
		isComplete,
		recipe,
		prepError,
	};
}

module.exports = { runChatTurn };
