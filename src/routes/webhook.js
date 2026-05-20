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
const {
	uploadRecipeToCookidooAccount,
	uploadCookidooNativeToAccount,
} = require("../services/cookidooUpload");
const {
	parseCookidooJson,
	looksLikeRecipeJson,
	looksLikeCookidooUrl,
	extractRecipeIdFromUrl,
	unwrapCookidooPayload,
	isCookidooApiContent,
} = require("../services/cookidooParse");
const { fetchCookidooRecipe } = require("../services/cookidooFetch");
const {
	validateRecipeForUpload,
	isStoredRecipeUsable,
	recipeToUploadPayload,
} = require("../utils/validateRecipe");

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

				let credentialsOk = false;
				try {
					await fs.access(config.cookidooCredentialsPath);
					credentialsOk = true;
				} catch {
					credentialsOk = false;
				}

				if (!credentialsOk) {
					await whatsapp.sendText(
						from,
						"Para subir a Cookidoo necesitas cookidoo-credentials.json en el proyecto (copia cookidoo-credentials.example.json) o configurar COOKIDOO_BRIDGE_URL.",
					);
					return;
				}

				try {
					let recipeUrl;
					let title;

					if (stored?.cookidooNative?.content) {
						const result = await uploadCookidooNativeToAccount(
							stored.cookidooNative,
							config.cookidooCredentialsPath,
						);
						recipeUrl = result.recipeUrl;
						title =
							stored.cookidooNative.content.name ||
							stored.title ||
							"Receta";
					} else {
						let recipe;
						if (isStoredRecipeUsable(stored)) {
							recipe = recipeToUploadPayload(stored);
						} else if (conversation.messages.length > 0) {
							recipe = await recipeAi.generateRecipeForCookidoo(
								conversation.messages,
							);
							const recipeId = randomUUID();
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
						validateRecipeForUpload(recipe);
						const result = await uploadRecipeToCookidooAccount(
							recipe,
							config.cookidooCredentialsPath,
						);
						recipeUrl = result.recipeUrl;
						title = recipe.title;
					}

					await whatsapp.sendText(
						from,
						`¡Listo! Tu receta ya está en Cookidoo ✅\n${title}\n\n${recipeUrl}`,
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

			if (!userText) {
				await whatsapp.sendText(
					from,
					"Cuéntame qué quieres cocinar y lo vamos afinando juntas. Cuando te enseñe la receta completa, podrás subirla a Cookidoo.",
				);
				return;
			}

			if (looksLikeCookidooUrl(userText)) {
				const recipeId = extractRecipeIdFromUrl(userText);
				await whatsapp.sendText(
					from,
					`Buscando la receta en Cookidoo… ⏳`,
				);

				let credentialsOk = false;
				try {
					await fs.access(config.cookidooCredentialsPath);
					credentialsOk = true;
				} catch {
					credentialsOk = false;
				}

				if (!credentialsOk) {
					await whatsapp.sendText(
						from,
						"Necesito las credenciales de Cookidoo para obtener la receta. Añade cookidoo-credentials.json al proyecto.",
					);
					return;
				}

				let recipe;
				try {
					recipe = await fetchCookidooRecipe(recipeId, config.cookidooCredentialsPath);
				} catch (fetchError) {
					console.error("Cookidoo fetch error:", fetchError);
					await whatsapp.sendText(
						from,
						`No pude obtener la receta de Cookidoo: ${fetchError.message}`,
					);
					return;
				}

				const isPartial = recipe._partial === true;
				// Limpiamos campos internos antes de guardar/usar
				const nativeContent = recipe._cookidooNative || null;
				delete recipe._cookidooNative;
				delete recipe._cookidooRecipeId;
				delete recipe._partial;

				if (isPartial) {
					// Cookidoo no expone los pasos en su página pública.
					// Inyectamos los ingredientes y el título en la conversación
					// para que Mimi genere los pasos adaptados a Thermomix.
					const ingLines = (recipe.ingredients || [])
						.map((i) =>
							[i.quantity, i.name].filter(Boolean).join(" de ").trim(),
						)
						.join("\n");
					const contextMsg =
						`He encontrado esta receta en Cookidoo: *${recipe.title}*\n` +
						`(${recipe.servings} raciones, ~${recipe.total_time_min} min)\n\n` +
						`Ingredientes originales:\n${ingLines}\n\n` +
						`Adáptala para Thermomix generando los pasos optimizados.`;

					pushConversationMessage(from, "user", contextMsg);
					const proposalResult =
						await recipeAi.generateThermomixProposal(
							getConversation(from).messages,
						);
					const proposal =
						typeof proposalResult === "string"
							? proposalResult
							: String(proposalResult?.content ?? "").trim();
					const isComplete = Boolean(
						typeof proposalResult === "object" && proposalResult?.isComplete,
					);

					pushConversationMessage(from, "assistant", proposal);

					if (isComplete) {
						await whatsapp.sendText(
							from,
							"Un momento, preparo la receta para Cookidoo… ⏳",
						);
						try {
							const generatedRecipe =
								await recipeAi.generateRecipeForCookidoo(
									getConversation(from).messages,
								);
							validateRecipeForUpload(generatedRecipe);
							const newId = randomUUID();
							recipeStore.set(newId, {
								id: newId,
								createdAt: new Date().toISOString(),
								...generatedRecipe,
							});
							setLastCreatedRecipeId(from, newId);
							setRecipeReady(from, true);
							await whatsapp.sendUploadToCookidooButton(from, proposal);
						} catch (prepError) {
							console.error("Preparar receta Cookidoo (URL parcial):", prepError);
							setRecipeReady(from, false);
							await whatsapp.sendText(from, proposal);
						}
					} else {
						setRecipeReady(from, false);
						await whatsapp.sendText(from, proposal);
					}
					return;
				}

				// Receta completa (con pasos, p. ej. de la API móvil)
				try {
					validateRecipeForUpload(recipe);
				} catch (validationError) {
					await whatsapp.sendText(
						from,
						`La receta de Cookidoo no tiene suficiente contenido: ${validationError.message}`,
					);
					return;
				}

				const recipeId2 = randomUUID();
				const entry = {
					id: recipeId2,
					createdAt: new Date().toISOString(),
					...recipe,
					importSource: "cookidoo-url",
				};
				if (nativeContent) {
					entry.cookidooNative = nativeContent;
				}

				recipeStore.set(recipeId2, entry);
				setLastCreatedRecipeId(from, recipeId2);
				setRecipeReady(from, true);

				const summary = formatRecipeForWhatsApp(recipe);
				const intro = `Aquí tienes la receta de Cookidoo *${recipe.title}*.\n\nSi quieres cambiar algo (ingredientes, porciones, sin gluten…) dímelo y la adapto. Si te gusta tal cual, pulsa *Subir a Cookidoo*.\n\n${summary}`;

				pushConversationMessage(from, "user", `[URL Cookidoo: ${recipeId}]`);
				pushConversationMessage(from, "assistant", summary);

				await whatsapp.sendUploadToCookidooButton(from, intro);
				return;
			}

			if (looksLikeRecipeJson(userText)) {
				let recipe;
				let nativeContent = null;
				let importSource = "parser";

				try {
					const unwrapped = unwrapCookidooPayload(userText);
					recipe = parseCookidooJson(userText);
					if (isCookidooApiContent(unwrapped.content)) {
						nativeContent = unwrapped;
					}
				} catch (parserError) {
					console.warn(
						"Parser determinista no reconoció el JSON, probando con OpenAI:",
						parserError.message,
					);
					await whatsapp.sendText(
						from,
						"Ese formato no lo reconozco directamente, dame un momento que lo analice… ⏳",
					);
					try {
						recipe = await recipeAi.normalizeRecipeFromRawText(userText);
						validateRecipeForUpload(recipe);
						importSource = "openai-fallback";
					} catch (aiError) {
						console.error("Fallback OpenAI también falló:", aiError);
						await whatsapp.sendText(
							from,
							`No pude importar esa receta: ${aiError.message}`,
						);
						return;
					}
				}

				try {
					validateRecipeForUpload(recipe);
				} catch (validationError) {
					console.error("Validación tras parseo:", validationError);
					await whatsapp.sendText(
						from,
						`No pude usar esa receta: ${validationError.message}`,
					);
					return;
				}

				const recipeId = randomUUID();
				const entry = {
					id: recipeId,
					createdAt: new Date().toISOString(),
					...recipe,
					importSource,
				};
				if (nativeContent) {
					entry.cookidooNative = nativeContent;
				}
				recipeStore.set(recipeId, entry);
				setLastCreatedRecipeId(from, recipeId);
				setRecipeReady(from, true);

				const summary = formatRecipeForWhatsApp(recipe);
				pushConversationMessage(
					from,
					"user",
					`[Receta importada: ${recipe.title}]`,
				);
				pushConversationMessage(from, "assistant", summary);
				await whatsapp.sendUploadToCookidooButton(from, summary);
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

			pushConversationMessage(from, "assistant", proposal);

			if (isComplete) {
				await whatsapp.sendText(
					from,
					"Un momento, preparo la receta para Cookidoo… ⏳",
				);
				try {
					const recipe = await recipeAi.generateRecipeForCookidoo(
						conversation.messages,
					);
					validateRecipeForUpload(recipe);
					const recipeId = randomUUID();
					recipeStore.set(recipeId, {
						id: recipeId,
						createdAt: new Date().toISOString(),
						...recipe,
					});
					setLastCreatedRecipeId(from, recipeId);
					setRecipeReady(from, true);
					await whatsapp.sendUploadToCookidooButton(from, proposal);
				} catch (prepError) {
					console.error("Preparar receta Cookidoo:", prepError);
					setRecipeReady(from, false);
					await whatsapp.sendText(
						from,
						`No pude preparar la receta para subir: ${prepError.message}\n\nSi quieres, ajusta algo y te la vuelvo a mostrar.`,
					);
				}
			} else {
				setRecipeReady(from, false);
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
