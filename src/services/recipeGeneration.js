const {
	callOpenAI,
	extractTextFromOpenAIResponse,
	extractJsonText,
} = require("./openai");

function createRecipeGenerationService({ openAiApiKey, openAiModel }) {
	const ai = { openAiApiKey, openAiModel };

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

		const data = await callOpenAI({ ...ai, input: prompt });
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

	return {
		generateThermomixRecipe,
		generateThermomixProposal,
		generateFinalThermomixRecipe,
	};
}

module.exports = { createRecipeGenerationService };
