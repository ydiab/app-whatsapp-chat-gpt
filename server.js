require("dotenv").config();

const { createApp, getConfig } = require("./src/app");

const app = createApp();
const { port } = getConfig();

app.listen(port, () => {
	console.log(`Listening on port ${port}`);
});
