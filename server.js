const express = require("express");
require("dotenv").config();
const { randomUUID } = require("node:crypto");

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.PHONE_NUMBER_ID;
const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

const recipeStore = new Map();
const conversationStore = new Map();
const CREATE_RECIPE_BUTTON_ID = "create_recipe";

function buildPublicUrl(req, recipeId) {
	const baseUrl = publicBaseUrl || `${req.protocol}://${req.get("host")}`;
	return `${baseUrl}/r/${recipeId}/invisible`;
}

function buildMetadataUrl(req, recipeId) {
	const baseUrl = publicBaseUrl || `${req.protocol}://${req.get("host")}`;
	return `${baseUrl}/r/${recipeId}`;
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function sendWhatsAppText(to, body) {
	await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${whatsappToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to,
			type: "text",
			text: { body },
		}),
	});
}

async function sendWhatsAppTypingIndicator(messageId) {
	if (!messageId) return;

	await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${whatsappToken}`,
			"Content-Type": "application/json",
		},
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

async function sendWhatsAppCreateRecipeButton(to, bodyText) {
	await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${whatsappToken}`,
			"Content-Type": "application/json",
		},
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

async function callOpenAI(input) {
	if (!openAiApiKey) {
		throw new Error("OPENAI_API_KEY no está definido en .env");
	}

	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${openAiApiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: openAiModel,
			input,
			temperature: 0.7,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI error ${response.status}: ${errorText}`);
	}

	return response.json();
}

function extractTextFromOpenAIResponse(data) {
	if (typeof data?.output_text === "string" && data.output_text.trim()) {
		return data.output_text.trim();
	}

	const output = Array.isArray(data?.output) ? data.output : [];
	const chunks = [];

	for (const item of output) {
		const content = Array.isArray(item?.content) ? item.content : [];
		for (const block of content) {
			if (typeof block?.text === "string" && block.text.trim()) {
				chunks.push(block.text.trim());
			}
		}
	}

	return chunks.join("\n").trim();
}

function extractJsonText(rawText) {
	if (!rawText) return "";
	const trimmed = rawText.trim();

	// Soporta respuestas envueltas en markdown ```json ... ```
	const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}

	return trimmed;
}

async function generateThermomixRecipe(userPrompt) {
	const prompt = `
Eres un chef experto en Thermomix.
Genera UNA receta original en español para Thermomix.
Devuelve EXCLUSIVAMENTE JSON válido (sin markdown) con este esquema:
{
  "title": "string",
  "description": "string",
  "difficulty": "facil|media|avanzada",
  "total_time_min": number,
  "servings": number,
  "ingredients": [
    { "name": "string", "quantity": "string" }
  ],
  "steps": [
    { "order": number, "text": "string", "tm_mode": "string" }
  ],
  "tags": ["string"],
  "nutrition_notes": "string"
}
La receta debe incluir velocidad, temperatura y tiempo cuando aplique.
Petición del usuario: ${userPrompt}
`.trim();

	const data = await callOpenAI(prompt);
	const text = extractTextFromOpenAIResponse(data);

	if (!text) {
		throw new Error(
			`OpenAI no devolvió contenido de receta. Respuesta parcial: ${JSON.stringify(data).slice(0, 400)}`,
		);
	}

	try {
		const jsonText = extractJsonText(text);
		return JSON.parse(jsonText);
	} catch (error) {
		throw new Error(
			`No se pudo parsear JSON de receta: ${error.message}. Texto recibido: ${text.slice(0, 500)}`,
		);
	}
}

async function generateThermomixProposal(conversationMessages) {
	const history = conversationMessages
		.map(
			(item) =>
				`${item.role === "assistant" ? "Asistente" : "Usuario"}: ${item.content}`,
		)
		.join("\n");

	const prompt = `
Eres Mimi, asistente de Thermomix por WhatsApp.
Objetivo: iterar una receta con la usuaria en lenguaje natural.
Reglas:
- Responde SIEMPRE en español.
- No uses JSON.
- Da una propuesta concreta: nombre de receta. Si le gusta la propuesta pon la receta completa con ingredientes, pasos, tiempo, porciones y calorías por porción, que sea fácil de visualizar en WhatsApp en modo lista.
- Importante que siempre debes explicar que una vez consensuada la receta, el usuario solo tiene que pulsar el botón 'Crear Receta', que la crearás para Thermomix, y que le saldrá un link para importarla a Cookidoo.
- Termina con una pregunta breve para seguir iterando (ej: si quiere cambios de ingredientes, tiempo, picante, calorías máximas etc.).
- La receta debe ser para Thermomix TM7, a no ser que el usuario especifique que usa otro modelo, con las siguientes características: 
	-- Con el menor número de pasos posibles para no esclavizar al usuario a estar continuamente echando ingredientes en el vaso cada poco tiempo.
	-- Que el usuario no tenga que andar metiendo y sacando cosas del vaso. Que vaya todo en orden metiendo ingredientes con ya ingredientes metidos.
	-- Que las recetas saladas no queden dulces (como cuando cortamos el pimiento demasiado fino y lo cocinamos demasiado tiempo con el cubretapa). Quizás hay que quitar el cubretapa para ciertas recetas y no picar demasiado las verduras.
	-- Que las recetas no salgan caldosas si no es una receta de cuchara o un risoto. Por ejemplo, unas fajitas no deben salir caldosas.
	-- Optimizar los tiempos para que las proteínas (pollo, carne...) queden jugosas sin que estén crudas en absoluto.
	-- Que las verduras queden bien hechas pero sin pasarnos.
- No incluyas el botón 'Crear Receta' en la propuesta. Solo inclúyelo al final de la propuesta, cuando ya hayas enseñado la receta completa.
- Siempre intenta que las verduras se corten en la Thermomix, no que tenga que cortarlas antes de echarlas. El mínimo esfuerzo queremos.
- Solo contesta a temas que tengan que ver con la Thermomix y cocinar. Di que no estás entrenada para responder a esas preguntas.
- Máximo 300 caracteres.

Historial:
${history}
`.trim();

	const data = await callOpenAI(prompt);
	const text = extractTextFromOpenAIResponse(data);
	if (!text) {
		throw new Error("OpenAI no devolvió propuesta de receta");
	}
	return text;
}

async function generateFinalThermomixRecipe(conversationMessages) {
	const history = conversationMessages
		.map(
			(item) =>
				`${item.role === "assistant" ? "Asistente" : "Usuario"}: ${item.content}`,
		)
		.join("\n");

	return generateThermomixRecipe(
		`Usa este historial para crear la receta final consensuada con la usuaria:\n${history}`,
	);
}

app.get("/", (req, res) => {
	const {
		"hub.mode": mode,
		"hub.challenge": challenge,
		"hub.verify_token": token,
	} = req.query;

	if (mode === "subscribe" && token === verifyToken) {
		console.log("WEBHOOK VERIFIED");
		return res.status(200).send(challenge);
	}

	return res.status(403).end();
});

app.post("/", async (req, res) => {
	console.log("Webhook received");
	console.log(JSON.stringify(req.body, null, 2));

	// Responder rápido a Meta
	res.status(200).end();

	try {
		const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

		if (!message) return;

		const from = message.from; // número del usuario que te escribió
		const incomingMessageId = message.id;
		const userText = message.text?.body?.trim();
		const buttonId = message.interactive?.button_reply?.id;

		// Feedback visual en WhatsApp mientras procesamos con OpenAI.
		await sendWhatsAppTypingIndicator(incomingMessageId);

		if (buttonId === CREATE_RECIPE_BUTTON_ID) {
			const conversation = getConversation(from);
			if (conversation.messages.length === 0) {
				await sendWhatsAppText(
					from,
					"No tengo contexto todavía. Escríbeme primero qué receta quieres (ej: arroz con pollo saludable).",
				);
				return;
			}

			const recipe = await generateFinalThermomixRecipe(conversation.messages);
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

			const recipeUrl = buildPublicUrl(req, recipeId);
			const metadataUrl = buildMetadataUrl(req, recipeId);
			await sendWhatsAppText(
				from,
				`Receta creada ✅\n${recipe.title} (${recipe.total_time_min} min, ${recipe.servings} porciones)\n\nURL Cookidoo-ready (HTML invisible): ${recipeUrl}\nMetadata JSON: ${metadataUrl}`,
			);
			return;
		}

		if (!userText) {
			await sendWhatsAppText(
				from,
				"Cuéntame qué quieres cocinar y lo iteramos juntas. Cuando te guste la propuesta, pulsa el botón 'Crear Receta'.",
			);
			return;
		}

		pushConversationMessage(from, "user", userText);
		const conversation = getConversation(from);
		const proposal = await generateThermomixProposal(conversation.messages);
		conversation.lastAssistantProposal = proposal;
		pushConversationMessage(from, "assistant", proposal);

		await sendWhatsAppCreateRecipeButton(
			from,
			`${proposal}\n\nSi te convence, pulsa "Crear Receta". Si no, dime qué quieres cambiar.`,
		);

		console.log("Reply sent");
	} catch (error) {
		console.error("Error sending reply:", error);
		try {
			const fallbackFrom =
				req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
			if (fallbackFrom) {
				await sendWhatsAppText(
					fallbackFrom,
					"Tuve un problema generando la receta. Inténtalo de nuevo con más detalle (ingredientes, tiempo, estilo).",
				);
			}
		} catch (sendError) {
			console.error("Error sending fallback message:", sendError);
		}
	}
});

app.get("/r/:id", (req, res) => {
	const recipe = recipeStore.get(req.params.id);
	if (!recipe) {
		return res.status(404).json({ error: "Recipe not found" });
	}

	const metadata = {
		provider: "mimi-thermomix-assistant",
		version: "1.0",
		cookidoo_import_ready: true,
		recipe,
	};

	res.setHeader("Cache-Control", "public, max-age=300");
	return res.json(metadata);
});

app.get("/r/:id/invisible", (req, res) => {
	const recipe = recipeStore.get(req.params.id);
	if (!recipe) {
		return res.status(404).send("Recipe not found");
	}

	const jsonLd = {
		"@context": "https://schema.org",
		"@type": "Recipe",
		name: recipe.title,
		description: recipe.description,
		recipeYield: `${recipe.servings} porciones`,
		recipeIngredient: recipe.ingredients.map(
			(item) => `${item.quantity} ${item.name}`,
		),
		recipeInstructions: recipe.steps.map((step) => ({
			"@type": "HowToStep",
			position: step.order,
			text: step.text,
		})),
		totalTime: `PT${recipe.total_time_min}M`,
		keywords: recipe.tags?.join(", "),
	};

	const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(recipe.title)}</title>
  <meta name="description" content="${escapeHtml(recipe.description)}" />
  <meta property="og:title" content="${escapeHtml(recipe.title)}" />
  <meta property="og:description" content="${escapeHtml(recipe.description)}" />
  <meta property="og:type" content="article" />
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <noscript>Recipe metadata endpoint</noscript>
</body>
</html>`;

	res.setHeader("Content-Type", "text/html; charset=utf-8");
	return res.send(html);
});

app.listen(port, () => {
	console.log(`Listening on port ${port}`);
});
