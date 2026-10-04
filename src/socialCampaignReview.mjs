import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import {
  cancelManagedCloudPost,
  editManagedCloudPost,
} from "./cloudQueue.mjs";

const WEBSITE_URL = "https://kqumdpovvxnspnkzzvae.supabase.co";
const WEBSITE_PUBLISHABLE_KEY =
  "sb_publishable_yqzLXNLxK9CaTG-AnCHDAg_nnbR4upu";
const SOCIAL_BUCKET = "scheduled-post-images";
const MIN_LEAD_MS = 11 * 60 * 1000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getSocialClient() {
  const url = clean(process.env.SUPABASE_URL);
  const key =
    clean(process.env.SUPABASE_SECRET_KEY) ||
    clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url || !key) {
    throw new Error(
      "Modifica Social database is not configured on this service.",
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function isSocialReviewConfigured() {
  return Boolean(
    clean(process.env.SUPABASE_URL) &&
      (clean(process.env.SUPABASE_SECRET_KEY) ||
        clean(process.env.SUPABASE_SERVICE_ROLE_KEY)),
  );
}

export async function verifyWebsiteOwner(authorization) {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Authentication required.");
  }

  const userResponse = await fetch(`${WEBSITE_URL}/auth/v1/user`, {
    headers: {
      apikey: WEBSITE_PUBLISHABLE_KEY,
      Authorization: authorization,
    },
  });

  if (!userResponse.ok) {
    throw new Error("Your Modifica owner session is invalid or expired.");
  }

  const user = await userResponse.json();
  if (!user?.id) {
    throw new Error("Unable to resolve the signed-in owner.");
  }

  const adminResponse = await fetch(
    `${WEBSITE_URL}/rest/v1/site_admins?select=user_id&user_id=eq.${encodeURIComponent(
      user.id,
    )}&limit=1`,
    {
      headers: {
        apikey: WEBSITE_PUBLISHABLE_KEY,
        Authorization: authorization,
      },
    },
  );

  if (!adminResponse.ok) {
    throw new Error("Unable to verify Modifica owner access.");
  }

  const admins = await adminResponse.json();
  if (!Array.isArray(admins) || admins.length === 0) {
    throw new Error("Owner access is required.");
  }

  return {
    id: user.id,
    email: user.email || "",
  };
}

function normalizePage(value) {
  const normalized = clean(value).toLowerCase();

  if (
    !normalized ||
    normalized === "both" ||
    normalized === "all" ||
    normalized === "all branches"
  ) {
    return "both";
  }

  if (
    normalized.includes("dalig") ||
    normalized.includes("mlq") ||
    normalized.includes("ml quezon") ||
    normalized === "quezon"
  ) {
    return "mlq";
  }

  if (
    normalized.includes("lawis") ||
    normalized.includes("san luis") ||
    normalized.includes("c. lawis") ||
    normalized.includes("c lawis")
  ) {
    return "clawis";
  }

  throw new Error("Branch must be Both, Dalig, or C. Lawis.");
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";

  throw new Error(
    `Unsupported campaign image type: ${normalized || "unknown"}`,
  );
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function listSocialCampaigns(status = "all") {
  const social = getSocialClient();

  let query = social
    .from("social_campaigns")
    .select(
      [
        "id",
        "batch_id",
        "batch_name",
        "source_file_name",
        "source_row_number",
        "business",
        "entity_id",
        "entity_name",
        "category",
        "price",
        "description",
        "campaign_type",
        "promotion",
        "audience",
        "tone",
        "branch",
        "cta",
        "image_urls",
        "requested_publish_at",
        "timezone",
        "caption_draft",
        "generated_caption",
        "edited_caption",
        "status",
        "cloud_post_id",
        "submitted_by_email",
        "last_error",
        "received_at",
        "processed_at",
        "generated_at",
        "approved_at",
        "queued_at",
        "created_at",
        "updated_at",
        "ai_provider",
        "ai_model",
        "generation_attempts",
      ].join(","),
    )
    .order("created_at", { ascending: false })
    .limit(100);

  const normalizedStatus = clean(status);
  if (normalizedStatus && normalizedStatus !== "all") {
    query = query.eq("status", normalizedStatus);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const campaigns = data || [];
  const cloudIds = campaigns
    .map((campaign) => campaign.cloud_post_id)
    .filter(Boolean);

  const cloudById = new Map();

  if (cloudIds.length > 0) {
    const { data: cloudRows, error: cloudError } = await social
      .from("cloud_posts")
      .select(
        "id,status,publish_at,last_error,facebook_post_ids,published_at,updated_at",
      )
      .in("id", cloudIds);

    if (cloudError) throw new Error(cloudError.message);

    for (const row of cloudRows || []) {
      cloudById.set(row.id, row);
    }
  }

  const enriched = campaigns.map((campaign) => ({
    ...campaign,
    cloud_post: campaign.cloud_post_id
      ? cloudById.get(campaign.cloud_post_id) || null
      : null,
  }));

  const counts = enriched.reduce((acc, item) => {
    const key = item.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    campaigns: enriched,
    counts,
  };
}

export async function updateSocialCampaign(campaignId, updates = {}) {
  const social = getSocialClient();
  const payload = {
    updated_at: new Date().toISOString(),
  };

  if (typeof updates.caption === "string") {
    payload.edited_caption = clean(updates.caption) || null;
  }

  if (typeof updates.branch === "string") {
    normalizePage(updates.branch);
    payload.branch = clean(updates.branch);
  }

  if (typeof updates.requestedPublishAt === "string") {
    const value = clean(updates.requestedPublishAt);

    if (!value) {
      payload.requested_publish_at = null;
    } else {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("Invalid requested publish time.");
      }
      payload.requested_publish_at = parsed.toISOString();
    }
  }

  const { data, error } = await social
    .from("social_campaigns")
    .update(payload)
    .eq("id", campaignId)
    .in("status", [
      "received",
      "processing",
      "ready_for_review",
      "failed",
      "approved",
    ])
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Campaign is no longer editable in its current status.");
  }

  return data;
}

export async function editScheduledSocialCampaign(
  campaignId,
  updates = {},
) {
  const social = getSocialClient();

  const { data: campaign, error: campaignError } = await social
    .from("social_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (campaignError) throw new Error(campaignError.message);
  if (!campaign) throw new Error("Campaign not found.");
  if (!campaign.cloud_post_id) {
    throw new Error("This campaign has not been queued yet.");
  }

  const caption =
    clean(updates.caption) ||
    clean(campaign.edited_caption) ||
    clean(campaign.generated_caption) ||
    clean(campaign.caption_draft);

  if (!caption) {
    throw new Error("Caption cannot be empty.");
  }

  const publishAt = new Date(
    clean(updates.publishAt) ||
      clean(campaign.requested_publish_at),
  );

  if (Number.isNaN(publishAt.getTime())) {
    throw new Error("A valid scheduled publish time is required.");
  }

  const cloudPost = await editManagedCloudPost({
    id: campaign.cloud_post_id,
    caption,
    publishAt: publishAt.toISOString(),
  });

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await social
    .from("social_campaigns")
    .update({
      edited_caption: caption,
      requested_publish_at: cloudPost.publish_at,
      status: "queued",
      last_error: null,
      updated_at: now,
    })
    .eq("id", campaign.id)
    .select("*")
    .single();

  if (updateError) throw new Error(updateError.message);

  return {
    campaign: updated,
    cloudPost,
  };
}

export async function deleteScheduledSocialCampaign(campaignId) {
  const social = getSocialClient();

  const { data: campaign, error: campaignError } = await social
    .from("social_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (campaignError) throw new Error(campaignError.message);
  if (!campaign) throw new Error("Campaign not found.");
  if (!campaign.cloud_post_id) {
    throw new Error("This campaign has not been queued yet.");
  }

  const cloudPost = await cancelManagedCloudPost(
    campaign.cloud_post_id,
  );

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await social
    .from("social_campaigns")
    .update({
      status: "cancelled",
      last_error: null,
      updated_at: now,
    })
    .eq("id", campaign.id)
    .select("*")
    .single();

  if (updateError) throw new Error(updateError.message);

  return {
    campaign: updated,
    cloudPost,
  };
}

export async function retrySocialCampaignAi(campaignId, authorization) {
  const url = clean(process.env.SUPABASE_URL);
  if (!url) {
    throw new Error("Modifica Social URL is not configured.");
  }

  const response = await fetch(
    `${url}/functions/v1/process-social-campaigns`,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        campaignIds: [campaignId],
        retryFailed: true,
      }),
    },
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload?.error || "Unable to start AI caption processing.",
    );
  }

  return payload;
}

