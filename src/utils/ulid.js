/**
 * ULID (26 chars, Crockford base32) — alineado con ids tipo Cookidoo.
 */
const crypto = require("node:crypto");

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function timePart10(ms) {
	let t = BigInt(ms);
	let out = "";
	for (let i = 0; i < 10; i++) {
		out = ENCODING[Number(t & 31n)] + out;
		t >>= 5n;
	}
	return out;
}

function randomPart16() {
	const buf = crypto.randomBytes(10);
	let bits = 0n;
	for (const b of buf) {
		bits = (bits << 8n) + BigInt(b);
	}
	let out = "";
	for (let i = 0; i < 16; i++) {
		out = ENCODING[Number(bits & 31n)] + out;
		bits >>= 5n;
	}
	return out;
}

function monotonicUlid() {
	return timePart10(Date.now()) + randomPart16();
}

module.exports = { monotonicUlid };
