import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const WEBSITE_URL = "https://kqumdpovvxnspnkzzvae.supabase.co";
const WEBSITE_PUBLISHABLE_KEY = "sb_publishable_yqzLXNLxK9CaTG-AnCHDAg_nnbR4upu";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type CampaignPayload = {
  id?: string;
  caption?: string;
  source?: {
    fileName?: string;
    sheetName?: string;
    rowNumber?: number;
  };
  business?: string;
  campaignType?: string;
  service?: {
    id?: string | null;
    name?: string;
    category?: string;
    price?: string;
    description?: string;
    image?: string;
  };
  promotion?: string;
  audience?: string;
  tone?: string;
  branch?: string;
  cta?: string;
  images?: string[];
  schedule?: {
    date?: string;
    time?: string;
    timezone?: string;
  };
  aiContext?: Record<string, unknown>;
};

type IntakeRequest = {
  campaigns?: CampaignPayload[];
  batchName?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeImages(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => clean(item))
    .filter(Boolean)
    .slice(0, 10);
}

function parseRequestedPublishAt(campaign: CampaignPayload) {
  const date = clean(campaign.schedule?.date);
  const time = clean(campaign.schedule?.time);

  if (!date && !time) return null;
  if (!date || !time) {
    throw new Error("Schedule date and time must be supplied together.");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid schedule date: ${date}`);
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid schedule time: ${time}`);
  }

  const timezone = clean(campaign.schedule?.timezone) || "Asia/Manila";
  if (timezone !== "Asia/Manila") {
    throw new Error("This intake currently expects Asia/Manila schedules.");
  }

  const parsed = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid requested publish time.");
  }

  return parsed.toISOString();
}

