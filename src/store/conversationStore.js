const conversationStore = new Map();

function getConversation(from) {
	if (!conversationStore.has(from)) {
		conversationStore.set(from, {
			messages: [],
			recipeReady: false,
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
	if (conversation.messages.length > 20) {
		conversation.messages = conversation.messages.slice(-20);
	}
}

function setRecipeReady(from, ready) {
	getConversation(from).recipeReady = Boolean(ready);
}

module.exports = {
	conversationStore,
	getConversation,
	pushConversationMessage,
	setRecipeReady,
};
