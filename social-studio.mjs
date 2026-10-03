import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 10000);
const socialUrl = String(process.env.SUPABASE_URL || "").trim();
const serviceRoleKey = String(process.env.SUPABASE_SECRET_KEY || "").trim();
const storageBucket =
  String(process.env.SUPABASE_STORAGE_BUCKET || "").trim() ||
  "scheduled-post-images";
const adminUsername = String(process.env.ADMIN_USERNAME || "").trim();
const adminPassword = String(process.env.ADMIN_PASSWORD || "").trim();

const social =
  socialUrl && serviceRoleKey
    ? createClient(socialUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null;

app.use(express.json({ limit: "1mb" }));

function jsonError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message,
  });
}

function dashboardConfigured() {
  return Boolean(
    socialUrl &&
      serviceRoleKey &&
      adminUsername &&
      adminPassword,
  );
}

function requireDashboardAuth(req, res, next) {
  if (!dashboardConfigured()) {
    return jsonError(
      res,
      503,
      "Modifica Social Review is waiting for its server-side environment variables.",
    );
  }

  const authorization = String(req.headers.authorization || "");
  const [scheme, encoded] = authorization.split(" ");

  if (scheme !== "Basic" || !encoded) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Modifica Social Review"',
    );
    return res.status(401).send("Authentication required");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    decoded = "";
  }

  const separator = decoded.indexOf(":");
  const username =
    separator >= 0 ? decoded.slice(0, separator) : "";
  const password =
    separator >= 0 ? decoded.slice(separator + 1) : "";

  const usernameMatches =
    username.length === adminUsername.length &&
    crypto.timingSafeEqual(
      Buffer.from(username),
      Buffer.from(adminUsername),
    );
  const passwordMatches =
    password.length === adminPassword.length &&
    crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(adminPassword),
    );

  if (!usernameMatches || !passwordMatches) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Modifica Social Review"',
    );
    return res.status(401).send("Invalid credentials");
  }

  next();
}

function normalizePage(branch) {
  const value = String(branch || "")
    .trim()
    .toLowerCase();

  if (!value || value === "both" || value === "all") {
    return "both";
  }

  if (
    value.includes("dalig") ||
    value.includes("mlq") ||
    value.includes("ml quezon") ||
    value === "quezon"
  ) {
    return "mlq";
  }

  if (
    value.includes("lawis") ||
    value.includes("san luis")
  ) {
    return "clawis";
  }

  throw new Error(
    `Unsupported branch "${branch}". Choose Both, Dalig, or C. Lawis.`,
  );
}

function sanitizeFilename(value) {
  return String(value || "campaign-image")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "campaign-image";
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/avif") return ".avif";

  return "";
}

