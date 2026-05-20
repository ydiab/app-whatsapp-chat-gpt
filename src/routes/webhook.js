const fs = require("node:fs/promises");
const express = require("express");
const { randomUUID } = require("node:crypto");
const { UPLOAD_TO_COOKIDOO_BUTTON_ID } = require("../constants");
const {
	getConversation,
	pushConversationMessage,
	setRecipeReady,
} = require("../store/conversationStore");
const {
	setLastCreatedRecipeId,
	getLastCreatedRecipeId,
} = require("../store/lastRecipeByUser");
const { formatRecipeForWhatsApp } = require("../utils/formatRecipeForWhatsApp");
const { recipeStore } = require("../store/recipeStore");
const { pushRecipeToCookidooBridge } = require("../services/cookidooBridge");
const { uploadRecipeToCookidooAccount } = require("../services/cookidooUpload");
const {
	parseCookidooJson,
	looksLikeCookidooJson,
} = require("../services/cookidooParse");

function createWebhookRouter({ config, whatsapp, recipeAi }) {
	const router = express.Router();

	router.get("/", (req, res) => {
		const {
			"hub.mode": mode,
			"hub.challenge": challenge,
			"hub.verify_token": token,
		} = req.query;

		if (mode === "subscribe" && token === config.verifyToken) {
			console.log("WEBHOOK VERIFIED");
			return res.status(200).send(challenge);
		}

		return res.status(403).end();
	});

	router.post("/", async (req, res) => {
		console.log("Webhook received");
		console.log(JSON.stringify(req.body, null, 2));

		res.status(200).end();

		try {
			const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

			if (!message) return;

			const from = message.from;
			const incomingMessageId = message.id;
			const userText = message.text?.body?.trim();
			const buttonId = message.interactive?.button_reply?.id;

			try {
				await whatsapp.sendTypingIndicator(incomingMessageId);
			} catch {
				// sendTypingIndicator ya registra el fallo; seguir con la respuesta
			}

			if (buttonId === UPLOAD_TO_COOKIDOO_BUTTON_ID) {
				const conversation = getConversation(from);
				if (!conversation.recipeReady) {
					await whatsapp.sendText(
						from,
						"Todavía no tengo una receta lista. Cuéntame qué quieres cocinar o pega un JSON de Cookidoo; cuando esté completa podrás pulsar «Subir a Cookidoo».",
					);
					return;
				}

				await whatsapp.sendText(
					from,
					"Perfecto, estoy subiendo tu receta a Cookidoo… ⏳",
				);

				const pendingId = getLastCreatedRecipeId(from);
				const stored = pendingId ? recipeStore.get(pendingId) : null;

				let recipe;
				let recipeId = pendingId;

				if (stored?.title && stored?.steps) {
					const { id, createdAt, source, ...rest } = stored;
					recipe = rest;
				} else if (conversation.messages.length > 0) {
					recipe = await recipeAi.generateRecipeForCookidoo(
						conversation.messages,
					);
					recipeId = randomUUID();
					recipeStore.set(recipeId, {
						id: recipeId,
						createdAt: new Date().toISOString(),
						...recipe,
					});
					setLastCreatedRecipeId(from, recipeId);
				} else {
					await whatsapp.sendText(
						from,
						"No encuentro la receta a subir. Vuelve a pegar el JSON o consensúa una receta conmigo.",
					);
					return;
				}

				let credentialsOk = false;
				try {
					await fs.access(config.cookidooCredentialsPath);
					credentialsOk = true;
				} catch {
					credentialsOk = false;
				}

				if (credentialsOk) {
					try {
						const { recipeUrl } = await uploadRecipeToCookidooAccount(
							recipe,
							config.cookidooCredentialsPath,
						);
						await whatsapp.sendText(
							from,
							`¡Listo! Tu receta ya está en Cookidoo ✅\n${recipe.title}\n\n${recipeUrl}`,
						);
					} catch (cookidooError) {
						console.error("Cookidoo upload error:", cookidooError);
						await whatsapp.sendText(
							from,
							`No pude subir la receta a Cookidoo: ${cookidooError.message}`,
						);
					}
					return;
				}

				if (config.cookidooBridgeUrl) {
					try {
						const { parsed } = await pushRecipeToCookidooBridge({
							bridgeUrl: config.cookidooBridgeUrl,
							bridgeSecret: config.cookidooBridgeSecret,
							recipe,
							whatsappFrom: from,
						});
						const link =
							parsed &&
							typeof parsed === "object" &&
							(parsed.cookidooRecipeUrl || parsed.url);
						await whatsapp.sendText(
							from,
							link
								? `Listo: receta enviada al puente Cookidoo.\n${link}`
								: "Listo: receta enviada al puente Cookidoo.",
						);
					} catch (bridgeError) {
						console.error("Cookidoo bridge error:", bridgeError);
						await whatsapp.sendText(
							from,
							`No pude completar la subida: ${bridgeError.message}`,
						);
					}
					return;
				}

				await whatsapp.sendText(
					from,
					"Para subir a Cookidoo necesitas cookidoo-credentials.json en el proyecto (copia cookidoo-credentials.example.json) o configurar COOKIDOO_BRIDGE_URL.",
				);
				return;
			}

			if (!userText) {
				await whatsapp.sendText(
					from,
					"Cuéntame qué quieres cocinar y lo vamos afinando juntas. Cuando te enseñe la receta completa, podrás subirla a Cookidoo.",
				);
				return;
			}

			if (looksLikeCookidooJson(userText)) {
				try {
					const recipe = parseCookidooJson(userText);
					const recipeId = randomUUID();
					recipeStore.set(recipeId, {
						id: recipeId,
						createdAt: new Date().toISOString(),
						...recipe,
					});
					setLastCreatedRecipeId(from, recipeId);
					setRecipeReady(from, true);

					const summary = formatRecipeForWhatsApp(recipe);
					pushConversationMessage(
						from,
						"user",
						`[JSON Cookidoo importado: ${recipe.title}]`,
					);
					pushConversationMessage(from, "assistant", summary);
					await whatsapp.sendUploadToCookidooButton(from, summary);
				} catch (importError) {
					console.error("Cookidoo JSON import:", importError);
					await whatsapp.sendText(
						from,
						`No pude importar ese JSON de Cookidoo: ${importError.message}`,
					);
				}
				return;
			}

			pushConversationMessage(from, "user", userText);
			const conversation = getConversation(from);
			const proposalResult =
				await recipeAi.generateThermomixProposal(conversation.messages);
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

			setRecipeReady(from, isComplete);
			pushConversationMessage(from, "assistant", proposal);

			if (isComplete) {
				await whatsapp.sendUploadToCookidooButton(from, proposal);
			} else {
				await whatsapp.sendText(from, proposal);
			}

			console.log("Reply sent");
		} catch (error) {
			console.error("Error sending reply:", error);
			try {
				const fallbackFrom =
					req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
				if (fallbackFrom) {
					await whatsapp.sendText(
						fallbackFrom,
						"Tuve un problema generando la respuesta. Inténtalo de nuevo con más detalle (ingredientes, tiempo, estilo).",
					);
				}
			} catch (sendError) {
				console.error("Error sending fallback message:", sendError);
			}
		}
	});

	return router;
}

module.exports = { createWebhookRouter };
