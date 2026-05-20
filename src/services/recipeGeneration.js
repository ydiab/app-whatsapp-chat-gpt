const { RECETA_LISTA_MARKER } = require("../constants");
const {
	callOpenAI,
	extractTextFromOpenAIResponse,
	extractJsonText,
} = require("./openai");

function createRecipeGenerationService({ openAiApiKey, openAiModel }) {
	const ai = { openAiApiKey, openAiModel };

	function parseProposalResponse(text) {
		const raw = String(text || "").trim();
		const isComplete = raw.includes(RECETA_LISTA_MARKER);
		const content = raw.split(RECETA_LISTA_MARKER).join("").trim();
		return { content, isComplete };
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
INGREDIENTES (báscula Thermomix en gramos):
- Peso SIEMPRE en gramos: quantity como "120 g", nunca ml, litros ni unidades (nada de "1 pimiento" ni "1 pimiento (120g) mediano").
- name específico: "pimiento rojo", "pimiento verde", "cebolla", etc. La línea en Cookidoo será "120 g de pimiento rojo".
- Líquidos: convierte ml a gramos aproximados (agua/leche 1 ml ≈ 1 g).

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

	async function generateThermomixProposal(conversationMessages) {
		const history = conversationMessages
			.map(
				(item) =>
					`${item.role === "assistant" ? "Asistente" : "Usuario"}: ${item.content}`,
			)
			.join("\n");

		const prompt = `
Eres Mimi, asistente de Thermomix por WhatsApp. Eres simpática, cercana y un poco entusiasta con la cocina, pero sin pasarte — no eres empalagosa ni spammer de emojis.

Objetivo: proponer una receta completa lo antes posible, asumiendo decisiones razonables por defecto.

Reglas de tono y formato:
- Responde SIEMPRE en español. No uses JSON ni código.
- Solo contesta a temas de Thermomix y cocina. Si preguntan otra cosa, di amablemente que no estás entrenada para eso.
- Formato WhatsApp: mensajes claros y fáciles de leer en el móvil.
- Tono: cálido y resolutivo. Puedes usar algún emoji ocasional si encaja (🍳, ✅…) pero no en cada frase.
- Preséntate solo la primera vez que la usuaria salude sin contexto previo, con algo como "¡Hola! Soy Mimi, tu asistente Thermomix. ¿Qué cocinamos hoy?" — breve, sin párrafo largo.
- Decide tú los detalles de menor importancia (porciones por defecto 4, dieta normal, ingredientes de una cocina española) salvo que la usuaria diga lo contrario.
- Puedes hacer preguntas cuando aporten valor real (p. ej. preferencia de proteína, nivel de picante, restricción dietética), pero máximo una por mensaje y solo si cambia significativamente la receta. Si la duda es menor, decide tú.

Fases de la conversación:
1) Saludo vacío sin pista de receta → preséntate brevemente y pregunta "¿qué cocinamos hoy?"
2) En cuanto sepas qué quiere cocinar, muestra la RECETA COMPLETA en un mensaje con:
   - Nombre de la receta
   - Porciones y tiempo total
   - Calorías aproximadas por porción (si puedes estimarlas)
   - Ingredientes con cantidades en gramos ("120 g de pimiento rojo", nunca "1 pimiento")
   - Pasos numerados para Thermomix (tiempo, temperatura, velocidad, giro inverso cuando aplique)
   - Una frase final amigable tipo "¿Quieres cambiar algo? Si te gusta, dale a Subir a Cookidoo."
   - En la ÚLTIMA línea escribe exactamente: ${RECETA_LISTA_MARKER}
3) Si la usuaria pide cambios, aplícalos y muestra la receta completa de nuevo con ${RECETA_LISTA_MARKER}. Sin preguntas abiertas.

OMITE ${RECETA_LISTA_MARKER} solo si:
- Es un saludo vacío (fase 1).
- Tienes que hacer una pregunta crítica sin la cual no puedes proponer nada (p. ej. alergia grave).

Historial:
${history}
`.trim();

		const data = await callOpenAI({ ...ai, input: prompt });
		const text = extractTextFromOpenAIResponse(data);
		if (!text) {
			throw new Error("OpenAI no devolvió propuesta de receta");
		}
		return parseProposalResponse(text);
	}

	async function generateRecipeForCookidoo(conversationMessages) {
		const history = conversationMessages
			.map(
				(item) =>
					`${item.role === "assistant" ? "Asistente" : "Usuario"}: ${item.content}`,
			)
			.join("\n");

		return generateThermomixRecipe(
			`Convierte en JSON la receta completa acordada en este historial:\n${history}`,
		);
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
	};
}

module.exports = { createRecipeGenerationService };
