const { MAX_CONVERSATION_MESSAGES } = require("../constants");

const conversationStore = new Map();

function getConversation(from) {
	if (!conversationStore.has(from)) {
		conversationStore.set(from, {
			messages: [],
			summary: null,
			recipeReady: false,
			currentRecipeText: null,
		});
	}
	return conversationStore.get(from);
}

function pushConversationMessage(from, role, content) {
	const conversation = getConversation(from);
	const text =
		typeof content === "string"
			? content
			: typeof content?.content === "string"
				? content.content
				: String(content ?? "");
	conversation.messages.push({ role, content: text });
	if (conversation.messages.length > MAX_CONVERSATION_MESSAGES) {
		conversation.messages = conversation.messages.slice(
			-MAX_CONVERSATION_MESSAGES,
		);
	}
}

function setRecipeReady(from, ready) {
	getConversation(from).recipeReady = Boolean(ready);
}

function setCurrentRecipeText(from, text) {
	const conversation = getConversation(from);
	const trimmed = String(text || "").trim();
	conversation.currentRecipeText = trimmed || null;
}

function setConversationSummary(from, summary) {
	const conversation = getConversation(from);
	const trimmed = String(summary || "").trim();
	conversation.summary = trimmed || null;
}

function getConversationContext(from) {
	const conversation = getConversation(from);
	return {
		messages: conversation.messages,
		summary: conversation.summary,
		currentRecipeText: conversation.currentRecipeText,
	};
}

module.exports = {
	conversationStore,
	getConversation,
	pushConversationMessage,
	setRecipeReady,
	setCurrentRecipeText,
	setConversationSummary,
	getConversationContext,
};
