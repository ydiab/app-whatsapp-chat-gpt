/**
 * Obtiene una receta de Cookidoo usando la misma API móvil no oficial que usamos
 * para subir recetas (*.tmmobile.vorwerk-digital.com).
 *
 * Endpoint GET /recipes/v2/{recipeId}?locale={language}
 */

const {
	loadCookidooCredentials,
	cookidooRequestToken,
} = require("./cookidooUpload");
const { parseCookidooApiContent } = require("./cookidooParse");

/**
 * Descarga y parsea al formato interno la receta indicada.
 * @param {string} recipeId  p. ej. "r000011988"
 * @param {string} credentialsPath
 * @returns {Promise<object>}  receta en formato interno Mimi
 */
async function fetchCookidooRecipe(recipeId, credentialsPath) {
	const creds = await loadCookidooCredentials(credentialsPath);
	const accessToken = await cookidooRequestToken(creds);

	const apiBase = `https://${creds.countryCode}.tmmobile.vorwerk-digital.com`;
	const url = `${apiBase}/recipes/v2/${encodeURIComponent(recipeId)}?locale=${encodeURIComponent(creds.language)}`;

	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});

	const text = await res.text();

	if (res.status === 404) {
		throw new Error(
			`Receta ${recipeId} no encontrada en Cookidoo. Asegúrate de que el enlace sea correcto.`,
		);
	}
	if (!res.ok) {
		throw new Error(
			`Cookidoo fetch receta HTTP ${res.status}: ${text.slice(0, 400)}`,
		);
	}

	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("Cookidoo devolvió una respuesta no JSON al obtener la receta.");
	}

	// La API puede devolver el objeto directamente o envuelto en recipeContent
	const content = raw?.recipeContent ?? raw;

	const recipe = parseCookidooApiContent(raw, content);
	// Guardamos el JSON nativo por si el usuario quiere subirla sin modificar
	recipe._cookidooNative = { meta: raw, content };
	recipe._cookidooRecipeId = recipeId;

	return recipe;
}

module.exports = { fetchCookidooRecipe };
