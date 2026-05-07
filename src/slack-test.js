const { buildTestText, sendMessageToConfiguredChannel } = require("./slack");

async function main() {
  await sendMessageToConfiguredChannel(buildTestText());
  console.log("Slack test message sent.");
}

main().catch((error) => {
  console.error("Slack test failed.");
  console.error(error);
  process.exitCode = 1;
});
