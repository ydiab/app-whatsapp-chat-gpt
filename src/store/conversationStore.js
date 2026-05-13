const conversationStore = new Map();

function getConversation(from) {
	if (!conversationStore.has(from)) {
		conversationStore.set(from, {
			messages: [],
			lastAssistantProposal: "",
		});
	}
	return conversationStore.get(from);
}

function pushConversationMessage(from, role, content) {
	const conversation = getConversation(from);
	conversation.messages.push({ role, content });
	if (conversation.messages.length > 20) {
		conversation.messages = conversation.messages.slice(-20);
	}
}

module.exports = {
	conversationStore,
	getConversation,
	pushConversationMessage,
};