async function verifyWebsiteOwner(authorization: string) {
  const userResponse = await fetch(`${WEBSITE_URL}/auth/v1/user`, {
    headers: {
      apikey: WEBSITE_PUBLISHABLE_KEY,
      Authorization: authorization,
    },
  });

  if (!userResponse.ok) {
    throw new Error("Invalid Modifica owner session.");
  }

  const user = (await userResponse.json()) as {
    id?: string;
    email?: string;
  };

  if (!user.id) {
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

  const rows = (await adminResponse.json()) as { user_id: string }[];
  if (rows.length === 0) {
    throw new Error("Owner access is required.");
  }

  return user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: "Authentication required" }, 401);
  }

  try {
    const owner = await verifyWebsiteOwner(authorization);

    const socialUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!socialUrl || !serviceRoleKey) {
      return json({ error: "Modifica Social backend is not configured" }, 500);
    }

    const social = createClient(socialUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const body = (await req.json()) as IntakeRequest;
    const campaigns = Array.isArray(body.campaigns) ? body.campaigns : [];

    if (campaigns.length === 0) {
      return json({ error: "No campaigns were submitted" }, 400);
    }

    if (campaigns.length > 100) {
      return json({ error: "Submit at most 100 campaigns per batch" }, 400);
    }

    const batchId = crypto.randomUUID();
    const batchName = clean(body.batchName) || "Modifica website import";
    const results: Array<Record<string, unknown>> = [];

    for (let index = 0; index < campaigns.length; index += 1) {
      const campaign = campaigns[index];

      try {
        const entityName = clean(campaign.service?.name);
        if (!entityName) {
          throw new Error("Service name is required.");
        }

        const images = normalizeImages(campaign.images);
        const requestedPublishAt = parseRequestedPublishAt(campaign);

        const fingerprint = await sha256(
          JSON.stringify({
            source: campaign.source || {},
            serviceId: campaign.service?.id || null,
            serviceName: entityName,
            campaignType: clean(campaign.campaignType),
            promotion: clean(campaign.promotion),
            branch: clean(campaign.branch),
            caption: clean(campaign.caption),
            requestedPublishAt,
            images,
          }),
        );

        const idempotencyKey = `modifica-website:${fingerprint}`;

        const { data: existing, error: existingError } = await social
          .from("social_campaigns")
          .select("id,status,received_at")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();

        if (existingError) {
          throw new Error(existingError.message);
        }

        if (existing) {
          results.push({
            index,
            rowNumber: campaign.source?.rowNumber,
            outcome: "duplicate",
            campaignId: existing.id,
            status: existing.status,
            receivedAt: existing.received_at,
          });
          continue;
        }

        const row = {
          batch_id: batchId,
          batch_name: batchName,
          idempotency_key: idempotencyKey,
          source: "modifica-website",
          source_file_name: clean(campaign.source?.fileName) || null,
          source_sheet_name: clean(campaign.source?.sheetName) || null,
          source_row_number:
            Number.isInteger(campaign.source?.rowNumber)
              ? campaign.source?.rowNumber
              : null,
          business: clean(campaign.business) || "Modifica Salon & Spa",
          entity_type: "service",
          entity_id: clean(campaign.service?.id) || null,
          entity_name: entityName,
          category: clean(campaign.service?.category) || null,
          price: clean(campaign.service?.price) || null,
          description: clean(campaign.service?.description) || null,
          campaign_type: clean(campaign.campaignType) || null,
          promotion: clean(campaign.promotion) || null,
          audience: clean(campaign.audience) || null,
          tone: clean(campaign.tone) || null,
          branch: clean(campaign.branch) || null,
          cta: clean(campaign.cta) || null,
          image_urls: images,
          requested_publish_at: requestedPublishAt,
          timezone: clean(campaign.schedule?.timezone) || "Asia/Manila",
          caption_draft: clean(campaign.caption) || null,
          ai_context:
            campaign.aiContext && typeof campaign.aiContext === "object"
              ? campaign.aiContext
              : {},
          raw_payload: campaign,
          status: "received",
          submitted_by_user_id: owner.id,
          submitted_by_email: owner.email || null,
        };

        const { data: inserted, error: insertError } = await social
          .from("social_campaigns")
          .insert(row)
          .select("id,status,received_at,requested_publish_at")
          .single();

        if (insertError) {
          throw new Error(insertError.message);
        }

        results.push({
          index,
          rowNumber: campaign.source?.rowNumber,
          outcome: "received",
          campaignId: inserted.id,
          status: inserted.status,
          receivedAt: inserted.received_at,
          requestedPublishAt: inserted.requested_publish_at,
        });
      } catch (error) {
        results.push({
          index,
          rowNumber: campaign.source?.rowNumber,
          outcome: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Unable to receive campaign",
        });
      }
    }

    const received = results.filter(
      (item) => item.outcome === "received",
    ).length;
    const duplicates = results.filter(
      (item) => item.outcome === "duplicate",
    ).length;
    const failed = results.filter(
      (item) => item.outcome === "failed",
    ).length;

    const receivedCampaignIds = results
      .filter((item) => item.outcome === "received")
      .map((item) => String(item.campaignId || ""))
      .filter(Boolean);

    const geminiConfigured = Boolean(
      String(Deno.env.get("GEMINI_API_KEY") || "").trim(),
    );

    if (geminiConfigured && receivedCampaignIds.length > 0) {
      const processUrl =
        `${socialUrl}/functions/v1/process-social-campaigns`;

      EdgeRuntime.waitUntil(
        fetch(processUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            campaignIds: receivedCampaignIds,
          }),
        }).catch((error) => {
          console.error("Unable to start AI campaign processing:", error);
        }),
      );
    }

    return json({
      batchId,
      batchName,
      owner: owner.email || owner.id,
      submitted: campaigns.length,
      received,
      duplicates,
      failed,
      aiProcessing: {
        configured: geminiConfigured,
        started: geminiConfigured && receivedCampaignIds.length > 0,
        campaignCount: receivedCampaignIds.length,
      },
      results,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to receive campaigns",
      },
      403,
    );
  }
});
