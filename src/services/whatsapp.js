const { CREATE_RECIPE_BUTTON_ID } = require("../constants");

function createWhatsAppService({ whatsappToken, phoneNumberId }) {
	const baseUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
	const headers = {
		Authorization: `Bearer ${whatsappToken}`,
		"Content-Type": "application/json",
	};

	async function sendText(to, body) {
		await fetch(baseUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to,
				type: "text",
				text: { body },
			}),
		});
	}

	async function sendTypingIndicator(messageId) {
		if (!messageId) return;

		await fetch(baseUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				messaging_product: "whatsapp",
				status: "read",
				message_id: messageId,
				typing_indicator: {
					type: "text",
				},
			}),
		});
	}

	async function sendCreateRecipeButton(to, bodyText) {
		await fetch(baseUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to,
				type: "interactive",
				interactive: {
					type: "button",
					body: {
						text: bodyText,
					},
					action: {
						buttons: [
							{
								type: "reply",
								reply: {
									id: CREATE_RECIPE_BUTTON_ID,
									title: "Crear Receta",
								},
							},
						],
					},
				},
			}),
		});
	}

	return {
		sendText,
		sendTypingIndicator,
		sendCreateRecipeButton,
	};
}

module.exports = { createWhatsAppService };
