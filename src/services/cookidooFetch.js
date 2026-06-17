/**
 * Obtiene una receta de Cookidoo.
 *
 * Estrategia en cascada:
 *  1. Intenta la API móvil no oficial (v3, luego v2) con el access_token.
 *  2. Si devuelve 404 (recetas oficiales del catálogo no siempre son accesibles
 *     así), rasca la página web pública y extrae los datos del bloque
 *     __NEXT_DATA__ (Next.js SSR) o de los JSON-LD <script> de la página.
 */

const { loadCookidooCredentials } = require("./cookidooUpload");
const { buildCookidooSession } = require("./cookidooAuth");
const { parseCookidooApiContent } = require("./cookidooParse");

// ─── helpers de scraping ─────────────────────────────────────────────────────

/** Recorre el árbol de __NEXT_DATA__ buscando un objeto con `ingredients`. */
function findRecipeInNextData(node, depth = 0) {
	if (!node || typeof node !== "object" || depth > 12) return null;
	if (
		Array.isArray(node.ingredients) &&
		node.ingredients.length > 0 &&
		(node.name || node.title)
	) {
		return node;
	}
	for (const val of Object.values(node)) {
		const found = findRecipeInNextData(val, depth + 1);
		if (found) return found;
	}
	return null;
}

/**
 * Intenta extraer datos de receta del HTML de la página Cookidoo.
 * @returns {object|null}
 */
function extractFromHtml(html) {
	// 1. __NEXT_DATA__
	const nextMatch = html.match(
		/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
	);
	if (nextMatch) {
		try {
			const data = JSON.parse(nextMatch[1]);
			const recipe = findRecipeInNextData(data);
			if (recipe) return recipe;
		} catch {
			// continuar
		}
	}

	// 2. JSON-LD con @type Recipe
	for (const m of html.matchAll(
		/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		try {
			const data = JSON.parse(m[1]);
			const items = Array.isArray(data) ? data : [data];
			for (const item of items) {
				if (
					item?.["@type"] === "Recipe" ||
					(item?.name && Array.isArray(item?.recipeIngredient))
				) {
					return item;
				}
			}
		} catch {
			// continuar
		}
	}

	return null;
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function tryApiFetch(recipeId, apiBase, authHeaders, language) {
	for (const version of ["v3", "v2"]) {
		const url = `${apiBase}/recipes/${version}/${encodeURIComponent(recipeId)}?locale=${encodeURIComponent(language)}`;
		const res = await fetch(url, {
			headers: {
				Accept: "application/json",
				Cookie: authHeaders.Cookie,
			},
		});
		if (res.ok) {
			const raw = await res.json();
			return raw;
		}
		if (res.status !== 404) {
			const text = await res.text();
			throw new Error(`Cookidoo API HTTP ${res.status}: ${text.slice(0, 400)}`);
		}
	}
	return null;
}

// ─── web scrape fallback ──────────────────────────────────────────────────────

async function tryWebScrape(recipeId, creds, cookieHeader) {
	// Construct the canonical recipe URL
	const webUrl = `${creds.cookidooBaseUrl}/recipes/recipe/${creds.language}/${recipeId}`;
	let res;
	try {
		res = await fetch(webUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
				"Accept-Language": `${creds.language},es;q=0.9`,
				Accept: "text/html,application/xhtml+xml",
				...(cookieHeader ? { Cookie: cookieHeader } : {}),
			},
			redirect: "follow",
		});
	} catch (err) {
		throw new Error(`No pude acceder a la página de Cookidoo: ${err.message}`);
	}

	if (res.status === 404) {
		throw new Error(
			`Receta ${recipeId} no encontrada en Cookidoo. Comprueba que el enlace sea correcto y que la receta sea pública.`,
		);
	}
	if (!res.ok) {
		throw new Error(`Cookidoo web HTTP ${res.status} al obtener la receta.`);
	}

	const html = await res.text();
	const scraped = extractFromHtml(html);
	if (!scraped) {
		throw new Error(
			`No pude extraer datos de la página Cookidoo (puede ser que requiera login o sea contenido dinámico). Prueba a pegar el JSON de la receta directamente.`,
		);
	}
	return scraped;
}

// ─── normalize raw data ───────────────────────────────────────────────────────

/**
 * Adapta el objeto extraído (API o scraping) al formato interno de Mimi.
 * - Si tiene el esquema de la API móvil Cookidoo → parseCookidooApiContent.
 * - Si tiene el esquema JSON-LD (@type Recipe) → convierte a interno directamente.
 */
