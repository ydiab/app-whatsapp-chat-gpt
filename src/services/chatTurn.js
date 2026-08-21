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

async function prepareStructuredRecipe(userId, recipeAi, conversation) {
	let recipe = null;
	let prepError = null;

	for (let attempt = 0; attempt < 2; attempt++) {
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
			return { recipe, prepError: null, recipeId };
		} catch (error) {
			prepError = error;
			setRecipeReady(userId, false);
		}
	}

	return { recipe, prepError, recipeId: null };
}

/**
 * Compacta historial si hace falta, pide propuesta a Mimi y opcionalmente
 * estructura la receta para Cookidoo cuando está completa.
 *
 * `onEvent` (app): `{ type: 'reply'|'recipeText'|'recipeCard', text?, recipeId? }`
 * se llama en cuanto hay un trozo listo, sin esperar al resto.
 */
async function runChatTurn(userId, recipeAi, { channel = "whatsapp", onEvent } = {}) {
	const conversation = getConversation(userId);
	await prepareConversationForAi(conversation, recipeAi);

	let introFlushed = false;
	const proposalResult = await recipeAi.generateThermomixProposal(
		conversation,
		{
			channel,
			onPartial: ({ intro }) => {
				if (!intro || introFlushed) {
					return;
				}
				introFlushed = true;
				pushConversationMessage(userId, "assistant", intro);
				onEvent?.({ type: "reply", text: intro });
			},
		},
	);

	const intro = String(proposalResult?.intro ?? "").trim();
	const recipeText = String(proposalResult?.recipeText ?? "").trim();
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

	if (!introFlushed && intro) {
		pushConversationMessage(userId, "assistant", intro);
		onEvent?.({ type: "reply", text: intro });
	}

	if (recipeText) {
		pushConversationMessage(userId, "assistant", recipeText);
		onEvent?.({ type: "recipeText", text: recipeText });
	} else if (!introFlushed && !intro) {
		pushConversationMessage(userId, "assistant", proposal);
		onEvent?.({ type: "reply", text: proposal });
	}

	if (isComplete) {
		setCurrentRecipeText(userId, recipeText || proposal);
	}

	let recipe = null;
	let prepError = null;
	let recipeId = null;

	if (isComplete) {
		({ recipe, prepError, recipeId } = await prepareStructuredRecipe(
			userId,
			recipeAi,
			conversation,
		));
		if (recipeId) {
			onEvent?.({ type: "recipeCard", recipeId });
		}
	} else {
		setRecipeReady(userId, false);
	}

	return {
		conversation,
		proposal,
		intro,
		recipeText,
		isComplete,
		recipe,
		prepError,
		recipeId,
	};
}

module.exports = { runChatTurn };
