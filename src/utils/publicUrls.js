function baseUrlFromRequest(req, publicBaseUrl) {
	return publicBaseUrl || `${req.protocol}://${req.get("host")}`;
}

function buildInvisibleRecipeUrl(req, recipeId, publicBaseUrl) {
	return `${baseUrlFromRequest(req, publicBaseUrl)}/r/${recipeId}/invisible`;
}

function buildMetadataUrl(req, recipeId, publicBaseUrl) {
	return `${baseUrlFromRequest(req, publicBaseUrl)}/r/${recipeId}`;
}

module.exports = {
	buildInvisibleRecipeUrl,
	buildMetadataUrl,
};
