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

	// WhatsApp limita el cuerpo de texto a 4096 caracteres. Partimos en trozos
	// (preferentemente por saltos de línea) para no cortar la receta a medias.
	const MAX_TEXT_LENGTH = 3900;

	function splitIntoChunks(text, max = MAX_TEXT_LENGTH) {
		const chunks = [];
		let remaining = text;
		while (remaining.length > max) {
			let cut = remaining.lastIndexOf("\n", max);
			if (cut < max * 0.5) {
				cut = remaining.lastIndexOf(" ", max);
			}
			if (cut < max * 0.5) {
				cut = max;
			}
			chunks.push(remaining.slice(0, cut).trim());
			remaining = remaining.slice(cut).trim();
		}
		if (remaining) {
			chunks.push(remaining);
		}
		return chunks;
	}

	async function sendText(to, body) {
		const text = normalizeBody(body);
		if (!text) {
			throw new Error("WhatsApp sendText: body vacío");
		}
		const chunks = splitIntoChunks(text);
		for (const chunk of chunks) {
			await apiRequest(
				{
					messaging_product: "whatsapp",
					to,
					type: "text",
					text: { body: chunk },
				},
				"sendText",
			);
		}
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

	async function sendUploadToCookidooButton(to, bodyText, promptText) {
		const full = normalizeBody(bodyText);
		// Mandamos la receta completa como mensajes de texto (sin recortar),
		// porque el cuerpo del botón interactivo está limitado a 1024 caracteres.
		if (full) {
			await sendText(to, full);
		}

		const prompt =
			(promptText && String(promptText).trim()) ||
			"Si la receta te gusta, pulsa «Subir a Cookidoo» 👇";

		await apiRequest(
			{
				messaging_product: "whatsapp",
				to,
				type: "interactive",
				interactive: {
					type: "button",
					body: { text: prompt },
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
