const express = require("express");
const { getConfig } = require("./config/env");
const { createWebhookRouter } = require("./routes/webhook");
const { createRecipeRouter } = require("./routes/recipes");
const { createApiRouter } = require("./routes/api");
const { createWhatsAppService } = require("./services/whatsapp");
const {
	createRecipeGenerationService,
} = require("./services/recipeGeneration");

function createApp() {
	const config = getConfig();
	const whatsapp = createWhatsAppService({
		whatsappToken: config.whatsappToken,
		phoneNumberId: config.phoneNumberId,
	});
	const recipeAi = createRecipeGenerationService({
		openAiApiKey: config.openAiApiKey,
		openAiModel: config.openAiModel,
	});

	const app = express();
	app.use(express.json());

	// Mobile app web preview (Expo) runs on another origin/port in dev.
	app.use("/api", (req, res, next) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		if (req.method === "OPTIONS") {
			return res.sendStatus(204);
		}
		next();
	});

	app.use("/", createWebhookRouter({ config, whatsapp, recipeAi }));
	app.use("/r", createRecipeRouter({ config }));
	app.use("/api", createApiRouter({ config, recipeAi }));

	return app;
}

module.exports = { createApp, getConfig };
