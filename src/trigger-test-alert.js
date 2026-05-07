const fs = require("node:fs/promises");
const config = require("./config");

async function main() {
  await fs.writeFile(
    config.testAlertMarkerPath,
    `${new Date().toISOString()}\n`,
    "utf8",
  );

  console.log(`Queued one-shot test alert: ${config.testAlertMarkerPath}`);
}

main().catch((error) => {
  console.error("Failed to queue test alert.");
  console.error(error);
  process.exitCode = 1;
});
