/**
 * Normalización de ingredientes y parsing de modos Thermomix para Cookidoo (ES).
 * Formato de chip: "7 min / 100°C / Vel 1 / giro inverso" (slashes, como en cookidoo-api).
 */

const GRAMMAR_ES = {
	name: "es",
	timeUnits: {
		s: 1,
		seg: 1,
		segundos: 1,
		min: 60,
		minutos: 60,
		h: 3600,
		hora: 3600,
		horas: 3600,
	},
	timeUnitsPattern: "min(?:utos?)?|seg(?:undos?)?|s|h",
	speedLabel: "Vel\\.?",
	reverseWord: "giro\\s*inverso|inverso",
};

function firstTimePart(raw) {
	const match = /^(\d+)/.exec(String(raw));
	return match ? match[1] : String(raw);
}

function timeToSeconds(value, unit) {
	const normalized = String(value).replace(",", ".");
	const unitKey = unit.replace(/\.$/, "").toLowerCase();
	const multiplier = GRAMMAR_ES.timeUnits[unitKey];
	if (multiplier === undefined) {
		return null;
	}
	return Math.round(parseFloat(normalized) * multiplier);
}

function parseSpeed(raw) {
	const text = String(raw || "").trim();
	let direction = "CW";
	if (new RegExp(GRAMMAR_ES.reverseWord, "i").test(text)) {
		direction = "CCW";
	}
	if (/cuchara|spoon|\bsoft\b/i.test(text)) {
		return { speed: "soft", direction };
	}
	const m = /(\d+(?:[,.]\d+)?)/.exec(text);
	if (!m) {
		return { speed: "1", direction };
	}
	const raw2 = m[1].replace(",", ".");
	const num = parseFloat(raw2);
	return {
		speed: Number.isInteger(num) ? String(num) : raw2,
		direction,
	};
}

function buildTtsData(timeVal, speed, direction, tempStr) {
	const data = { time: timeVal, speed };
	if (direction === "CCW") {
		data.direction = direction;
	}
	if (tempStr) {
		data.temperature = { value: tempStr, unit: "C" };
	}
	return data;
}

function buildModeRegexes() {
	const t = GRAMMAR_ES.timeUnitsPattern;
	const sp = GRAMMAR_ES.speedLabel;
	const rev = GRAMMAR_ES.reverseWord;
	const speedToken = `(?:soft|cuchara|spoon|(?:${rev}\\s*)?\\d+(?:[,.]\\d+)?)(?:\\s+${rev})?`;
	return {
		full: new RegExp(
			`(\\d+(?:[-–]\\d+)?)\\s*(${t})\\s*\\/\\s*(?:(\\d+)\\s*°\\s*C|(Varoma))\\s*\\/\\s*${sp}\\s*(${speedToken})`,
			"gi",
		),
		timeSpeed: new RegExp(
			`(\\d+(?:[-–]\\d+)?)\\s*(${t})\\s*\\/\\s*${sp}\\s*(${speedToken})`,
			"gi",
		),
		browning: new RegExp(GRAMMAR_ES.browningTrigger, "i"),
	};
}

/**
 * Anotaciones de cocción enlazables. Cookidoo usa type "TTS" (no MODE/manual) para
 * tiempo/temperatura/velocidad; MODE solo para Varoma (steaming) y modos especiales.
 * @param {string} text
 * @returns {object[]}
 */
function findCookingAnnotationsInText(text) {
	const out = [];
	const { full, timeSpeed } = buildModeRegexes();

	for (const m of text.matchAll(full)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		const timeVal = timeToSeconds(firstTimePart(m[1]), m[2]);
		if (timeVal == null) continue;

		const { speed, direction } = parseSpeed(m[5]);
		const tempStr = m[3];
		const varoma = m[4];

		if (varoma !== undefined) {
			out.push({
				type: "MODE",
				name: "steaming",
				data: {
					time: timeVal,
					speed,
					direction,
					accessory: "Varoma",
				},
				position: { offset: start, length: end - start },
			});
		} else if (tempStr) {
			out.push({
				type: "TTS",
				data: buildTtsData(timeVal, speed, direction, tempStr),
				position: { offset: start, length: end - start },
			});
		}
	}

	for (const m of text.matchAll(timeSpeed)) {
		const start = m.index ?? 0;
		const end = start + m[0].length;
		const overlaps = out.some(
			(a) =>
				!(
					end <= a.position.offset ||
					start >= a.position.offset + a.position.length
				),
		);
		if (overlaps) continue;

		const timeVal = timeToSeconds(firstTimePart(m[1]), m[2]);
		if (timeVal == null) continue;
		const { speed, direction } = parseSpeed(m[3]);

		out.push({
			type: "TTS",
			data: buildTtsData(timeVal, speed, direction),
			position: { offset: start, length: end - start },
		});
	}

	out.sort((a, b) => a.position.offset - b.position.offset);
	return out;
}

