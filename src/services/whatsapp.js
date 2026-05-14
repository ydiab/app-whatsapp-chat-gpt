const {
	CREATE_RECIPE_BUTTON_ID,
	ADD_TO_COOKIDOO_BUTTON_ID,
} = require("../constants");

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

	/** Up to 3 reply buttons; titles max 20 chars each (WhatsApp). */
	async function sendRecipeIterationButtons(to, bodyText) {
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
							{
								type: "reply",
								reply: {
									id: ADD_TO_COOKIDOO_BUTTON_ID,
									title: "A mi Cookidoo",
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
		sendRecipeIterationButtons,
	};
}

module.exports = { createWhatsAppService };
