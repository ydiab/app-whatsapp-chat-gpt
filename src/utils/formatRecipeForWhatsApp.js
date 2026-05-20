/**
 * Resumen legible de una receta para WhatsApp (máx. ~1000 caracteres).
 */
function formatRecipeForWhatsApp(recipe) {
	const lines = [];
	lines.push(`📖 ${recipe.title || "Receta"}`);
	lines.push(
		`⏱ ${recipe.total_time_min || "?"} min · 🍽 ${recipe.servings || "?"} porciones`,
	);

	if (recipe.ingredients?.length) {
		lines.push("\n*Ingredientes:*");
		for (const ing of recipe.ingredients) {
			const q = ing.quantity ? `${ing.quantity} ` : "";
			lines.push(`• ${q}${ing.name || ""}`.trim());
		}
	}

	if (recipe.steps?.length) {
		lines.push("\n*Pasos:*");
		for (const step of recipe.steps) {
			const n = step.order ?? "";
			let line = `${n}. ${step.text || ""}`.trim();
			if (step.tm_mode) {
				line += `\n   ⚙ ${step.tm_mode}`;
			}
			lines.push(line);
		}
	}

	lines.push(
		"\nSi te encaja, pulsa *Subir a Cookidoo* y la publicaré en tu cuenta.",
	);

	let text = lines.join("\n");
	if (text.length > 1020) {
		text = `${text.slice(0, 1017)}...`;
	}
	return text;
}

module.exports = { formatRecipeForWhatsApp };
