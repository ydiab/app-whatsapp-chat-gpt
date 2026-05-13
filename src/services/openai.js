async function callOpenAI({ openAiApiKey, openAiModel, input }) {
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

module.exports = {
	callOpenAI,
	extractTextFromOpenAIResponse,
	extractJsonText,
};
