const { UPLOAD_TO_COOKIDOO_BUTTON_ID } = require("../constants");

function createWhatsAppService({ whatsappToken, phoneNumberId }) {
	const baseUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
	const headers = {
		Authorization: `Bearer ${whatsappToken}`,
		"Content-Type": "application/json",
	};

	async function apiRequest(payload, label) {
		const response = await fetch(baseUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		const responseText = await response.text();
		if (!response.ok) {
			console.error(
				`WhatsApp ${label} failed HTTP ${response.status}:`,
				responseText.slice(0, 400),
			);
			throw new Error(
				`WhatsApp ${label} HTTP ${response.status}: ${responseText.slice(0, 200)}`,
			);
		}
		return responseText;
	}

	function normalizeBody(body) {
		if (typeof body === "string") {
			return body.trim();
		}
		if (body && typeof body.content === "string") {
			return body.content.trim();
		}
		return String(body ?? "").trim();
	}

	async function sendText(to, body) {
		const text = normalizeBody(body);
		if (!text) {
			throw new Error("WhatsApp sendText: body vacío");
		}
		await apiRequest(
			{
				messaging_product: "whatsapp",
				to,
				type: "text",
				text: { body: text },
			},
			"sendText",
		);
	}

	async function sendTypingIndicator(messageId) {
		if (!messageId) return;
		try {
			await apiRequest(
				{
					messaging_product: "whatsapp",
					status: "read",
					message_id: messageId,
					typing_indicator: { type: "text" },
				},
				"typing",
			);
		} catch (error) {
			// No bloquear la respuesta si falla el indicador de escritura
			console.warn("WhatsApp typing indicator:", error.message);
		}
	}

	async function sendUploadToCookidooButton(to, bodyText) {
		const text = normalizeBody(bodyText);
		if (!text) {
			throw new Error("WhatsApp sendUploadToCookidooButton: body vacío");
		}
		const body =
			text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
		await apiRequest(
			{
				messaging_product: "whatsapp",
				to,
				type: "interactive",
				interactive: {
					type: "button",
					body: { text: body },
					action: {
						buttons: [
							{
								type: "reply",
								reply: {
									id: UPLOAD_TO_COOKIDOO_BUTTON_ID,
									title: "Subir a Cookidoo",
								},
							},
						],
					},
				},
			},
			"sendUploadToCookidooButton",
		);
	}

	return {
		sendText,
		sendTypingIndicator,
		sendUploadToCookidooButton,
	};
}

module.exports = { createWhatsAppService };
