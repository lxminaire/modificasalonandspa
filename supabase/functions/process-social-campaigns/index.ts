import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const WEBSITE_URL = "https://kqumdpovvxnspnkzzvae.supabase.co";
const WEBSITE_PUBLISHABLE_KEY = "sb_publishable_yqzLXNLxK9CaTG-AnCHDAg_nnbR4upu";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProcessRequest = {
  campaignIds?: string[];
  retryFailed?: boolean;
};

type Campaign = {
  id: string;
  business: string;
  entity_name: string;
  category: string | null;
  price: string | null;
  description: string | null;
  campaign_type: string | null;
  promotion: string | null;
  audience: string | null;
  tone: string | null;
  branch: string | null;
  cta: string | null;
  requested_publish_at: string | null;
  timezone: string;
  caption_draft: string | null;
  ai_context: Record<string, unknown>;
  generation_attempts: number;
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

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function buildPrompt(campaign: Campaign) {
  const facts = {
    business: campaign.business,
    service: campaign.entity_name,
    category: campaign.category,
    price: campaign.price,
    description: campaign.description,
    campaignType: campaign.campaign_type,
    promotion: campaign.promotion,
    audience: campaign.audience,
    tone: campaign.tone,
    branch: campaign.branch,
    callToAction: campaign.cta,
    requestedPublishAt: campaign.requested_publish_at,
    timezone: campaign.timezone,
    websiteDraft: campaign.caption_draft,
    aiContext: campaign.ai_context,
  };

  return [
    "Write one Facebook caption for Modifica Salon & Spa.",
    "",
    "Rules:",
    "- Use only the facts provided below.",
    "- Never invent a price, discount, promotion, branch detail, opening hour, availability, guarantee, medical/beauty claim, or service result.",
    "- If a fact is missing, omit it instead of guessing.",
    "- Preserve an exact price or promotion only when it is explicitly provided.",
    "- Tone should be premium, warm, polished, and natural for a salon/spa brand.",
    "- Keep the body concise: roughly 60-120 words.",
    "- End with a clear booking-oriented CTA when a CTA is provided.",
    "- Add 2 to 4 relevant hashtags. Always include #ModificaSalonAndSpa.",
    "- Do not output analysis, labels, quotation marks, markdown headings, or alternatives.",
    "",
    "Campaign facts:",
    JSON.stringify(facts, null, 2),
  ].join("\n");
}

async function verifyCaller(
  authorization: string,
  serviceRoleKey: string,
) {
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();

  if (bearer && bearer === serviceRoleKey) {
    return { kind: "internal" as const, owner: null };
  }

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

  const admins = (await adminResponse.json()) as Array<{ user_id: string }>;
  if (admins.length === 0) {
    throw new Error("Owner access is required.");
  }

  return { kind: "owner" as const, owner: user };
}

async function generateCaption(
  apiKey: string,
  model: string,
  campaign: Campaign,
) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPrompt(campaign) }],
          },
        ],
        generationConfig: {
          temperature: 0.65,
          maxOutputTokens: 700,
        },
      }),
    },
  );

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
    error?: {
      message?: string;
    };
  };

  if (!response.ok) {
    throw new Error(
      payload.error?.message ||
        `Gemini request failed with HTTP ${response.status}`,
    );
  }

  const caption = (payload.candidates?.[0]?.content?.parts || [])
    .map((part) => clean(part.text))
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!caption) {
    throw new Error("Gemini returned an empty caption.");
  }

  return caption;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    const configured = Boolean(
      String(Deno.env.get("GEMINI_API_KEY") || "").trim(),
    );
    const model =
      clean(Deno.env.get("GEMINI_MODEL")) || DEFAULT_MODEL;

    return json({
      ok: true,
      service: "Modifica Social AI Processor",
      configured,
      model,
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: "Authentication required" }, 401);
  }

  const socialUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const model = clean(Deno.env.get("GEMINI_MODEL")) || DEFAULT_MODEL;

  if (!socialUrl || !serviceRoleKey) {
    return json({ error: "Modifica Social backend is not configured" }, 500);
  }

  if (!geminiApiKey) {
    return json(
      {
        error:
          "Gemini is not configured for Modifica Social. Add GEMINI_API_KEY to the project secrets.",
        model,
      },
      503,
    );
  }

  try {
    await verifyCaller(authorization, serviceRoleKey);

    const social = createClient(socialUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const body = (await req.json().catch(() => ({}))) as ProcessRequest;
    let campaignIds = Array.isArray(body.campaignIds)
      ? Array.from(new Set(body.campaignIds.map(clean).filter(Boolean))).slice(0, 20)
      : [];

    if (campaignIds.length === 0) {
      let query = social
        .from("social_campaigns")
        .select("id")
        .order("created_at", { ascending: true })
        .limit(20);

      query = body.retryFailed
        ? query.in("status", ["received", "failed"])
        : query.eq("status", "received");

      const { data, error } = await query;

      if (error) {
        throw new Error(error.message);
      }

      campaignIds = (data || []).map((row) => row.id);
    }

    const results: Array<Record<string, unknown>> = [];

    for (const campaignId of campaignIds) {
      const { data: claimedRows, error: claimError } = await social.rpc(
        "claim_social_campaign_for_processing",
        {
          p_campaign_id: campaignId,
        },
      );

      if (claimError) {
        results.push({
          campaignId,
          outcome: "failed",
          error: claimError.message,
        });
        continue;
      }

      const claimed = Array.isArray(claimedRows)
        ? (claimedRows[0] as Campaign | undefined)
        : undefined;

      if (!claimed) {
        results.push({
          campaignId,
          outcome: "skipped",
          reason: "Campaign is not in a processable state.",
        });
        continue;
      }

      try {
        const generatedCaption = await generateCaption(
          geminiApiKey,
          model,
          claimed,
        );

        const { data: updated, error: updateError } = await social
          .from("social_campaigns")
          .update({
            generated_caption: generatedCaption,
            status: "ready_for_review",
            ai_provider: "gemini",
            ai_model: model,
            processed_at: new Date().toISOString(),
            generated_at: new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaignId)
          .eq("status", "processing")
          .select(
            "id,status,generated_caption,ai_provider,ai_model,generation_attempts,generated_at",
          )
          .single();

        if (updateError) {
          throw new Error(updateError.message);
        }

        results.push({
          campaignId,
          outcome: "ready_for_review",
          status: updated.status,
          generatedCaption: updated.generated_caption,
          model: updated.ai_model,
          attempts: updated.generation_attempts,
          generatedAt: updated.generated_at,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to generate campaign caption.";

        await social
          .from("social_campaigns")
          .update({
            status: "failed",
            ai_provider: "gemini",
            ai_model: model,
            last_error: message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaignId)
          .eq("status", "processing");

        results.push({
          campaignId,
          outcome: "failed",
          error: message,
        });
      }
    }

    return json({
      model,
      submitted: campaignIds.length,
      readyForReview: results.filter(
        (item) => item.outcome === "ready_for_review",
      ).length,
      failed: results.filter((item) => item.outcome === "failed").length,
      skipped: results.filter((item) => item.outcome === "skipped").length,
      results,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to process social campaigns",
      },
      403,
    );
  }
});
