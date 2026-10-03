import express from "express";
import {
  getAppRole,
  isCloudQueueConfigured,
  runDueCloudPublisher,
  shouldRunCloudPublisher,
} from "./src/cloudQueue.mjs";

const app = express();
const port = Number(process.env.PORT || 10000);
const workerIntervalMs = 30 * 1000;
const workerId = `render-publisher-${process.pid}`;

let lastRunStartedAt = null;
let lastRunFinishedAt = null;
let lastRunResult = null;
let lastRunError = null;
let tickRunning = false;

async function tick(reason = "interval") {
  if (tickRunning) return;

  tickRunning = true;
  lastRunStartedAt = new Date().toISOString();

  try {
    const result = await runDueCloudPublisher({ maxJobs: 5 });
    lastRunResult = { reason, ...result };
    lastRunError = null;
  } catch (error) {
    lastRunError =
      error instanceof Error ? error.message : String(error);
    console.error("Cloud publisher tick failed:", error);
  } finally {
    lastRunFinishedAt = new Date().toISOString();
    tickRunning = false;
  }
}

app.get("/", (_req, res) => {
  res.json({
    service: "Modifica Facebook Publisher",
    role: getAppRole(),
    configured: isCloudQueueConfigured(),
    publisherEnabled: shouldRunCloudPublisher(),
    workerId,
  });
});

app.get("/health", (_req, res) => {
  void tick("health");

  res.json({
    ok: true,
    service: "Modifica Facebook Publisher",
    role: getAppRole(),
    configured: isCloudQueueConfigured(),
    publisherEnabled: shouldRunCloudPublisher(),
    tickRunning,
    lastRunStartedAt,
    lastRunFinishedAt,
    lastRunResult,
    lastRunError,
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Modifica Facebook publisher listening on port ${port}`);
  console.log(`APP_ROLE=${getAppRole()}`);
  console.log(
    shouldRunCloudPublisher()
      ? "Cloud publisher enabled."
      : "Cloud publisher is waiting for its server-side environment variables.",
  );

  setTimeout(() => {
    void tick("startup");
  }, 3000);

  setInterval(() => {
    void tick("interval");
  }, workerIntervalMs);
});