function normalizeRawData(meta, raw) {
	const content = raw?.recipeContent ?? raw;

	// JSON-LD schema.org Recipe
	if (raw?.["@type"] === "Recipe" || raw?.recipeIngredient) {
		return normalizeSchemaDotOrg(raw);
	}

	// Cookidoo API / Next.js data
	return parseCookidooApiContent(meta ?? raw, content);
}

function decodeHtmlEntities(s) {
	return String(s || "")
		.replace(/&frac12;/g, "½")
		.replace(/&frac14;/g, "¼")
		.replace(/&frac34;/g, "¾")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function normalizeSchemaDotOrg(data) {
	const title = String(data.name || "Receta importada").trim();
	const description = decodeHtmlEntities(data.description || "").trim();

	const rawIngredients = Array.isArray(data.recipeIngredient)
		? data.recipeIngredient
		: [];
	const ingredients = rawIngredients.map((line) => {
		const s = decodeHtmlEntities(line).trim();
		const m = s.match(
			/^([\d.,/½¼¾]+\s*(?:g|kg|ml|l|cucharad[a-z]*|pizca|unidad[es]*)?)?\s*(?:de\s+)?(.+)$/i,
		);
		return {
			quantity: m?.[1]?.trim() || "",
			name: m?.[2]?.trim() || s,
		};
	});

	const rawSteps = Array.isArray(data.recipeInstructions)
		? data.recipeInstructions
		: [];
	const steps = rawSteps.map((step, i) => {
		const text = decodeHtmlEntities(
			typeof step === "string" ? step : String(step?.text || step?.name || ""),
		).trim();
		return { order: i + 1, text, tm_mode: "", ingredient_indices: [] };
	});

	const servings =
		Number(String(data.recipeYield || "4").match(/\d+/)?.[0]) || 4;

	// Cookidoo no incluye pasos en JSON-LD → marcamos como parcial para que
	// Mimi los genere adaptados a Thermomix.
	const partial = steps.length === 0;

	const totalMin = (() => {
		const iso = String(data.totalTime || data.cookTime || "");
		const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
		if (!m) return 30;
		return (Number(m[1] || 0) * 60) + Number(m[2] || 0) || 30;
	})();

	return {
		title,
		description,
		difficulty: "media",
		total_time_min: totalMin,
		servings,
		ingredients,
		steps,
		tags: ["importada-cookidoo"],
		nutrition_notes: "",
		_partial: partial,
		source: { format: "schema-org", importedAt: new Date().toISOString() },
	};
}

// ─── main export ──────────────────────────────────────────────────────────────

/**
 * Descarga y parsea al formato interno la receta indicada.
 * @param {string} recipeId  p. ej. "r379830"
 * @param {string} credentialsPath
 * @param {string} [cookiesPath]
 * @returns {Promise<object>}  receta en formato interno Mimi
 */
async function fetchCookidooRecipe(recipeId, credentialsPath, cookiesPath) {
	const creds = await loadCookidooCredentials(credentialsPath);

	// Construye la sesión por cookies del navegador. Si no hay cookies
	// válidas, seguimos sin ellas (el scraping de páginas públicas puede bastar).
	let apiBase = null;
	let authHeaders = null;
	let cookieHeader = "";
	try {
		const session = await buildCookidooSession(creds, cookiesPath);
		apiBase = session.apiBase;
		authHeaders = session.authHeaders;
		cookieHeader = session.authHeaders.Cookie;
	} catch (authErr) {
		console.warn(
			"Sin sesión de Cookidoo, intentaré solo scraping público:",
			authErr.message,
		);
	}

	// 1. Con sesión: intenta la API (recetas del usuario y del catálogo).
	if (apiBase && authHeaders) {
		let rawApi = null;
		try {
			rawApi = await tryApiFetch(recipeId, apiBase, authHeaders, creds.language);
		} catch (apiErr) {
			console.warn("Cookidoo API falló, intentando scraping web:", apiErr.message);
		}
		if (rawApi) {
			const recipe = normalizeRawData(rawApi, rawApi);
			recipe._cookidooNative = {
				meta: rawApi,
				content: rawApi?.recipeContent ?? rawApi,
			};
			recipe._cookidooRecipeId = recipeId;
			return recipe;
		}
	}

	// 2. Fallback: rasca la página web (con cookies si las hay).
	console.log(`Intentando scraping web para ${recipeId}…`);
	const scraped = await tryWebScrape(recipeId, creds, cookieHeader);
	const recipe = normalizeRawData(null, scraped);
	recipe._cookidooRecipeId = recipeId;
	return recipe;
}

module.exports = { fetchCookidooRecipe };
