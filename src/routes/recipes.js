const express = require("express");
const { recipeStore } = require("../store/recipeStore");
const { escapeHtml } = require("../utils/htmlEscape");

function createRecipeRouter() {
	const router = express.Router();

	router.get("/:id", (req, res) => {
		const recipe = recipeStore.get(req.params.id);
		if (!recipe) {
			return res.status(404).json({ error: "Recipe not found" });
		}

		const metadata = {
			provider: "mimi-thermomix-assistant",
			version: "1.0",
			cookidoo_import_ready: true,
			recipe,
		};

		res.setHeader("Cache-Control", "public, max-age=300");
		return res.json(metadata);
	});

	router.get("/:id/invisible", (req, res) => {
		const recipe = recipeStore.get(req.params.id);
		if (!recipe) {
			return res.status(404).send("Recipe not found");
		}

		const jsonLd = {
			"@context": "https://schema.org",
			"@type": "Recipe",
			name: recipe.title,
			description: recipe.description,
			recipeYield: `${recipe.servings} porciones`,
			recipeIngredient: recipe.ingredients.map(
				(item) => `${item.quantity} ${item.name}`,
			),
			recipeInstructions: recipe.steps.map((step) => ({
				"@type": "HowToStep",
				position: step.order,
				text: step.text,
			})),
			totalTime: `PT${recipe.total_time_min}M`,
			keywords: recipe.tags?.join(", "),
		};

		const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(recipe.title)}</title>
  <meta name="description" content="${escapeHtml(recipe.description)}" />
  <meta property="og:title" content="${escapeHtml(recipe.title)}" />
  <meta property="og:description" content="${escapeHtml(recipe.description)}" />
  <meta property="og:type" content="article" />
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <noscript>Recipe metadata endpoint</noscript>
</body>
</html>`;

		res.setHeader("Content-Type", "text/html; charset=utf-8");
		return res.send(html);
	});

	return router;
}

module.exports = { createRecipeRouter };
