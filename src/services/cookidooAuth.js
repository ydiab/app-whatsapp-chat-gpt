/**
 * Autenticación de Cookidoo por COOKIES de sesión.
 *
 * Vorwerk deshabilitó el login por usuario/contraseña (grant_type=password).
 * Ahora se usa el flujo OAuth2 del navegador y las llamadas a la API van
 * autenticadas con cookies (_oauth2_proxy, v-authenticated, v-is-authenticated)
 * contra https://cookidoo.{tld} (ya no contra *.tmmobile.vorwerk-digital.com).
 *
 * Las cookies se copian del navegador (DevTools → Application → Cookies de
 * cookidoo.es) y se aportan por variable de entorno (COOKIDOO_COOKIE_HEADER o
 * COOKIDOO_COOKIES_JSON) o por el archivo local cookidoo-cookies.json.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

/** Cookie imprescindible que indica sesión válida. */
const SESSION_COOKIE = "_oauth2_proxy";

function resolveCookiesPath(cookiesPath) {
	return path.resolve(
		cookiesPath ||
			process.env.COOKIDOO_COOKIES_PATH ||
			path.join(process.cwd(), "cookidoo-cookies.json"),
	);
}

const LOGIN_HINT =
	"En Render, crea la variable de entorno COOKIDOO_COOKIE_HEADER con la cadena de cookies de cookidoo.es (DevTools → Application → Cookies), p. ej. `_oauth2_proxy=...; v-authenticated=...; v-is-authenticated=true`.";

/**
 * Parsea una cadena de cabecera Cookie ("a=1; b=2") en array de {name, value}.
 * @param {string} header
 * @returns {{ name: string, value: string }[]}
 */
function parseCookieHeaderString(header) {
	return String(header || "")
		.split(/;\s*/)
		.map((pair) => {
			const idx = pair.indexOf("=");
			if (idx < 0) return null;
			const name = pair.slice(0, idx).trim();
			const value = pair.slice(idx + 1).trim();
			if (!name) return null;
			return { name, value };
		})
		.filter(Boolean);
}

/**
 * Normaliza distintos formatos de entrada a { cookieHeader, cookies }.
 * Acepta:
 *   - array de cookies [{ name, value, ... }]
 *   - objeto { cookies: [...] }
 *   - cadena de cabecera Cookie "a=1; b=2"
 * @param {string} raw
 * @param {string} origin  para mensajes de error
 */
function normalizeCookiesInput(raw, origin) {
	const text = String(raw || "").trim();
	if (!text) {
		throw new Error(`La sesión de Cookidoo (${origin}) está vacía. ${LOGIN_HINT}`);
	}

	let cookies = null;

	// 1) ¿Es JSON (array u objeto con .cookies)?
	if (text.startsWith("{") || text.startsWith("[")) {
		try {
			const data = JSON.parse(text);
			cookies = Array.isArray(data) ? data : data.cookies;
		} catch {
			// no era JSON válido; probamos como cabecera Cookie más abajo
		}
	}

	// 2) Si no, tratamos el texto como cadena de cabecera Cookie.
	if (!Array.isArray(cookies)) {
		cookies = parseCookieHeaderString(text);
	}

	if (!Array.isArray(cookies) || cookies.length === 0) {
		throw new Error(`La sesión de Cookidoo (${origin}) no tiene cookies. ${LOGIN_HINT}`);
	}

	const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE);
	if (!sessionCookie?.value) {
		throw new Error(
			`Las cookies no contienen la sesión de Cookidoo (${SESSION_COOKIE}). ${LOGIN_HINT}`,
		);
	}

	// Comprueba caducidad solo de las cookies que traigan fecha (las de DevTools
	// pegadas a mano no la traen, así que esto no molesta).
	const nowSec = Date.now() / 1000;
	const datedSession = cookies.filter(
		(c) =>
			(c.name === SESSION_COOKIE || c.name === "v-authenticated") &&
			typeof c.expires === "number" &&
			c.expires > 0,
	);
	if (datedSession.length > 0 && datedSession.every((c) => c.expires < nowSec)) {
		throw new Error(`La sesión de Cookidoo caducó. ${LOGIN_HINT}`);
	}

	const cookieHeader = cookies
		.filter((c) => c.name && c.value)
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");

	return { cookieHeader, cookies };
}

/**
 * Carga las cookies y construye la cabecera Cookie.
 *
 * Prioridad de origen (la 1 es la más fácil en Render):
 *   1. COOKIDOO_COOKIE_HEADER  → cadena "a=1; b=2" copiada del navegador.
 *   2. COOKIDOO_COOKIES_JSON    → JSON (array u objeto) o también cadena Cookie.
 *   3. Archivo cookidoo-cookies.json (entorno local).
 *
 * @param {string} [cookiesPath]
 * @returns {Promise<{ cookieHeader: string, cookies: object[] }>}
 */
async function loadCookidooCookies(cookiesPath) {
	const envHeader = process.env.COOKIDOO_COOKIE_HEADER;
	if (envHeader?.trim()) {
		return normalizeCookiesInput(envHeader.trim(), "COOKIDOO_COOKIE_HEADER");
	}

	const envJson = process.env.COOKIDOO_COOKIES_JSON;
	if (envJson?.trim()) {
		return normalizeCookiesInput(envJson.trim(), "COOKIDOO_COOKIES_JSON");
	}

	const resolved = resolveCookiesPath(cookiesPath);
	let raw;
	try {
		raw = await fs.readFile(resolved, "utf8");
	} catch {
		throw new Error(
			`No encuentro la sesión de Cookidoo (${resolved}). ${LOGIN_HINT}`,
		);
	}
	return normalizeCookiesInput(raw, resolved);
}

/**
 * Construye el contexto de sesión (base URL + cabeceras) para llamar a la API.
 * @param {{ cookidooBaseUrl: string }} creds
 * @param {string} [cookiesPath]
 * @returns {Promise<{ apiBase: string, baseOrigin: string, authHeaders: object }>}
 */
async function buildCookidooSession(creds, cookiesPath) {
	const { cookieHeader } = await loadCookidooCookies(cookiesPath);
	const baseOrigin = new URL(creds.cookidooBaseUrl).origin;

	return {
		// La API ahora vive en el mismo host que la web (cookidoo.es), las rutas
		// son idénticas a las del antiguo host móvil.
		apiBase: baseOrigin,
		baseOrigin,
		authHeaders: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Cookie: cookieHeader,
		},
	};
}

module.exports = {
	loadCookidooCookies,
	buildCookidooSession,
	resolveCookiesPath,
	SESSION_COOKIE,
};