export async function approveSocialCampaign(
  campaignId,
  overrides = {},
) {
  const social = getSocialClient();

  const { data: campaign, error: campaignError } = await social
    .from("social_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (campaignError) throw new Error(campaignError.message);
  if (!campaign) throw new Error("Campaign not found.");

  if (campaign.status === "queued" && campaign.cloud_post_id) {
    return {
      outcome: "already_queued",
      campaignId,
      cloudPostId: campaign.cloud_post_id,
    };
  }

  if (
    !["received", "ready_for_review", "failed", "approved"].includes(
      campaign.status,
    )
  ) {
    throw new Error(
      `Campaign cannot be approved from status ${campaign.status}.`,
    );
  }

  const finalCaption =
    clean(overrides.caption) ||
    clean(campaign.edited_caption) ||
    clean(campaign.generated_caption) ||
    clean(campaign.caption_draft);

  if (!finalCaption) {
    throw new Error("A final caption is required before approval.");
  }

  const publishAt = overrides.requestedPublishAt
    ? new Date(overrides.requestedPublishAt)
    : campaign.requested_publish_at
      ? new Date(campaign.requested_publish_at)
      : null;

  if (!publishAt || Number.isNaN(publishAt.getTime())) {
    throw new Error("A valid publish date and time is required.");
  }

  if (publishAt.getTime() < Date.now() + MIN_LEAD_MS) {
    throw new Error(
      "Facebook scheduling requires at least 11 minutes of lead time.",
    );
  }

  const branch = clean(overrides.branch) || clean(campaign.branch);
  const page = normalizePage(branch);

  const imageUrls = Array.isArray(campaign.image_urls)
    ? campaign.image_urls.map(clean).filter(Boolean).slice(0, 10)
    : [];

  if (imageUrls.length === 0) {
    throw new Error("At least one campaign image is required.");
  }

  const idempotencyKey = `social-campaign:${campaign.id}`;

  const { data: existing, error: existingError } = await social
    .from("cloud_posts")
    .select("id,status")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);

  if (existing) {
    await social
      .from("social_campaigns")
      .update({
        status: "queued",
        cloud_post_id: existing.id,
        edited_caption: finalCaption,
        branch,
        requested_publish_at: publishAt.toISOString(),
        approved_at: campaign.approved_at || new Date().toISOString(),
        queued_at: campaign.queued_at || new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);

    return {
      outcome: "already_queued",
      campaignId: campaign.id,
      cloudPostId: existing.id,
      cloudPostStatus: existing.status,
    };
  }

  const uploadedPaths = [];

  try {
    for (let index = 0; index < imageUrls.length; index += 1) {
      const imageUrl = imageUrls[index];
      const response = await fetch(imageUrl);

      if (!response.ok) {
        throw new Error(
          `Could not download image ${index + 1}: HTTP ${response.status}`,
        );
      }

      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
      const extension = extensionFromContentType(contentType);
      const bytes = new Uint8Array(await response.arrayBuffer());

      if (bytes.byteLength === 0) {
        throw new Error(`Image ${index + 1} is empty.`);
      }

      if (bytes.byteLength > 45 * 1024 * 1024) {
        throw new Error(`Image ${index + 1} exceeds the 45 MB limit.`);
      }

      const fingerprint = sha256(
        `${campaign.id}:${index}:${imageUrl}`,
      );
      const path =
        `owner-review/${campaign.id}/${index + 1}-${fingerprint.slice(
          0,
          16,
        )}.${extension}`;

      const { error: uploadError } = await social.storage
        .from(SOCIAL_BUCKET)
        .upload(path, bytes, {
          contentType,
          upsert: false,
        });

      if (
        uploadError &&
        !/already exists|duplicate/i.test(uploadError.message)
      ) {
        throw new Error(uploadError.message);
      }

      uploadedPaths.push(path);
    }

    const now = new Date().toISOString();

    const { error: approvedError } = await social
      .from("social_campaigns")
      .update({
        status: "approved",
        edited_caption: finalCaption,
        branch,
        requested_publish_at: publishAt.toISOString(),
        approved_at: campaign.approved_at || now,
        last_error: null,
        updated_at: now,
      })
      .eq("id", campaign.id);

    if (approvedError) throw new Error(approvedError.message);

    const { data: cloudPost, error: cloudError } = await social
      .from("cloud_posts")
      .insert({
        idempotency_key: idempotencyKey,
        source_drive_id: "modifica-social-review",
        source_name: campaign.source_file_name
          ? `${campaign.source_file_name} · row ${campaign.source_row_number || "?"} · ${campaign.entity_name}`
          : `Modifica Social · ${campaign.entity_name}`,
        page,
        caption: finalCaption,
        publish_at: publishAt.toISOString(),
        image_paths: uploadedPaths,
        status: "ready",
        attempts: 0,
        max_attempts: 5,
        source_asset_id: campaign.entity_id || campaign.id,
      })
      .select("id,status,publish_at")
      .single();

    if (cloudError) throw new Error(cloudError.message);

    const { error: linkError } = await social
      .from("social_campaigns")
      .update({
        status: "queued",
        cloud_post_id: cloudPost.id,
        queued_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);

    if (linkError) throw new Error(linkError.message);

    return {
      outcome: "queued",
      campaignId: campaign.id,
      cloudPostId: cloudPost.id,
      cloudPostStatus: cloudPost.status,
      publishAt: cloudPost.publish_at,
    };
  } catch (error) {
    if (uploadedPaths.length > 0) {
      await social.storage
        .from(SOCIAL_BUCKET)
        .remove(uploadedPaths)
        .catch(() => {});
    }

    const message =
      error instanceof Error ? error.message : String(error);

    await social
      .from("social_campaigns")
      .update({
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id)
      .is("cloud_post_id", null);

    throw error;
  }
}