async function copyCampaignImages(campaign) {
  const urls = Array.isArray(campaign.image_urls)
    ? campaign.image_urls.filter(Boolean).slice(0, 10)
    : [];

  if (urls.length === 0) {
    return [];
  }

  const paths = [];
  const uploadedPaths = [];

  try {
    for (let index = 0; index < urls.length; index += 1) {
      const url = String(urls[index] || "").trim();
      if (!url) continue;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Unable to download campaign image ${index + 1} (HTTP ${response.status}).`,
        );
      }

      const contentType =
        response.headers.get("content-type") ||
        "application/octet-stream";

      if (
        ![
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "image/avif",
        ].includes(contentType.split(";")[0].trim().toLowerCase())
      ) {
        throw new Error(
          `Campaign image ${index + 1} is not a supported image type.`,
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 45 * 1024 * 1024) {
        throw new Error(
          `Campaign image ${index + 1} exceeds the 45 MB limit.`,
        );
      }

      const extension = extensionFromContentType(contentType);
      const objectPath =
        `website-campaigns/${campaign.id}/${String(index + 1).padStart(2, "0")}-${sanitizeFilename(campaign.entity_name)}${extension}`;

      const { error } = await social.storage
        .from(storageBucket)
        .upload(objectPath, bytes, {
          contentType,
          upsert: true,
        });

      if (error) {
        throw new Error(
          `Unable to store campaign image ${index + 1}: ${error.message}`,
        );
      }

      paths.push(objectPath);
      uploadedPaths.push(objectPath);
    }

    return paths;
  } catch (error) {
    if (uploadedPaths.length > 0) {
      await social.storage
        .from(storageBucket)
        .remove(uploadedPaths)
        .catch(() => {});
    }
    throw error;
  }
}

function formatCampaign(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    batchName: row.batch_name,
    source: row.source,
    sourceFileName: row.source_file_name,
    sourceRowNumber: row.source_row_number,
    business: row.business,
    entityName: row.entity_name,
    category: row.category,
    price: row.price,
    description: row.description,
    campaignType: row.campaign_type,
    promotion: row.promotion,
    audience: row.audience,
    tone: row.tone,
    branch: row.branch,
    cta: row.cta,
    imageUrls: row.image_urls || [],
    requestedPublishAt: row.requested_publish_at,
    timezone: row.timezone,
    captionDraft: row.caption_draft,
    generatedCaption: row.generated_caption,
    editedCaption: row.edited_caption,
    status: row.status,
    aiProvider: row.ai_provider,
    aiModel: row.ai_model,
    generationAttempts: row.generation_attempts,
    cloudPostId: row.cloud_post_id,
    submittedByEmail: row.submitted_by_email,
    lastError: row.last_error,
    receivedAt: row.received_at,
    generatedAt: row.generated_at,
    approvedAt: row.approved_at,
    queuedAt: row.queued_at,
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Modifica Social Review",
    configured: dashboardConfigured(),
    socialConfigured: Boolean(social),
    authConfigured: Boolean(adminUsername && adminPassword),
  });
});

app.use("/social-review", requireDashboardAuth);
app.use(
  "/social-review",
  express.static(
    path.join(__dirname, "public", "social-review"),
    {
      extensions: ["html"],
      index: "index.html",
    },
  ),
);

app.get(
  "/api/social-campaigns",
  requireDashboardAuth,
  async (req, res) => {
    try {
      const limit = Math.min(
        Math.max(Number(req.query.limit || 100), 1),
        200,
      );

      const { data, error } = await social
        .from("social_campaigns")
        .select(
          "id,batch_id,batch_name,source,source_file_name,source_row_number,business,entity_name,category,price,description,campaign_type,promotion,audience,tone,branch,cta,image_urls,requested_publish_at,timezone,caption_draft,generated_caption,edited_caption,status,ai_provider,ai_model,generation_attempts,cloud_post_id,submitted_by_email,last_error,received_at,generated_at,approved_at,queued_at",
        )
        .order("received_at", { ascending: false })
        .limit(limit);

      if (error) {
        throw new Error(error.message);
      }

      res.json({
        success: true,
        campaigns: (data || []).map(formatCampaign),
      });
    } catch (error) {
      jsonError(
        res,
        500,
        error instanceof Error
          ? error.message
          : "Unable to load social campaigns.",
      );
    }
  },
);

app.patch(
  "/api/social-campaigns/:campaignId",
  requireDashboardAuth,
  async (req, res) => {
    try {
      const campaignId = String(req.params.campaignId || "").trim();
      const editedCaption =
        typeof req.body?.editedCaption === "string"
          ? req.body.editedCaption.trim()
          : null;
      const requestedPublishAt =
        typeof req.body?.requestedPublishAt === "string" &&
        req.body.requestedPublishAt.trim()
          ? new Date(req.body.requestedPublishAt).toISOString()
          : null;

      const payload = {
        ...(editedCaption !== null
          ? { edited_caption: editedCaption }
          : {}),
        ...(requestedPublishAt !== null
          ? { requested_publish_at: requestedPublishAt }
          : {}),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await social
        .from("social_campaigns")
        .update(payload)
        .eq("id", campaignId)
        .in("status", [
          "received",
          "processing",
          "ready_for_review",
          "failed",
        ])
        .select(
          "id,batch_id,batch_name,source,source_file_name,source_row_number,business,entity_name,category,price,description,campaign_type,promotion,audience,tone,branch,cta,image_urls,requested_publish_at,timezone,caption_draft,generated_caption,edited_caption,status,ai_provider,ai_model,generation_attempts,cloud_post_id,submitted_by_email,last_error,received_at,generated_at,approved_at,queued_at",
        )
        .maybeSingle();

      if (error) {
        throw new Error(error.message);
      }

      if (!data) {
        return jsonError(
          res,
          409,
          "This campaign can no longer be edited in its current status.",
        );
      }

      res.json({
        success: true,
        campaign: formatCampaign(data),
      });
    } catch (error) {
      jsonError(
        res,
        400,
        error instanceof Error
          ? error.message
          : "Unable to update campaign.",
      );
    }
  },
);

app.post(
  "/api/social-campaigns/:campaignId/approve",
  requireDashboardAuth,
  async (req, res) => {
    const campaignId = String(req.params.campaignId || "").trim();
    let uploadedPaths = [];

    try {
      const { data: campaign, error: campaignError } = await social
        .from("social_campaigns")
        .select("*")
        .eq("id", campaignId)
        .maybeSingle();

      if (campaignError) {
        throw new Error(campaignError.message);
      }

      if (!campaign) {
        return jsonError(res, 404, "Campaign not found.");
      }

      if (campaign.cloud_post_id) {
        return res.json({
          success: true,
          duplicate: true,
          campaign: formatCampaign(campaign),
          cloudPostId: campaign.cloud_post_id,
        });
      }

      if (
        ![
          "ready_for_review",
          "received",
          "failed",
        ].includes(campaign.status)
      ) {
        return jsonError(
          res,
          409,
          `Campaign cannot be queued from status "${campaign.status}".`,
        );
      }

      const finalCaption = String(
        req.body?.caption ||
          campaign.edited_caption ||
          campaign.generated_caption ||
          campaign.caption_draft ||
          "",
      ).trim();

      if (!finalCaption) {
        return jsonError(
          res,
          400,
          "Add or generate a caption before queueing.",
        );
      }

      const scheduleSource =
        req.body?.requestedPublishAt ||
        campaign.requested_publish_at;

      if (!scheduleSource) {
        return jsonError(
          res,
          400,
          "Set a requested publish date and time before queueing.",
        );
      }

      const publishAt = new Date(scheduleSource);
      if (Number.isNaN(publishAt.getTime())) {
        return jsonError(
          res,
          400,
          "The requested publish date/time is invalid.",
        );
      }

      if (
        publishAt.getTime() <
        Date.now() + 11 * 60 * 1000
      ) {
        return jsonError(
          res,
          400,
          "Schedule the campaign at least 11 minutes in the future so Facebook native scheduling has enough lead time.",
        );
      }

      const page = normalizePage(campaign.branch);
      const idempotencyKey =
        `social-campaign:${campaign.id}`;

      const { data: existing, error: existingError } = await social
        .from("cloud_posts")
        .select("id,status,publish_at")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (existingError) {
        throw new Error(existingError.message);
      }

      if (existing) {
        const { data: linked, error: linkError } = await social
          .from("social_campaigns")
          .update({
            edited_caption: finalCaption,
            status: "queued",
            cloud_post_id: existing.id,
            approved_at:
              campaign.approved_at || new Date().toISOString(),
            queued_at:
              campaign.queued_at || new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaign.id)
          .select("*")
          .single();

        if (linkError) {
          throw new Error(linkError.message);
        }

        return res.json({
          success: true,
          duplicate: true,
          campaign: formatCampaign(linked),
          cloudPostId: existing.id,
        });
      }

      uploadedPaths = await copyCampaignImages(campaign);

      const { data: cloudPost, error: cloudError } = await social
        .from("cloud_posts")
        .insert({
          idempotency_key: idempotencyKey,
          source_drive_id: "modifica-social-review",
          source_name:
            campaign.source_file_name ||
            campaign.entity_name,
          page,
          caption: finalCaption,
          publish_at: publishAt.toISOString(),
          image_paths: uploadedPaths,
          status: "ready",
          attempts: 0,
          max_attempts: 5,
          source_asset_id:
            campaign.entity_id || campaign.id,
        })
        .select("id,status,publish_at")
        .single();

      if (cloudError) {
        throw new Error(cloudError.message);
      }

      const now = new Date().toISOString();

      const { data: updated, error: updateError } = await social
        .from("social_campaigns")
        .update({
          edited_caption: finalCaption,
          status: "queued",
          cloud_post_id: cloudPost.id,
          approved_at:
            campaign.approved_at || now,
          queued_at: now,
          last_error: null,
          updated_at: now,
        })
        .eq("id", campaign.id)
        .select("*")
        .single();

      if (updateError) {
        throw new Error(updateError.message);
      }

      res.json({
        success: true,
        duplicate: false,
        campaign: formatCampaign(updated),
        cloudPost,
      });
    } catch (error) {
      if (uploadedPaths.length > 0 && social) {
        await social.storage
          .from(storageBucket)
          .remove(uploadedPaths)
          .catch(() => {});
      }

      if (social && campaignId) {
        await social
          .from("social_campaigns")
          .update({
            last_error:
              error instanceof Error
                ? error.message
                : "Unable to queue campaign.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaignId)
          .catch(() => {});
      }

      jsonError(
        res,
        500,
        error instanceof Error
          ? error.message
          : "Unable to queue campaign.",
      );
    }
  },
);

app.get("/", (_req, res) => {
  res.redirect("/social-review/");
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Modifica Social Review listening on port ${port}`,
  );
  console.log(
    dashboardConfigured()
      ? "Social Review configured."
      : "Social Review waiting for SUPABASE_SECRET_KEY and admin credentials.",
  );
});
