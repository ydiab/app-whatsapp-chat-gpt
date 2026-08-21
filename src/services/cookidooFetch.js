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
const {
	parseCookidooApiContent,
	splitInstructionAndTm,
	assignIngredientIndicesToRecipe,
} = require("./cookidooParse");

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

async function fetchHtml(webUrl, language, cookieHeader) {
	let res;
	try {
		res = await fetch(webUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
				"Accept-Language": `${language || "es-ES"},es;q=0.9`,
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
			"Receta no encontrada en Cookidoo. Comprueba que el enlace sea correcto y que la receta sea pública.",
		);
	}
	if (!res.ok) {
		throw new Error(`Cookidoo web HTTP ${res.status} al obtener la receta.`);
	}

	return res.text();
}

async function tryWebScrapeAtUrl(webUrl, language, cookieHeader) {
	const html = await fetchHtml(webUrl, language, cookieHeader);
	const scraped = extractFromHtml(html);
	if (!scraped) {
		throw new Error(
			"No pude extraer ingredientes y pasos del código de la página Cookidoo (JSON-LD). Prueba a pegar el JSON de la receta directamente.",
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

function stripHtml(s) {
	return decodeHtmlEntities(String(s || "").replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function flattenSchemaInstructions(rawSteps) {
	const out = [];
	const visit = (node) => {
		if (!node) {
			return;
		}
		if (typeof node === "string") {
			const text = stripHtml(node);
			if (text) {
				out.push(text);
			}
			return;
		}
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (Array.isArray(node.itemListElement)) {
			visit(node.itemListElement);
			return;
		}
		const text = stripHtml(node.text || "");
		if (text) {
			out.push(text);
		}
	};
	visit(rawSteps);
	return out;
}

function parseSchemaIngredientLine(line) {
	const s = stripHtml(line);
	const m = s.match(
		/^((?:\d+\s*[½¼¾]|[½¼¾]|\d+(?:[.,/]\d+)?)\s*(?:g|kg|ml|l|cucharad[a-z]*|pellizco|pizca|unidad[es]*|diente[s]*)?)?\s*(?:de\s+)?(.+)$/i,
	);
	return {
		quantity: m?.[1]?.trim() || "",
		name: m?.[2]?.trim() || s,
	};
}

function normalizeSchemaDotOrg(data) {
	const title = stripHtml(data.name || "Receta importada");
	const description = stripHtml(data.description || "");

	const ingredients = (
		Array.isArray(data.recipeIngredient) ? data.recipeIngredient : []
	)
		.map(parseSchemaIngredientLine)
		.filter((item) => item.name);

	const steps = flattenSchemaInstructions(data.recipeInstructions).map(
		(instruction, i) => {
			const { text, tm_mode } = splitInstructionAndTm(instruction);
			return {
				order: i + 1,
				text: text || instruction,
				tm_mode,
				ingredient_indices: [],
			};
		},
	);

	const servings =
		Number(String(data.recipeYield || "4").match(/\d+/)?.[0]) || 4;

	const calories_per_serving = Number(
		String(data.nutrition?.calories || "").match(/[\d.,]+/)?.[0]?.replace(
			",",
			".",
		),
	);

	const totalMin = (() => {
		const iso = String(data.totalTime || data.cookTime || "");
		const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
		if (!m) {
			return 30;
		}
		return Number(m[1] || 0) * 60 + Number(m[2] || 0) || 30;
	})();

	const tags = [
		"importada-cookidoo",
		...(Array.isArray(data.recipeCategory) ? data.recipeCategory : []),
	]
		.map((tag) => String(tag).trim())
		.filter(Boolean);

	const recipe = {
		title,
		description,
		difficulty: "media",
		total_time_min: totalMin,
		servings,
		ingredients,
		steps,
		tags,
		nutrition_notes: Number.isFinite(calories_per_serving)
			? `~${Math.round(calories_per_serving)} kcal/ración`
			: "",
		...(Number.isFinite(calories_per_serving) && calories_per_serving > 0
			? { calories_per_serving: Math.round(calories_per_serving) }
			: {}),
		_partial: steps.length === 0,
		source: { format: "schema-org", importedAt: new Date().toISOString() },
	};
	return assignIngredientIndicesToRecipe(recipe);
}

// ─── main export ──────────────────────────────────────────────────────────────

/**
 * Descarga y parsea al formato interno la receta indicada.
 * Si hay `pageUrl`, prioriza el JSON-LD público del &lt;head&gt; (ingredientes y pasos).
 * @param {string} recipeId  p. ej. "r379830"
 * @param {string} credentialsPath
 * @param {string} [cookiesPath]
 * @param {string} [pageUrl]  URL completa que pegó la usuaria
 * @returns {Promise<object>}  receta en formato interno Mimi
 */
async function fetchCookidooRecipe(
	recipeId,
	credentialsPath,
	cookiesPath,
	pageUrl,
) {
	let creds = {
		countryCode: "es",
		cookidooBaseUrl: "https://cookidoo.es",
		language: "es-ES",
	};
	try {
		creds = await loadCookidooCredentials(credentialsPath);
	} catch {
		if (!pageUrl) {
			throw new Error(
				"Falta cookidoo-credentials.json y no hay URL completa para leer la receta.",
			);
		}
	}

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

	const webUrl =
		pageUrl ||
		`${creds.cookidooBaseUrl}/recipes/recipe/${creds.language}/${recipeId}`;

	// Catálogo público: el JSON-LD del HTML trae ingredientes y pasos reales.
	try {
		console.log(`Leyendo JSON-LD de ${webUrl}…`);
		const scraped = await tryWebScrapeAtUrl(
			webUrl,
			creds.language,
			cookieHeader,
		);
		const recipe = normalizeRawData(null, scraped);
		recipe._cookidooRecipeId = recipeId;
		if (recipe.ingredients?.length) {
			return recipe;
		}
	} catch (scrapeErr) {
		console.warn("Scraping JSON-LD falló, pruebo API:", scrapeErr.message);
	}

	if (apiBase && authHeaders) {
		let rawApi = null;
		try {
			rawApi = await tryApiFetch(recipeId, apiBase, authHeaders, creds.language);
		} catch (apiErr) {
			console.warn("Cookidoo API falló:", apiErr.message);
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

	throw new Error(
		"No pude extraer la receta de Cookidoo. Comprueba el enlace o pega el JSON.",
	);
}

module.exports = { fetchCookidooRecipe };
