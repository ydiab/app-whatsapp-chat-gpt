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

function deltaFromStreamEvent(evt) {
	if (!evt || typeof evt !== "object") {
		return "";
	}
	if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
		return evt.delta;
	}
	if (typeof evt.delta === "string" && String(evt.type || "").includes("output_text")) {
		return evt.delta;
	}
	return "";
}

/**
 * Same as callOpenAI but streams tokens. `onText(fullSoFar)` fires as text grows.
 * Falls back to a non-streaming request if the body isn't readable.
 */
async function callOpenAIStream({ openAiApiKey, openAiModel, input, onText }) {
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
			stream: true,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI error ${response.status}: ${errorText}`);
	}

	if (!response.body || typeof response.body.getReader !== "function") {
		const data = await response.json();
		const text = extractTextFromOpenAIResponse(data);
		if (text) {
			onText?.(text);
		}
		return text;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let fullText = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) {
				continue;
			}
			const payload = trimmed.slice("data:".length).trim();
			if (!payload || payload === "[DONE]") {
				continue;
			}
			let evt;
			try {
				evt = JSON.parse(payload);
			} catch {
				continue;
			}
			const delta = deltaFromStreamEvent(evt);
			if (delta) {
				fullText += delta;
				onText?.(fullText);
			}
			if (evt.type === "response.completed" && !fullText.trim()) {
				const completed = extractTextFromOpenAIResponse(evt.response);
				if (completed) {
					fullText = completed;
					onText?.(fullText);
				}
			}
		}
	}

	const text = fullText.trim();
	if (!text) {
		throw new Error("OpenAI no devolvió texto en el stream");
	}
	return text;
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
	callOpenAIStream,
	extractTextFromOpenAIResponse,
	extractJsonText,
};
