const {
	RECETA_LISTA_MARKER,
	MENSAJE_MARKER,
	RECETA_MARKER,
} = require("../constants");
const {
	callOpenAI,
	callOpenAIVision,
	callOpenAIStream,
	extractTextFromOpenAIResponse,
	extractJsonText,
} = require("./openai");
const { formatMessagesForPrompt } = require("./conversationContext");
const { assignIngredientIndicesToRecipe } = require("./cookidooParse");
const { normalizeTmModeChip } = require("../utils/thermomixCookidoo");
const {
	TASK_MODES,
	detectTaskMode,
	buildProposalPrompt,
	buildJsonConversionPrompt,
	buildImageExtractPrompt,
	buildSummarizePrompt,
	buildNormalizeRawTextPrompt,
} = require("../prompts/mimi");

function createRecipeGenerationService({ openAiApiKey, openAiModel }) {
	const ai = { openAiApiKey, openAiModel };

	function looksLikeCompleteRecipe(text) {
		const body = String(text || "").trim();
		if (!body) {
			return false;
		}
		const lower = body.toLowerCase();
		const hasIngredients = /\bingredientes\b/.test(lower);
		const hasSteps =
			/\bpasos\b/.test(lower) ||
			/\bpara thermomix\b/.test(lower) ||
			/\n\s*\d+\.\s/.test(body);
		return hasIngredients && hasSteps;
	}

	function stripMarkers(text) {
		return String(text || "")
			.split(RECETA_LISTA_MARKER)
			.join("")
			.split(MENSAJE_MARKER)
			.join("")
			.split(RECETA_MARKER)
			.join("")
			.replace(/\s*\|\s*ingredient_indices\s*:\s*\[[^\]]*\]/gi, "")
			.replace(/\bingredient_indices\s*:\s*\[[^\]]*\]/gi, "")
			.trim();
	}

	function splitUnmarkedContent(content) {
		const parts = content
			.split(/\n\s*\n/)
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length < 2) {
			return { intro: content, recipeText: "" };
		}
		const intro = parts[0];
		const rest = parts.slice(1).join("\n\n");
		if (intro.length < 280 && looksLikeCompleteRecipe(rest)) {
			return { intro, recipeText: rest };
		}
		return { intro: content, recipeText: "" };
	}

	function parseProposalResponse(text) {
		const raw = String(text || "").trim();
		const withoutLista = raw.split(RECETA_LISTA_MARKER).join("");
		const recipeAt = withoutLista.indexOf(RECETA_MARKER);

		let intro = "";
		let recipeText = "";
		if (recipeAt !== -1) {
			intro = stripMarkers(withoutLista.slice(0, recipeAt));
			recipeText = stripMarkers(
				withoutLista.slice(recipeAt + RECETA_MARKER.length),
			);
		} else {
			const unmarked = stripMarkers(withoutLista);
			if (looksLikeCompleteRecipe(unmarked)) {
				({ intro, recipeText } = splitUnmarkedContent(unmarked));
			} else {
				intro = unmarked;
			}
		}

		const content = [intro, recipeText].filter(Boolean).join("\n\n");
		const isComplete =
			raw.includes(RECETA_LISTA_MARKER) ||
			looksLikeCompleteRecipe(recipeText || content);
		return { content, intro, recipeText, isComplete };
	}

	function buildContextBlocks({ summary, currentRecipeText }) {
		const blocks = [];
		if (summary?.trim()) {
			blocks.push(`Resumen de la conversación anterior:\n${summary.trim()}`);
		}
		if (currentRecipeText?.trim()) {
			blocks.push(
				`Receta acordada actualmente (referencia; aplícale solo lo que pida la usuaria, sin reinventarla):\n${currentRecipeText.trim()}`,
			);
		}
		return blocks.join("\n\n");
	}

	async function summarizeConversation({
		priorSummary,
		messages,
		currentRecipeText,
	}) {
		const transcript = formatMessagesForPrompt(messages);
		const prompt = buildSummarizePrompt({
			priorSummary,
			transcript,
			currentRecipeText,
		});

		const data = await callOpenAI({ ...ai, input: prompt, temperature: 0.3 });
		const text = extractTextFromOpenAIResponse(data);
		if (!text) {
			throw new Error("OpenAI no devolvió resumen de conversación");
		}
		return text.trim();
	}

	async function generateThermomixRecipe(userPrompt) {
		const prompt = buildJsonConversionPrompt(userPrompt);

		const data = await callOpenAI({ ...ai, input: prompt, temperature: 0.2 });
		const text = extractTextFromOpenAIResponse(data);

		if (!text) {
			throw new Error(
				`OpenAI no devolvió contenido de receta. Respuesta parcial: ${JSON.stringify(data).slice(0, 400)}`,
			);
		}

		try {
			const jsonText = extractJsonText(text);
			const parsed = JSON.parse(jsonText);
			if (Array.isArray(parsed?.steps)) {
				parsed.steps = parsed.steps.map((step) => ({
					...step,
					text: String(step.text || "")
						.replace(/\s*\|\s*ingredient_indices\s*:\s*\[[^\]]*\]/gi, "")
						.replace(/\bingredient_indices\s*:\s*\[[^\]]*\]/gi, "")
						.replace(/\s*\/?vel(?:ocidad)?\s*\.{2,}/gi, "")
						.trim(),
					tm_mode: normalizeTmModeChip(step.tm_mode) || step.tm_mode,
				}));
			}
			return assignIngredientIndicesToRecipe(parsed);
		} catch (error) {
			throw new Error(
				`No se pudo parsear JSON de receta: ${error.message}. Texto recibido: ${text.slice(0, 500)}`,
			);
		}
	}

	async function generateThermomixProposal(
		conversation,
		{ channel = "whatsapp", onPartial } = {},
	) {
		const { messages, summary, currentRecipeText } = conversation;
		const history = formatMessagesForPrompt(messages);
		const contextBlocks = buildContextBlocks({ summary, currentRecipeText });

		const isApp = channel === "app";
		const channelName = isApp
			? "en una app de chat para iPhone"
			: "por WhatsApp";
		const formatRule = isApp
			? "Formato app de chat: texto plano, sin markdown ni asteriscos de negrita; mensajes claros y fáciles de leer en el móvil."
			: "Formato WhatsApp: mensajes claros y fáciles de leer en el móvil.";

		const prompt = buildProposalPrompt({
			channelName,
			formatRule,
			isApp,
			contextBlocks,
			history,
		});
		const mode = detectTaskMode(conversation);
		const temperature = mode === TASK_MODES.crear ? 0.7 : 0.35;

		let introEmitted = false;
		const text = await callOpenAIStream({
			...ai,
			input: prompt,
			temperature,
			onText: (fullSoFar) => {
				if (introEmitted || !onPartial) {
					return;
				}
				const recipeAt = fullSoFar.indexOf(RECETA_MARKER);
				if (recipeAt === -1) {
					return;
				}
				const intro = parseProposalResponse(fullSoFar.slice(0, recipeAt)).intro;
				if (!intro) {
					return;
				}
				introEmitted = true;
				onPartial({ intro });
			},
		});
		if (!text) {
			throw new Error("OpenAI no devolvió propuesta de receta");
		}
		return parseProposalResponse(text);
	}

	async function generateRecipeForCookidoo(conversation) {
		const { messages, summary, currentRecipeText } = conversation;
		const recentHistory = formatMessagesForPrompt(messages.slice(-6));
		const contextBlocks = buildContextBlocks({ summary, currentRecipeText });

		let userPrompt;
		if (currentRecipeText?.trim()) {
			userPrompt = `Convierte FIELMENTE a JSON la receta acordada. No la mejores ni cambies cantidades, pasos, tiempos, velocidades ni temperaturas:\n${currentRecipeText.trim()}`;
			if (contextBlocks) {
				userPrompt += `\n\n${contextBlocks}`;
			}
			if (recentHistory) {
				userPrompt += `\n\nÚltimos mensajes (por si hubo un cambio muy reciente):\n${recentHistory}`;
			}
		} else {
			const history = formatMessagesForPrompt(messages);
			userPrompt = `Convierte FIELMENTE a JSON la receta acordada en este historial. No la mejores:\n${contextBlocks ? `${contextBlocks}\n\n` : ""}${history}`;
		}

		return generateThermomixRecipe(userPrompt);
	}

	/**
	 * Fallback: pide a OpenAI que normalice texto/JSON arbitrario al formato interno.
	 * @param {string} rawText texto pegado por el usuario (JSON desconocido, texto libre, etc.)
	 */
	async function normalizeRecipeFromRawText(rawText) {
		return generateThermomixRecipe(buildNormalizeRawTextPrompt(rawText));
	}

	/**
	 * Extrae la receta TAL CUAL de capturas (Thermomix o convencional).
	 * Las adaptaciones se aplican después en el flujo de chat.
	 * @param {string[]} images data URLs (`data:image/png;base64,…`) o URLs http(s).
	 */
	async function extractRecipeFromImages(images) {
		const prompt = buildImageExtractPrompt();

		const data = await callOpenAIVision({ ...ai, prompt, images });
		const text = extractTextFromOpenAIResponse(data);
		if (!text) {
			throw new Error("OpenAI no devolvió la receta de las capturas");
		}

		try {
			const parsed = JSON.parse(extractJsonText(text));
			if (Array.isArray(parsed?.steps)) {
				parsed.steps = parsed.steps.map((step) => ({
					...step,
					tm_mode: normalizeTmModeChip(step.tm_mode) || step.tm_mode,
				}));
			}
			if (parsed.is_thermomix === true) {
				parsed.tags = Array.isArray(parsed.tags)
					? [...new Set([...parsed.tags, "importada-thermomix"])]
					: ["importada-thermomix"];
			} else if (parsed.is_thermomix === false) {
				parsed.tags = Array.isArray(parsed.tags)
					? [...new Set([...parsed.tags, "para-traducir"])]
					: ["para-traducir"];
			}
			return assignIngredientIndicesToRecipe(parsed);
		} catch (error) {
			throw new Error(
				`No pude leer la receta de las capturas: ${error.message}. Texto recibido: ${text.slice(0, 400)}`,
			);
		}
	}

	return {
		generateThermomixRecipe,
		generateThermomixProposal,
		generateRecipeForCookidoo,
		normalizeRecipeFromRawText,
		extractRecipeFromImages,
		parseProposalResponse,
		summarizeConversation,
	};
}

module.exports = { createRecipeGenerationService };
