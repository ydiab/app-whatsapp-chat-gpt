/**
 * Escalado lineal de cantidades y tiempos. El chat ya no lo usa al importar:
 * Mimi ajusta con criterio de cocina. Se deja por si hace falta un factor fijo.
 */

const UNICODE_FRACTIONS = {
	"½": 0.5,
	"¼": 0.25,
	"¾": 0.75,
	"⅓": 1 / 3,
	"⅔": 2 / 3,
};

const SERVING_UNIT = "(?:personas?|raciones?|comensales?|porciones?|pax)";

const SERVING_NUM = `(\\d{1,2})\\s*${SERVING_UNIT}\\b|\\bpara\\s+(\\d{1,2})\\b(?!\\s*(?:min|minuto|seg|segundo|hora|°|grado|g\\b|gramo|kg|ml|l\\b|litro|cucharad))`;

/**
 * @param {string} quantity
 * @returns {{ amount: number, rest: string } | null}
 */
function parseQuantity(quantity) {
	const raw = String(quantity || "").trim();
	if (!raw) {
		return null;
	}

	const mixedUnicode = raw.match(/^(\d+)\s*([½¼¾⅓⅔])\s*(.*)$/);
	if (mixedUnicode) {
		return {
			amount: Number(mixedUnicode[1]) + UNICODE_FRACTIONS[mixedUnicode[2]],
			rest: mixedUnicode[3].trim(),
		};
	}

	const mixedSlash = raw.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*(.*)$/);
	if (mixedSlash) {
		const den = Number(mixedSlash[3]);
		if (den) {
			return {
				amount: Number(mixedSlash[1]) + Number(mixedSlash[2]) / den,
				rest: mixedSlash[4].trim(),
			};
		}
	}

	const unicode = raw.match(/^([½¼¾⅓⅔])\s*(.*)$/);
	if (unicode) {
		return {
			amount: UNICODE_FRACTIONS[unicode[1]],
			rest: unicode[2].trim(),
		};
	}

	const slash = raw.match(/^(\d+)\s*\/\s*(\d+)\s*(.*)$/);
	if (slash) {
		const den = Number(slash[2]);
		if (den) {
			return {
				amount: Number(slash[1]) / den,
				rest: slash[3].trim(),
			};
		}
	}

	const decimal = raw.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
	if (decimal) {
		return {
			amount: Number(decimal[1].replace(",", ".")),
			rest: decimal[2].trim(),
		};
	}

	return null;
}

function formatAmount(amount, rest) {
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}

	const unit = String(rest || "").trim();
	const isSpoon = /cucharad|pellizco|pizca/i.test(unit);
	let n = amount;

	if (isSpoon) {
		const nearestHalf = Math.round(n * 2) / 2;
		n = nearestHalf < 0.5 ? 0.5 : nearestHalf;
		if (n === 0.5) {
			return `1/2${unit ? ` ${unit}` : ""}`;
		}
		if (n % 1 === 0.5) {
			return `${Math.floor(n)} 1/2${unit ? ` ${unit}` : ""}`;
		}
		return `${Math.round(n)}${unit ? ` ${unit}` : ""}`;
	}

	if (Math.abs(n - Math.round(n)) < 0.05) {
		n = Math.round(n);
	} else {
		n = Math.round(n * 10) / 10;
	}
	return `${n}${unit ? ` ${unit}` : ""}`;
}

function scaleQuantityString(quantity, factor) {
	const parsed = parseQuantity(quantity);
	if (!parsed) {
		return quantity;
	}
	const scaled = formatAmount(parsed.amount * factor, parsed.rest);
	return scaled || quantity;
}

/**
 * El volumen no duplica el tiempo. Para 2× cantidad:
 *   cocción/sofrito/vapor ≈ 1,4× (más masa que calentar en el vaso)
 *   horno ≈ 1,25× (capa más gruesa, pero el aire del horno no escala)
 *   picar/mezclar ≈ 1,2× (más carga en las cuchillas; 2× dejaría puré)
 */
function timeMultiplier(servingsFactor, intensity) {
	return 1 + (servingsFactor - 1) * intensity;
}

const TIME_INTENSITY = {
	cook: 0.4,
	oven: 0.25,
	chop: 0.2,
};

function scaleDurationNumber(value, servingsFactor, intensity) {
	const n = Number(String(value).replace(",", "."));
	if (!Number.isFinite(n) || n <= 0) {
		return value;
	}
	return Math.max(1, Math.round(n * timeMultiplier(servingsFactor, intensity)));
}

function windowAround(text, index, radius = 56) {
	const start = Math.max(0, index - radius);
	const end = Math.min(text.length, index + radius);
	return text.slice(start, end);
}

function isPreheatWindow(text, index) {
	return /precalient/i.test(windowAround(text, index));
}

function isOvenBakeWindow(text, index) {
	const w = windowAround(text, index);
	if (/precalient/i.test(w)) {
		return false;
	}
	return /hornee|hornear|horno|grill/i.test(w);
}

function replaceDurationRange(a, range, space, unit, scale) {
	const left = scale(a);
	if (!range) {
		return `${left}${space}${unit}`;
	}
	const rightRaw = range.match(/(\d+(?:[.,]\d+)?)\s*$/);
	const right = rightRaw ? scale(rightRaw[1]) : range;
	return `${left}-${right}${space}${unit}`;
}

/**
 * Ajusta minutos y segundos de un chip o de un paso. No toca °C ni velocidades.
 * El precalentamiento del horno (horno vacío) se deja igual.
 */
