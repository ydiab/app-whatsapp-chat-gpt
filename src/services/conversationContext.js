const { COMPACT_THRESHOLD, KEEP_RECENT_MESSAGES } = require("../constants");

function formatMessagesForPrompt(messages) {
	return messages
		.map(
			(item) =>
				`${item.role === "assistant" ? "Asistente" : "Usuario"}: ${item.content}`,
		)
		.join("\n");
}

/**
 * Si el historial crece, resume los mensajes antiguos y deja solo los recientes.
 * La receta acordada vive aparte en `currentRecipeText` y no se pierde al compactar.
 */
async function prepareConversationForAi(conversation, recipeAi) {
	if (conversation.messages.length <= COMPACT_THRESHOLD) {
		return conversation;
	}

	const toSummarize = conversation.messages.slice(0, -KEEP_RECENT_MESSAGES);
	const recent = conversation.messages.slice(-KEEP_RECENT_MESSAGES);

	if (toSummarize.length === 0) {
		return conversation;
	}

	const summary = await recipeAi.summarizeConversation({
		priorSummary: conversation.summary,
		messages: toSummarize,
		currentRecipeText: conversation.currentRecipeText,
	});

	conversation.summary = summary;
	conversation.messages = recent;

	return conversation;
}

module.exports = {
	formatMessagesForPrompt,
	prepareConversationForAi,
};
