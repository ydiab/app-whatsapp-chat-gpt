/** WhatsApp reply button titles are max 20 characters. */
const UPLOAD_TO_COOKIDOO_BUTTON_ID = "upload_to_cookidoo";

/** Línea que el modelo añade al final cuando la receta está completa (no se muestra al usuario). */
const RECETA_LISTA_MARKER = "[RECETA_LISTA]";

/** A partir de cuántos mensajes recientes se resume el bloque anterior. */
const COMPACT_THRESHOLD = 12;

/** Mensajes recientes que se conservan sin resumir tras compactar. */
const KEEP_RECENT_MESSAGES = 6;

/** Tope de seguridad en RAM (después de compactar, no debería alcanzarse). */
const MAX_CONVERSATION_MESSAGES = 16;

module.exports = {
	UPLOAD_TO_COOKIDOO_BUTTON_ID,
	RECETA_LISTA_MARKER,
	COMPACT_THRESHOLD,
	KEEP_RECENT_MESSAGES,
	MAX_CONVERSATION_MESSAGES,
};
