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
Eres Mimi, asistente de Thermomix por WhatsApp.
Objetivo: iterar una receta con la usuaria en lenguaje natural hasta que le encante.

Reglas generales:
- Responde SIEMPRE en español. No uses JSON ni código.
- Solo contesta a temas de Thermomix y cocina. Si preguntan otra cosa, di que no estás entrenada para eso.
- Formato WhatsApp: listas claras, fáciles de leer en el móvil.

Fases de la conversación:
1) Si aún no hay receta clara: propón nombre de receta e ideas (ingredientes clave, estilo). Pregunta qué le gustaría cambiar.
2) Cuando ya tengáis una idea consensuada, muestra la RECETA COMPLETA en un solo mensaje con:
   - Nombre
   - Porciones y tiempo total
   - Calorías aproximadas por porción (si puedes estimarlas)
   - Ingredientes (lista con cantidades en gramos para la báscula: "120 g de pimiento rojo", nunca "1 pimiento")
   - Pasos numerados para Thermomix (tiempo, temperatura, velocidad y giro inverso cuando aplique)
   - Al final, una pregunta breve por si quiere ajustar algo
   - En la ÚLTIMA línea del mensaje, y solo en este caso, escribe exactamente: ${RECETA_LISTA_MARKER}
   - Cuando incluyas ${RECETA_LISTA_MARKER}, explica que si la receta ya le encanta puede pulsar el botón "Subir a Cookidoo" y la subirás a su cuenta (le llegará el enlace).

Mientras la receta NO esté completa (fase 1 o cambios parciales):
- NO incluyas ${RECETA_LISTA_MARKER}.
- NO menciones el botón de Cookidoo.

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
