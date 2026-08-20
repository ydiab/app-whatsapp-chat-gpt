require("dotenv").config();

const { createApp, getConfig } = require("./src/app");

const app = createApp();
const { port } = getConfig();

app.listen(port, () => {
	console.log(`Listening on port ${port}`);
	if (process.env.MIMI_DEV) {
		console.log("Watch mode: edits to server.js or src/ will reload automatically");
	}
});
