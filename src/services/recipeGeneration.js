const { RECETA_LISTA_MARKER } = require("../constants");
const {
	callOpenAI,
	extractTextFromOpenAIResponse,
	extractJsonText,
} = require("./openai");
const { formatMessagesForPrompt } = require("./conversationContext");

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

	function parseProposalResponse(text) {
		const raw = String(text || "").trim();
		const content = raw.split(RECETA_LISTA_MARKER).join("").trim();
		const isComplete =
			raw.includes(RECETA_LISTA_MARKER) || looksLikeCompleteRecipe(content);
		return { content, isComplete };
	}

	function buildContextBlocks({ summary, currentRecipeText }) {
		const blocks = [];
		if (summary?.trim()) {
			blocks.push(`Resumen de la conversación anterior:\n${summary.trim()}`);
		}
		if (currentRecipeText?.trim()) {
			blocks.push(
				`Receta acordada actualmente (referencia fija; aplícale solo los cambios que pida la usuaria):\n${currentRecipeText.trim()}`,
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
		const prompt = `
Resume esta conversación entre Mimi (asistente Thermomix) y una usuaria.
Incluye: qué quiere cocinar, preferencias o restricciones, cambios pedidos y decisiones tomadas.
NO copies la receta completa (ya está guardada aparte si existe).
Sé conciso (máximo 300 palabras). Responde en español, texto plano.
${priorSummary?.trim() ? `\nResumen previo (actualízalo con lo nuevo, no repitas lo obvio):\n${priorSummary.trim()}\n` : ""}${currentRecipeText?.trim() ? "\nNota: ya hay una receta acordada en curso; el resumen debe ayudar a entender el contexto, no sustituir la receta.\n" : ""}
Mensajes a resumir:
${transcript}
`.trim();

		const data = await callOpenAI({ ...ai, input: prompt });
		const text = extractTextFromOpenAIResponse(data);
		if (!text) {
			throw new Error("OpenAI no devolvió resumen de conversación");
		}
		return text.trim();
	}

	async function generateThermomixRecipe(userPrompt) {
		const prompt = `
Eres un chef experto en Thermomix. A partir del historial de chat, genera la receta consensuada.
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
    { "order": number, "text": "string", "tm_mode": "string", "ingredient_indices": [0, 1] }
  ],
  "tags": ["string"],
  "nutrition_notes": "string"
}
INGREDIENTES (unidades estándar de cocina):
- Ingredientes que se pesan en la báscula (verduras, carnes, pescados, pasta, arroz, harina, quesos, líquidos...): quantity en gramos, como "120 g" (nada de "1 pimiento" ni "1 pimiento (120g) mediano"). Líquidos: convierte ml a gramos aproximados (agua/leche/caldo 1 ml ≈ 1 g).
- Ingredientes con unidad natural propia: usa esa unidad, NO gramos:
  - ajo → quantity "2 dientes" y name "ajo"; huevos → quantity "2" y name "huevos"; laurel → quantity "1 hoja" y name "laurel".
  - name NUNCA repite la unidad: name "ajo" (no "dientes de ajo"), name "laurel" (no "hoja de laurel").
- Sal, pimienta y especias (pimentón, comino, orégano...): SIEMPRE en cucharaditas o cucharadas, como "1 cucharadita" o "1/2 cucharadita". PROHIBIDO "al gusto", "una pizca" o dejar la cantidad vacía.
- name específico: "pimiento rojo", "pimiento verde", "cebolla", etc. La línea en Cookidoo será "quantity de name": "120 g de pimiento rojo", "2 dientes de ajo", "1 cucharadita de sal".

PASOS Y COOKIDOO:
- "ingredient_indices": SOLO índices 0-based de ingredientes que se ECHAN o AÑADEN al vaso EN ESE paso concreto.
  - Si el paso solo cocina, programa, reduce, espesa o remueve lo que ya está en el vaso → "ingredient_indices": [] (array vacío).
  - Cada ingrediente debe aparecer en exactamente UN paso (el paso donde se añade por primera vez).
  - NUNCA repitas la lista completa de ingredientes en todos los pasos.
  - Ejemplo: paso 1 [0,1,2] añadir verduras; paso 2 [] programar 7 min; paso 3 [3] añadir pollo; paso 4 [] cocinar.
- "text": redáctalo como una receta de Cookidoo oficial, en lenguaje natural y mencionando por su nombre los ingredientes que se añaden en ESE paso (sin cantidades; las cantidades van en la lista de ingredientes y Cookidoo las enlazará). Ejemplos:
   - "Añadir el aceite y la pechuga de pollo en dados y sofreír."
   - "Incorporar la cebolla, el pimiento rojo y el ajo. Trocear."
   - "Programar sin medidor."
  NO pegues la lista de ingredientes al inicio del paso. NO repitas tiempos ni temperatura en text (van en tm_mode). Si el paso solo cocina/programa/reposa, no menciones ingredientes.
- "tm_mode" OBLIGATORIO en todo paso que cocine/mezcle en el vaso. Formato EXACTO con barras:
  "7 min / 100°C / Vel 1 giro inverso"
  "7 min / 100°C / Vel soft giro inverso"
  "3 min / Varoma / Vel 2"
  "20 seg / Vel 8"
  Velocidades: número 0.5-10, o "soft" para cuchara. Giro inverso pegado a la velocidad: "Vel 1 giro inverso".

  Calidad Thermomix (TM7 salvo que diga otro modelo):
- Pocos pasos; no obligar a estar echando ingredientes cada dos minutos.
- Todo en el vaso en orden, sin sacar y volver a meter cosas innecesariamente.
- Recetas saladas sin sabor dulce: no picar verduras demasiado fino ni cocinarlas demasiado con cubretapa si no toca.
- No caldosas salvo guisos, risottos o recetas de cuchara (ej. fajitas sin caldo).
- Proteínas jugosas pero bien hechas; verduras en su punto.
- Siempre intenta que las verduras se corten en la Thermomix, no que tenga que cortarlas antes de echarlas. El mínimo esfuerzo queremos.
- Que las verduras queden bien hechas pero sin pasarnos.

RECETA IMPORTADA (respeta el original): si el historial trae una receta que la usuaria quiere subir (p. ej. de Cookidoo), respeta EXACTAMENTE sus ingredientes y cantidades. NO apliques las reglas de calidad de arriba para cambiarla ni la "mejores": solo conviértela a formato Thermomix y aplica únicamente los cambios que la usuaria haya pedido de forma explícita.

Historial / petición:
${userPrompt}
`.trim();

		const data = await callOpenAI({ ...ai, input: prompt });
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

	async function generateThermomixProposal(
		conversation,
		{ channel = "whatsapp" } = {},
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

		const prompt = `
Eres Mimi, asistente de Thermomix ${channelName}. Eres simpática, cercana y un poco entusiasta con la cocina, pero sin pasarte — no eres empalagosa ni spammer de emojis.

Objetivo: proponer una receta completa lo antes posible, asumiendo decisiones razonables por defecto.

Reglas de tono y formato:
- Responde SIEMPRE en español. No uses JSON ni código.
- Solo contesta a temas de Thermomix y cocina. Si preguntan otra cosa, di amablemente que no estás entrenada para eso.
- ${formatRule}
- Tono: cálido y resolutivo. Puedes usar algún emoji ocasional si encaja (🍳, ✅…) pero no en cada frase.
- Preséntate solo la primera vez que la usuaria salude sin contexto previo, con algo como "¡Hola! Soy Mimi, tu asistente Thermomix. ¿Qué cocinamos hoy?" — breve, sin párrafo largo.
- Decide tú los detalles de menor importancia (porciones por defecto 4, dieta normal, ingredientes de una cocina española) salvo que la usuaria diga lo contrario.
- Puedes hacer preguntas cuando aporten valor real (p. ej. preferencia de proteína, nivel de picante, restricción dietética), pero máximo una por mensaje y solo si cambia significativamente la receta. Si la duda es menor, decide tú.

RECETAS IMPORTADAS / QUE LA USUARIA QUIERE SUBIR (MUY IMPORTANTE):
- Si en el historial hay una receta que la usuaria ha traído o quiere subir (por ejemplo, importada de Cookidoo), trátala como BASE FIJA.
- NO la mejores, optimices ni cambies por iniciativa propia: respeta EXACTAMENTE sus ingredientes, cantidades y proporciones.
- Tu trabajo es solo convertirla a formato Thermomix (pasos con tiempo/temperatura/velocidad), manteniéndola idéntica.
- Aplica ÚNICAMENTE los cambios que la usuaria pida de forma explícita (p. ej. "menos calorías", "para 2 raciones", "sin gluten"). Si no pide ningún cambio, devuélvela tal cual.
- No añadas ni quites ingredientes, ni reajustes cantidades, ni "redondees" nada salvo que te lo pidan.

Fases de la conversación:
1) Saludo vacío sin pista de receta → preséntate brevemente y pregunta "¿qué cocinamos hoy?"
2) En cuanto sepas qué quiere cocinar, muestra la RECETA COMPLETA en un mensaje con:
   - Nombre de la receta
   - Porciones y tiempo total
   - Calorías aproximadas por porción (si puedes estimarlas)
   - Ingredientes con unidades estándar de cocina: en gramos lo que se pesa en la báscula ("120 g de pimiento rojo", nunca "1 pimiento"); en su unidad natural lo que la tiene ("2 dientes de ajo", "2 huevos", "1 hoja de laurel"); sal, pimienta y especias siempre en cucharaditas/cucharadas ("1 cucharadita de sal"), nunca "al gusto" ni "una pizca"
   - Pasos numerados para Thermomix (tiempo, temperatura, velocidad, giro inverso cuando aplique)
   - Una frase final amigable${isApp ? ' tipo "¿Quieres cambiar algo?" — NO menciones el botón Subir a Cookidoo; la app lo muestra sola' : ' tipo "¿Quieres cambiar algo? Si te gusta, dale a Subir a Cookidoo."'}
   - En la ÚLTIMA línea escribe exactamente: ${RECETA_LISTA_MARKER}
3) Si la usuaria pide cambios, aplícalos y muestra la receta completa de nuevo con ${RECETA_LISTA_MARKER}. Sin preguntas abiertas.

OMITE ${RECETA_LISTA_MARKER} solo si:
- Es un saludo vacío (fase 1).
- Tienes que hacer una pregunta crítica sin la cual no puedes proponer nada (p. ej. alergia grave).

${contextBlocks ? `${contextBlocks}\n\n` : ""}Historial reciente:
${history || "(sin mensajes recientes)"}
`.trim();

		const data = await callOpenAI({ ...ai, input: prompt });
		const text = extractTextFromOpenAIResponse(data);
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
			userPrompt = `Convierte en JSON la receta completa acordada:\n${currentRecipeText.trim()}`;
			if (contextBlocks) {
				userPrompt += `\n\n${contextBlocks}`;
			}
			if (recentHistory) {
				userPrompt += `\n\nÚltimos mensajes (por si hubo un cambio muy reciente):\n${recentHistory}`;
			}
		} else {
			const history = formatMessagesForPrompt(messages);
			userPrompt = `Convierte en JSON la receta completa acordada en este historial:\n${contextBlocks ? `${contextBlocks}\n\n` : ""}${history}`;
		}

		return generateThermomixRecipe(userPrompt);
	}

	/**
	 * Fallback: pide a OpenAI que normalice texto/JSON arbitrario al formato interno.
	 * @param {string} rawText texto pegado por el usuario (JSON desconocido, texto libre, etc.)
	 */
	async function normalizeRecipeFromRawText(rawText) {
		return generateThermomixRecipe(
			`Te paso una receta en un formato que no reconozco (puede ser JSON, texto plano o copia de una web).
Conviértela al esquema JSON pedido SIN inventar ingredientes ni cantidades:
- Respeta cantidades exactas (140 g sigue siendo 140 g, no redondees).
- Si la unidad es ml o l, conviértela a gramos aproximados solo para agua/leche/caldo (1:1).
- "pizca", "unidad", "cucharada" etc. → mantenlos en quantity si no hay peso (ej. "1 pizca").
- Si un paso indica tiempo/temperatura/velocidad (ej. "8 min/100°C/vel cuchara"), ponlo en "tm_mode" y deja en "text" solo la acción.
- Si un paso solo cocina (sin añadir nada al vaso) → ingredient_indices: [].

Texto recibido:
${rawText.slice(0, 6000)}`,
		);
	}

	return {
		generateThermomixRecipe,
		generateThermomixProposal,
		generateRecipeForCookidoo,
		normalizeRecipeFromRawText,
		parseProposalResponse,
		summarizeConversation,
	};
}

module.exports = { createRecipeGenerationService };