function scaleTimesInString(raw, servingsFactor) {
	const original = String(raw || "");
	if (!original || servingsFactor === 1) {
		return original;
	}

	let text = original.replace(
		/(\d+(?:[.,]\d+)?)(\s*[-–]\s*\d+(?:[.,]\d+)?)?(\s*)(min(?:utos?)?)/gi,
		(full, a, range, space, unit, offset) => {
			if (isPreheatWindow(original, offset)) {
				return full;
			}
			const intensity = isOvenBakeWindow(original, offset)
				? TIME_INTENSITY.oven
				: TIME_INTENSITY.cook;
			return replaceDurationRange(a, range, space, unit, (n) =>
				scaleDurationNumber(n, servingsFactor, intensity),
			);
		},
	);

	text = text.replace(
		/(\d+(?:[.,]\d+)?)(\s*[-–]\s*\d+(?:[.,]\d+)?)?(\s*)(seg(?:undos?)?)/gi,
		(_full, a, range, space, unit) =>
			replaceDurationRange(a, range, space, unit, (n) =>
				scaleDurationNumber(n, servingsFactor, TIME_INTENSITY.chop),
			),
	);

	return text;
}

function scaleCookTimes(tmMode, servingsFactor) {
	return scaleTimesInString(tmMode, servingsFactor);
}

function scaleTotalTimeMin(total, servingsFactor) {
	const n = Number(total);
	if (!Number.isFinite(n) || n <= 0) {
		return total;
	}
	return Math.max(
		1,
		Math.round(n * timeMultiplier(servingsFactor, TIME_INTENSITY.cook)),
	);
}

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scaleQuantitiesInText(text, replacements) {
	let next = String(text || "");
	const sorted = [...replacements].sort(
		(a, b) => String(b.from).length - String(a.from).length,
	);
	for (const { from, to } of sorted) {
		if (!from || from === to) {
			continue;
		}
		next = next.replace(new RegExp(escapeRegExp(from), "g"), to);
	}
	return next;
}

/**
 * @param {object} recipe
 * @param {number} fromServings
 * @param {number} toServings
 */
function scaleRecipe(recipe, fromServings, toServings) {
	const factor = toServings / fromServings;
	if (!Number.isFinite(factor) || factor <= 0 || factor === 1) {
		return recipe;
	}

	const replacements = [];
	const ingredients = (recipe.ingredients || []).map((ing) => {
		const nextQty = scaleQuantityString(ing.quantity, factor);
		if (ing.quantity && nextQty !== ing.quantity) {
			replacements.push({ from: ing.quantity, to: nextQty });
		}
		return { ...ing, quantity: nextQty };
	});

	const steps = (recipe.steps || []).map((step) => ({
		...step,
		text: scaleTimesInString(
			scaleQuantitiesInText(step.text, replacements),
			factor,
		),
		tm_mode: scaleCookTimes(step.tm_mode, factor),
	}));

	return {
		...recipe,
		servings: toServings,
		total_time_min: scaleTotalTimeMin(recipe.total_time_min, factor),
		ingredients,
		steps,
	};
}

function parseServingsCandidates(text) {
	const s = String(text || "").toLowerCase();
	const re = new RegExp(SERVING_NUM, "g");
	const nums = [];
	let match = re.exec(s);
	while (match) {
		nums.push(Number(match[1] ?? match[2]));
		match = re.exec(s);
	}
	return nums;
}

function parseStatedOriginal(text) {
	const s = String(text || "").toLowerCase();
	const m = s.match(
		new RegExp(
			`(?:capturas?|fotos?|screenshots?|receta|original(?:es)?|estas?|estos?|son|es|está)\\b[^.\\n]{0,50}?(?:para|de)\\s+(\\d{1,2})\\s*${SERVING_UNIT}`,
		),
	);
	return m ? Number(m[1]) : null;
}

function parseStatedTarget(text) {
	const s = String(text || "").toLowerCase();
	const m = s.match(
		new RegExp(
			`(?:quiero|queremos|quería|queria|necesito|haz(?:me|la)?|pásala|pasarla|adapta(?:r)?|escala(?:r)?|clona(?:r)?|súbela|sube)\\b[^.\n]{0,80}?(?:para\\s+(\\d{1,2})\\b(?!\\s*(?:min|minuto|seg|segundo|hora|g\\b|gramo))|(\\d{1,2})\\s*${SERVING_UNIT})`,
		),
	);
	return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * Deduce origen y destino de raciones sin depender del orden de los números.
 * Prioriza pistas lingüísticas ("son para 2" vs "quiero para 4"); si no hay,
 * el número que no coincide con las raciones extraídas es el destino.
 *
 * @returns {{ original: number, target: number } | null}
 */
function inferServingsChange(instruction, extractedServings) {
	const extracted = Number(extractedServings);
	const extractedOk = Number.isFinite(extracted) && extracted > 0;
	const statedOriginal = parseStatedOriginal(instruction);
	const statedTarget = parseStatedTarget(instruction);
	const candidates = parseServingsCandidates(instruction);

	let original = statedOriginal || (extractedOk ? extracted : null);
	let target = statedTarget;

	if (target && original && target === original) {
		target = null;
	}

	if (!target) {
		const differing = candidates.filter((n) => n > 0 && n !== original);
		if (differing.length === 1) {
			target = differing[0];
		} else if (differing.length > 1 && statedOriginal) {
			target = differing.find((n) => n !== statedOriginal) ?? null;
		}
	}

	if (!original && target && candidates.length === 2) {
		original = candidates.find((n) => n !== target) ?? null;
	}

	if (!original || !target || original === target) {
		return null;
	}
	return { original, target };
}

module.exports = {
	parseQuantity,
	scaleQuantityString,
	scaleRecipe,
	scaleCookTimes,
	scaleTimesInString,
	inferServingsChange,
	parseServingsCandidates,
};
