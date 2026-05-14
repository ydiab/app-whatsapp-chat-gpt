/**
 * Optional integration: POST your recipe JSON to a URL you control.
 * Cookidoo has no official public API for third-party apps; many builders use
 * a small self-hosted bridge (e.g. Python + cookidoo-api) — see project notes.
 */
async function pushRecipeToCookidooBridge({
	bridgeUrl,
	bridgeSecret,
	recipe,
	whatsappFrom,
}) {
	const headers = {
		"Content-Type": "application/json",
	};
	if (bridgeSecret) {
		headers.Authorization = `Bearer ${bridgeSecret}`;
	}

	const response = await fetch(bridgeUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			recipe,
			whatsappFrom,
		}),
	});

	const text = await response.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = null;
	}

	if (!response.ok) {
		throw new Error(
			`Cookidoo bridge HTTP ${response.status}: ${text.slice(0, 400)}`,
		);
	}

	return { parsed, raw: text };
}

module.exports = { pushRecipeToCookidooBridge };
