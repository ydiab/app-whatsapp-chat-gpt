const fs = require("node:fs/promises");
const express = require("express");
const { randomUUID } = require("node:crypto");
const {
	CREATE_RECIPE_BUTTON_ID,
	ADD_TO_COOKIDOO_BUTTON_ID,
} = require("../constants");
const {
	getConversation,
	pushConversationMessage,
} = require("../store/conversationStore");
const {
	setLastCreatedRecipeId,
	getLastCreatedRecipeId,
} = require("../store/lastRecipeByUser");
const { recipeStore } = require("../store/recipeStore");
const { pushRecipeToCookidooBridge } = require("../services/cookidooBridge");
const { uploadRecipeToCookidooAccount } = require("../services/cookidooUpload");
const {
	buildInvisibleRecipeUrl,
	buildMetadataUrl,
} = require("../utils/publicUrls");

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

			await whatsapp.sendTypingIndicator(incomingMessageId);

			if (buttonId === CREATE_RECIPE_BUTTON_ID) {
				const conversation = getConversation(from);
				if (conversation.messages.length === 0) {
					await whatsapp.sendText(
						from,
						"No tengo contexto todavía. Escríbeme primero qué receta quieres (ej: arroz con pollo saludable).",
					);
					return;
				}

				const recipe = await recipeAi.generateFinalThermomixRecipe(
					conversation.messages,
				);
				const recipeId = randomUUID();
				const createdAt = new Date().toISOString();
				const recipeRecord = {
					id: recipeId,
					createdAt,
					sourcePrompt: conversation.messages
						.filter((item) => item.role === "user")
						.map((item) => item.content)
						.join(" | "),
					...recipe,
				};
				recipeStore.set(recipeId, recipeRecord);
				setLastCreatedRecipeId(from, recipeId);

				const recipeUrl = buildInvisibleRecipeUrl(
					req,
					recipeId,
					config.publicBaseUrl,
				);
				const metadataUrl = buildMetadataUrl(
					req,
					recipeId,
					config.publicBaseUrl,
				);
				await whatsapp.sendText(
					from,
					`Receta creada ✅\n${recipe.title} (${recipe.total_time_min} min, ${recipe.servings} porciones)\n\nURL Cookidoo-ready (HTML invisible): ${recipeUrl}\nMetadata JSON: ${metadataUrl}`,
				);
				return;
			}

			if (buttonId === ADD_TO_COOKIDOO_BUTTON_ID) {
				const lastId = getLastCreatedRecipeId(from);
				const recipe = lastId ? recipeStore.get(lastId) : null;

				if (!recipe) {
					await whatsapp.sendText(
						from,
						"Primero pulsa «Crear Receta» para generar la receta estructurada. Después podrás usar «A mi Cookidoo» con esa última receta.",
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
							`Receta añadida a tu Cookidoo ✅\n${recipeUrl}`,
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
								? `Listo: la receta se envió al puente Cookidoo.\n${link}`
								: "Listo: la receta se envió al puente Cookidoo (revisa tu cuenta / respuesta del puente).",
						);
					} catch (bridgeError) {
						console.error("Cookidoo bridge error:", bridgeError);
						await whatsapp.sendText(
							from,
							`No pude completar la subida vía puente: ${bridgeError.message}`,
						);
					}
					return;
				}

				await whatsapp.sendText(
					from,
					`Para subir la receta a tu cuenta Cookidoo, crea el fichero cookidoo-credentials.json en la raíz del proyecto (copia cookidoo-credentials.example.json y rellénalo). Ruta alternativa: variable COOKIDOO_CREDENTIALS_PATH. Opcional: COOKIDOO_BRIDGE_URL si prefieres un servicio intermedio.`,
				);
				return;
			}

			if (!userText) {
				await whatsapp.sendText(
					from,
					"Cuéntame qué quieres cocinar y lo iteramos juntas. Cuando te guste la propuesta, pulsa el botón 'Crear Receta'.",
				);
				return;
			}

			pushConversationMessage(from, "user", userText);
			const conversation = getConversation(from);
			const proposal = await recipeAi.generateThermomixProposal(
				conversation.messages,
			);
			conversation.lastAssistantProposal = proposal;
			pushConversationMessage(from, "assistant", proposal);

			await whatsapp.sendRecipeIterationButtons(
				from,
				`${proposal}\n\nSi te convence, pulsa "Crear Receta". Luego puedes pulsar "A mi Cookidoo" para subir la última receta a tu cuenta (fichero cookidoo-credentials.json o puente COOKIDOO_BRIDGE_URL). Si no, dime qué quieres cambiar.`,
			);

			console.log("Reply sent");
		} catch (error) {
			console.error("Error sending reply:", error);
			try {
				const fallbackFrom =
					req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
				if (fallbackFrom) {
					await whatsapp.sendText(
						fallbackFrom,
						"Tuve un problema generando la receta. Inténtalo de nuevo con más detalle (ingredientes, tiempo, estilo).",
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
