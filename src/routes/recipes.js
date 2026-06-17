const express = require("express");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { recipeStore } = require("../store/recipeStore");
const { escapeHtml } = require("../utils/htmlEscape");
const { parseCookidooJson } = require("../services/cookidooParse");
const { uploadRecipeToCookidooAccount } = require("../services/cookidooUpload");

function createRecipeRouter({ config } = {}) {
	const router = express.Router();

	/**
	 * POST /r/import/cookidoo
	 * Body: JSON Cookidoo (objeto completo o recipeContent) o { "cookidoo": {...} }
	 * Query: ?upload=1 para subir también a la cuenta Cookidoo
	 */
	router.post("/import/cookidoo", async (req, res) => {
		try {
			const raw = req.body?.cookidoo ?? req.body;
			const recipe = parseCookidooJson(raw);
			const id = randomUUID();
			recipeStore.set(id, {
				id,
				createdAt: new Date().toISOString(),
				...recipe,
			});

			const wantUpload =
				req.query.upload === "1" ||
				req.query.upload === "true" ||
				req.body?.upload === true;

			if (!wantUpload) {
				return res.json({ ok: true, id, recipe });
			}

			try {
				await fs.access(config.cookidooCredentialsPath);
			} catch {
				return res.status(400).json({
					error:
						"Falta cookidoo-credentials.json para subir (o usa POST sin ?upload=1)",
					id,
					recipe,
				});
			}

			const { cookidooRecipeId, recipeUrl } =
				await uploadRecipeToCookidooAccount(
					recipe,
					config.cookidooCredentialsPath,
					config.cookidooCookiesPath,
				);

			return res.json({
				ok: true,
				id,
				recipe,
				cookidooRecipeId,
				recipeUrl,
			});
		} catch (error) {
			console.error("import/cookidoo:", error);
			return res.status(400).json({
				error: error.message || "No se pudo importar el JSON de Cookidoo",
			});
		}
	});

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
