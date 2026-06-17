const path = require("node:path");

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
		/** Optional HTTPS URL of your own service that logs into Cookidoo and creates the recipe. */
		cookidooBridgeUrl: process.env.COOKIDOO_BRIDGE_URL || "",
		/** Optional Bearer token your bridge checks (Authorization header). */
		cookidooBridgeSecret: process.env.COOKIDOO_BRIDGE_SECRET || "",
		/** JSON file with Cookidoo config (country/language/tools). */
		cookidooCredentialsPath:
			process.env.COOKIDOO_CREDENTIALS_PATH ||
			path.join(process.cwd(), "cookidoo-credentials.json"),
		/** Local JSON file with Cookidoo session cookies (alternativa a COOKIDOO_COOKIE_HEADER / COOKIDOO_COOKIES_JSON). */
		cookidooCookiesPath:
			process.env.COOKIDOO_COOKIES_PATH ||
			path.join(process.cwd(), "cookidoo-cookies.json"),
	};
}

module.exports = { getConfig };
