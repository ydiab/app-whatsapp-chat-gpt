function getConfig() {
	const port = Number(process.env.PORT) || 3000;

	return {
		port,
		verifyToken: process.env.VERIFY_TOKEN,
		whatsappToken: process.env.WHATSAPP_TOKEN,
		phoneNumberId: process.env.PHONE_NUMBER_ID,
		openAiApiKey: process.env.OPENAI_API_KEY,
		openAiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
		publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
	};
}

module.exports = { getConfig };
