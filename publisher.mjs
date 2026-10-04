import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAppRole,
  isCloudQueueConfigured,
  runDueCloudPublisher,
  shouldRunCloudPublisher,
} from "./src/cloudQueue.mjs";
import {
  approveSocialCampaign,
  deleteScheduledSocialCampaign,
  editScheduledSocialCampaign,
  isSocialReviewConfigured,
  listSocialCampaigns,
  retrySocialCampaignAi,
  updateSocialCampaign,
  verifyWebsiteOwner,
} from "./src/socialCampaignReview.mjs";

const app = express();
const port = Number(process.env.PORT || 10000);
const workerIntervalMs = 30 * 1000;
const workerId = `render-publisher-${process.pid}`;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(currentDir, "social-dashboard")));

let lastRunStartedAt = null;
let lastRunFinishedAt = null;
let lastRunResult = null;
let lastRunError = null;
let tickRunning = false;

function getPageEnvironment() {
  return {
    mlqId:
      process.env.MLQ_PAGE_ID ||
      process.env.PAGE_ID_QUEZON,
    mlqToken:
      process.env.MLQ_PAGE_ACCESS_TOKEN ||
      process.env.PAGE_ACCESS_TOKEN_QUEZON,
    lawisId:
      process.env.C_LAWIS_PAGE_ID ||
      process.env.PAGE_ID_LAWIS,
    lawisToken:
      process.env.C_LAWIS_PAGE_ACCESS_TOKEN ||
      process.env.PAGE_ACCESS_TOKEN_LAWIS,
  };
}

function missingPublisherEnv() {
  const missing = [];

  if (
    !String(
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "",
    ).trim()
  ) {
    missing.push("SUPABASE_SECRET_KEY");
  }

  const pages = getPageEnvironment();

  if (!String(pages.mlqId || "").trim()) {
    missing.push("MLQ/PAGE_ID_QUEZON");
  }
  if (!String(pages.mlqToken || "").trim()) {
    missing.push("MLQ/PAGE_ACCESS_TOKEN_QUEZON");
  }
  if (!String(pages.lawisId || "").trim()) {
    missing.push("C_LAWIS/PAGE_ID_LAWIS");
  }
  if (!String(pages.lawisToken || "").trim()) {
    missing.push("C_LAWIS/PAGE_ACCESS_TOKEN_LAWIS");
  }

  return missing;
}

function publisherReady() {
  return shouldRunCloudPublisher() && missingPublisherEnv().length === 0;
}

async function tick(reason = "interval") {
  if (tickRunning || !publisherReady()) return;

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

function apiError(res, error) {
  const message =
    error instanceof Error ? error.message : String(error);

  const status =
    /auth|session/i.test(message)
      ? 401
      : /owner access/i.test(message)
        ? 403
        : /required|invalid|lead time|image|branch/i.test(message)
          ? 400
          : /no longer editable|cannot be approved/i.test(message)
            ? 409
            : 500;

  res.status(status).json({ error: message });
}

async function requireOwner(req, res, next) {
  try {
    const owner = await verifyWebsiteOwner(
      String(req.headers.authorization || ""),
    );
    req.modificaOwner = owner;
    next();
  } catch (error) {
    apiError(res, error);
  }
}

app.get("/api/status", (_req, res) => {
  res.json({
    service: "Modifica Social",
    role: getAppRole(),
    databaseConfigured: isSocialReviewConfigured(),
    publisherEnabled: publisherReady(),
    missingPublisherEnvironment: missingPublisherEnv(),
    workerId,
  });
});

app.get(
  "/api/social/campaigns",
  requireOwner,
  async (req, res) => {
    try {
      const payload = await listSocialCampaigns(
        String(req.query.status || "all"),
      );

      res.json({
        owner: req.modificaOwner?.email || req.modificaOwner?.id,
        ...payload,
      });
    } catch (error) {
      apiError(res, error);
    }
  },
);

app.patch(
  "/api/social/campaigns/:campaignId",
  requireOwner,
  async (req, res) => {
    try {
      const campaign = await updateSocialCampaign(
        req.params.campaignId,
        req.body || {},
      );
      res.json({ campaign });
    } catch (error) {
      apiError(res, error);
    }
  },
);

app.post(
  "/api/social/campaigns/:campaignId/retry-ai",
  requireOwner,
  async (req, res) => {
    try {
      const result = await retrySocialCampaignAi(
        req.params.campaignId,
        String(req.headers.authorization || ""),
      );
      res.json(result);
    } catch (error) {
      apiError(res, error);
    }
  },
);

app.patch(
  "/api/social/campaigns/:campaignId/scheduled",
  requireOwner,
  async (req, res) => {
    try {
      const result = await editScheduledSocialCampaign(
        req.params.campaignId,
        {
          caption: req.body?.caption,
          publishAt: req.body?.publishAt,
        },
      );

      res.json(result);
    } catch (error) {
      apiError(res, error);
    }
  },
);

app.delete(
  "/api/social/campaigns/:campaignId/scheduled",
  requireOwner,
  async (req, res) => {
    try {
      const result = await deleteScheduledSocialCampaign(
        req.params.campaignId,
      );

      res.json(result);
    } catch (error) {
      apiError(res, error);
    }
  },
);

app.post(
  "/api/social/campaigns/:campaignId/approve",
  requireOwner,
  async (req, res) => {
    try {
      const result = await approveSocialCampaign(
        req.params.campaignId,
        req.body || {},
      );
      res.json(result);
    } catch (error) {
      apiError(res, error);
    }
  },
);

app.get("/health", (_req, res) => {
  void tick("health");

  res.json({
    ok: true,
    service: "Modifica Social",
    role: getAppRole(),
    databaseConfigured: isSocialReviewConfigured(),
    publisherEnabled: publisherReady(),
    missingPublisherEnvironment: missingPublisherEnv(),
    tickRunning,
    lastRunStartedAt,
    lastRunFinishedAt,
    lastRunResult,
    lastRunError,
  });
});

app.use((_req, res) => {
  res.sendFile(
    path.join(currentDir, "social-dashboard", "index.html"),
  );
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Modifica Social listening on port ${port}`);
  console.log(`APP_ROLE=${getAppRole()}`);
  console.log(
    isSocialReviewConfigured()
      ? "Social campaign review database enabled."
      : "Social campaign review waiting for Supabase server key.",
  );
  console.log(
    publisherReady()
      ? "Cloud publisher enabled."
      : `Cloud publisher waiting for: ${missingPublisherEnv().join(", ") || "Supabase configuration"}`,
  );

  setTimeout(() => {
    void tick("startup");
  }, 3000);

  setInterval(() => {
    void tick("interval");
  }, workerIntervalMs);
});
