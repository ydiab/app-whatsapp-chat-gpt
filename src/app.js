const express = require("express");
const { getConfig } = require("./config/env");
const { createWebhookRouter } = require("./routes/webhook");
const { createRecipeRouter } = require("./routes/recipes");
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

	app.use("/", createWebhookRouter({ config, whatsapp, recipeAi }));
	app.use("/r", createRecipeRouter({ config }));

	return app;
}

module.exports = { createApp, getConfig };