/**
 * Convierte cantidades sueltas a gramos para la báscula TM.
 * @param {string} quantity
 * @returns {string}
 */
function normalizeQuantityToGrams(quantity) {
	let q = String(quantity || "").trim();
	if (!q) return q;

	const parenG = q.match(/\((\d+(?:[.,]\d+)?)\s*g\)/i);
	if (parenG) {
		const g = parenG[1].replace(",", ".");
		q = `${g} g`;
	}

	q = q.replace(/(\d+(?:[.,]\d+)?)\s*ml\b/gi, (_, n) => {
		const num = n.replace(",", ".");
		return `${num} g`;
	});

	q = q.replace(/(\d+(?:[.,]\d+)?)\s*l\b/gi, (_, n) => {
		const num = parseFloat(n.replace(",", ".")) * 1000;
		return `${Number.isInteger(num) ? num : Math.round(num)} g`;
	});

	q = q.replace(
		/^(\d+)\s+(?:unidad(?:es)?|ud\.?|pieza(?:s)?)\b/i,
		"",
	);

	if (!/\bg\b/i.test(q) && /^\d+(?:[.,]\d+)?$/.test(q)) {
		q = `${q} g`;
	}

	if (/\d/.test(q) && !/\bg\b/i.test(q)) {
		const num = q.match(/^(\d+(?:[.,]\d+)?)/);
		const rest = q.replace(/^(\d+(?:[.,]\d+)?)\s*/, "").trim();
		if (num && rest) {
			q = `${num[1].replace(",", ".")} g`;
		}
	}

	return q.replace(/\s+/g, " ").trim();
}

/**
 * @param {{ name?: string, quantity?: string }} item
 * @returns {string}
 */
function formatIngredientLine(item) {
	const name = item.name != null ? String(item.name).trim() : "";
	const quantity = normalizeQuantityToGrams(
		item.quantity != null ? String(item.quantity).trim() : "",
	);

	if (!name && !quantity) {
		return "ingrediente";
	}
	if (!quantity) {
		return name;
	}
	if (!name) {
		return quantity;
	}

	if (/^\d/.test(quantity) && !/\bde\b/i.test(quantity)) {
		return `${quantity} de ${name}`;
	}
	return `${quantity} ${name}`;
}

/**
 * Normaliza texto libre de tm_mode a chip enlazable (slashes).
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeTmModeChip(raw) {
	const s = String(raw || "").trim();
	if (!s) return null;

	if (/\d+\s*min\s*\/\s*\d+\s*°\s*C\s*\/\s*Vel/i.test(s)) {
		return s.replace(/\s*\/\s*giro\s*inverso/i, " giro inverso");
	}

	const min = s.match(/(\d+(?:[.,]\d+)?)\s*min(?:utos?)?/i);
	const sec = s.match(/(\d+)\s*seg(?:undos?)?/i);
	const temp =
		/Varoma/i.test(s) ? "Varoma" : s.match(/(\d+)\s*°?\s*C/i)?.[1];
	const reverse = /giro\s*inverso|inverso|antihorario/i.test(s);

	let speed = "1";
	if (/cuchara|spoon/i.test(s)) {
		speed = "soft";
	} else {
		const vel = s.match(/vel(?:ocidad)?\.?\s*([\d.,]+|soft|cuchara)/i);
		if (vel) {
			speed = /cuchara/i.test(vel[1]) ? "soft" : vel[1].replace(",", ".");
		}
	}

	const parts = [];
	if (min) {
		parts.push(`${min[1].replace(",", ".")} min`);
	} else if (sec) {
		parts.push(`${sec[1]} seg`);
	} else {
		return null;
	}

	if (temp === "Varoma") {
		parts.push("Varoma");
	} else if (temp) {
		parts.push(`${temp}°C`);
	}

	const velPart = reverse ? `Vel ${speed} giro inverso` : `Vel ${speed}`;
	parts.push(velPart);

	return parts.join(" / ");
}

/**
 * @param {{ tm_mode?: string, text?: string }} step
 * @returns {string|null}
 */
function resolveTmModeChip(step) {
	const fromField = normalizeTmModeChip(step.tm_mode);
	if (fromField) return fromField;

	const combined = [step.text, step.tm_mode].filter(Boolean).join(" ");
	return normalizeTmModeChip(combined);
}

module.exports = {
	formatIngredientLine,
	normalizeQuantityToGrams,
	normalizeTmModeChip,
	resolveTmModeChip,
	findCookingAnnotationsInText,
	/** @deprecated use findCookingAnnotationsInText */
	findModeAnnotationsInText: findCookingAnnotationsInText,
};
