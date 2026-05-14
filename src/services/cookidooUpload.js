/**
 * Subida directa a Cookidoo (no API pública oficial).
 * Flujo alineado con el cliente móvil (token) + endpoints web de recetas creadas,
 * documentado en proyectos comunitarios (p. ej. mcp-cookidoo / cookidoo-api).
 * Puede dejar de funcionar si Vorwerk cambia la API; úsalo bajo tu responsabilidad.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

/** Mismo cliente OAuth que usa la app móvil Cookidoo (público en cookidoo-api). */
const COOKIDOO_TOKEN_AUTHORIZATION =
	"Basic a3VwZmVyd2Vyay1jbGllbnQtbndvdDpMczUwT04xd295U3FzMWRDZEpnZQ==";

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function loadCookidooCredentials(credentialsPath) {
	const resolved = path.resolve(credentialsPath);
	const raw = await fs.readFile(resolved, "utf8");
	const data = JSON.parse(raw);
	for (const key of [
		"email",
		"password",
		"countryCode",
		"cookidooBaseUrl",
		"language",
	]) {
		if (!data[key]) {
			throw new Error(`Falta el campo "${key}" en ${resolved}`);
		}
	}
	/** Valores permitidos por la API web (fixtures cookidoo-api usan "portion"). */
	const yieldUnitText =
		data.yieldUnitText === null || data.yieldUnitText === undefined
			? "portion"
			: String(data.yieldUnitText);

	return {
		email: String(data.email),
		password: String(data.password),
		countryCode: String(data.countryCode).toLowerCase(),
		cookidooBaseUrl: String(data.cookidooBaseUrl).replace(/\/$/, ""),
		language: String(data.language),
		tools:
			Array.isArray(data.tools) && data.tools.length > 0 ? data.tools : ["TM7"],
		yieldUnitText,
	};
}

async function cookidooRequestToken(creds) {
	const tokenUrl = `https://${creds.countryCode}.tmmobile.vorwerk-digital.com/ciam/auth/token`;
	const body = new URLSearchParams({
		grant_type: "password",
		username: creds.email,
		password: creds.password,
	});

	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: COOKIDOO_TOKEN_AUTHORIZATION,
		},
		body,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Cookidoo login HTTP ${response.status}: ${text.slice(0, 280)}`,
		);
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("Cookidoo login: respuesta no JSON");
	}

	if (!data.access_token) {
		throw new Error("Cookidoo login: no access_token en la respuesta");
	}

	return data.access_token;
}

function mapRecipeToCookidooPayload(recipe, creds) {
	const title = recipe.title || "Receta";
	const servings = Number(recipe.servings) || 4;
	const totalMin = Number(recipe.total_time_min) || 30;
	const totalSeconds = Math.max(60, totalMin * 60);

	const ingredients = (recipe.ingredients || []).map((item) => {
		const q = item.quantity != null ? String(item.quantity).trim() : "";
		const n = item.name != null ? String(item.name).trim() : "";
		return q && n ? `${q} ${n}` : n || q || "ingrediente";
	});

	const steps = [...(recipe.steps || [])]
		.sort((a, b) => (a.order || 0) - (b.order || 0))
		.map((step) => {
			const t = step.text != null ? String(step.text).trim() : "";
			const mode = step.tm_mode != null ? String(step.tm_mode).trim() : "";
			return mode ? `${t} (${mode})` : t || "paso";
		});

	const hintParts = [];
	if (recipe.description) hintParts.push(String(recipe.description));
	if (recipe.nutrition_notes) hintParts.push(String(recipe.nutrition_notes));
	const hints = hintParts.join("\n\n");

	return {
		title,
		servings,
		totalSeconds,
		ingredients,
		steps,
		hints,
		tools: creds.tools,
	};
}

/**
 * Crea receta vacía (POST) y rellena contenido (PATCH), igual que mcp-cookidoo.
 * @returns {{ cookidooRecipeId: string, recipeUrl: string }}
 */
async function uploadRecipeToCookidooAccount(recipe, credentialsPath) {
	const creds = await loadCookidooCredentials(credentialsPath);
	const accessToken = await cookidooRequestToken(creds);

	const baseOrigin = new URL(creds.cookidooBaseUrl).origin;
	const { language } = creds;
	const mapped = mapRecipeToCookidooPayload(recipe, creds);

	const authHeaders = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${accessToken}`,
	};

	const createUrl = `${baseOrigin}/created-recipes/${encodeURIComponent(language)}`;
	const createRes = await fetch(createUrl, {
		method: "POST",
		headers: authHeaders,
		body: JSON.stringify({ recipeName: mapped.title }),
	});

	const createText = await createRes.text();
	if (!createRes.ok) {
		throw new Error(
			`Cookidoo crear receta HTTP ${createRes.status}: ${createText.slice(0, 400)}`,
		);
	}

	let createJson;
	try {
		createJson = JSON.parse(createText);
	} catch {
		throw new Error("Cookidoo crear receta: respuesta no JSON");
	}

	const cookidooRecipeId =
		createJson.recipeId || createJson.id || createJson.recipe?.recipeId;
	if (!cookidooRecipeId) {
		throw new Error(
			"Cookidoo crear receta: no devolvió recipeId en la respuesta",
		);
	}

	await delay(5000);

	const patchUrl = `${baseOrigin}/created-recipes/${encodeURIComponent(language)}/${encodeURIComponent(cookidooRecipeId)}`;
	const patchBody = {
		name: mapped.title,
		image: null,
		isImageOwnedByUser: false,
		tools: mapped.tools,
		yield: { value: mapped.servings, unitText: creds.yieldUnitText },
		prepTime: 0,
		cookTime: 0,
		totalTime: mapped.totalSeconds,
		ingredients: mapped.ingredients.map((text) => ({
			type: "INGREDIENT",
			text,
		})),
		instructions: mapped.steps.map((text) => ({
			type: "STEP",
			text,
		})),
		hints: mapped.hints || "",
		workStatus: "PRIVATE",
		recipeMetadata: {
			requiresAnnotationsCheck: false,
		},
	};

	const patchRes = await fetch(patchUrl, {
		method: "PATCH",
		headers: authHeaders,
		body: JSON.stringify(patchBody),
	});

	const patchText = await patchRes.text();
	if (!patchRes.ok && patchRes.status !== 204) {
		throw new Error(
			`Cookidoo actualizar receta HTTP ${patchRes.status}: ${patchText.slice(0, 500)}`,
		);
	}

	const recipeUrl = `${baseOrigin}/recipes/custom-recipes/${encodeURIComponent(cookidooRecipeId)}`;
	return { cookidooRecipeId, recipeUrl };
}

module.exports = {
	uploadRecipeToCookidooAccount,
};
