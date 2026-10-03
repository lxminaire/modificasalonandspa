const WEBSITE_URL = "https://kqumdpovvxnspnkzzvae.supabase.co";
const WEBSITE_KEY = "sb_publishable_yqzLXNLxK9CaTG-AnCHDAg_nnbR4upu";
const TOKEN_KEY = "modifica-social-owner-token";

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || "",
  campaigns: [],
  selectedId: "",
  filter: "all",
  busy: false,
};

const $ = (id) => document.getElementById(id);

const loginView = $("loginView");
const dashboardView = $("dashboardView");
const loginForm = $("loginForm");
const emailInput = $("emailInput");
const passwordInput = $("passwordInput");
const loginButton = $("loginButton");
const loginError = $("loginError");
const logoutButton = $("logoutButton");
const refreshButton = $("refreshButton");
const campaignList = $("campaignList");
const campaignDetail = $("campaignDetail");
const globalError = $("globalError");
const lastUpdated = $("lastUpdated");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setGlobalError(message = "") {
  globalError.hidden = !message;
  globalError.textContent = message;
}

async function api(path, options = {}) {
  if (!state.token) throw new Error("Sign in again.");

  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (response.status === 401 || response.status === 403) {
    if (/session|auth|owner/i.test(payload.error || "")) {
      signOut(false);
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
  }

  return payload;
}

async function signIn(email, password) {
  const response = await fetch(
    `${WEBSITE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: WEBSITE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ||
      payload.msg ||
      payload.message ||
      "Unable to sign in.",
    );
  }

  state.token = payload.access_token;
  sessionStorage.setItem(TOKEN_KEY, state.token);

  await loadCampaigns();
}

function signOut(reload = true) {
  state.token = "";
  state.campaigns = [];
  state.selectedId = "";
  sessionStorage.removeItem(TOKEN_KEY);

  if (reload) {
    window.location.reload();
    return;
  }

  dashboardView.hidden = true;
  loginView.hidden = false;
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
}

function campaignStatus(campaign) {
  return campaign.cloud_post?.status || campaign.status || "unknown";
}

function statusLabel(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function formatDateTime(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(date);
}

function toManilaLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
}

function fromManilaLocalInput(value) {
  if (!value) return "";
  const date = new Date(`${value}:00+08:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function finalCaption(campaign) {
  return (
    campaign.edited_caption ||
    campaign.generated_caption ||
    campaign.caption_draft ||
    ""
  );
}

function renderSummary() {
  const incoming = state.campaigns.filter((campaign) =>
    ["received", "processing"].includes(campaign.status)
  ).length;
  const review = state.campaigns.filter(
    (campaign) => campaign.status === "ready_for_review",
  ).length;
  const queued = state.campaigns.filter((campaign) =>
    ["queued", "scheduled"].includes(campaignStatus(campaign)),
  ).length;
  const published = state.campaigns.filter(
    (campaign) => campaignStatus(campaign) === "published",
  ).length;

  $("incomingCount").textContent = incoming;
  $("reviewCount").textContent = review;
  $("queuedCount").textContent = queued;
  $("publishedCount").textContent = published;
}

function filteredCampaigns() {
  if (state.filter === "all") return state.campaigns;

  return state.campaigns.filter((campaign) => {
    if (["scheduled", "published"].includes(state.filter)) {
      return campaignStatus(campaign) === state.filter;
    }
    return campaign.status === state.filter;
  });
}

function renderList() {
  const rows = filteredCampaigns();
  $("campaignTotal").textContent = rows.length;

  if (rows.length === 0) {
    campaignList.innerHTML =
      '<div class="empty-list">No campaigns match this filter yet.</div>';
    return;
  }

  campaignList.innerHTML = rows
    .map((campaign) => {
      const images = Array.isArray(campaign.image_urls)
        ? campaign.image_urls
        : [];
      const status = campaignStatus(campaign);
      const active = campaign.id === state.selectedId ? " active" : "";
      const imageStyle = images[0]
        ? ` style="background-image:url('${escapeHtml(images[0])}')"`
        : "";

      return `
        <button class="campaign-card${active}" data-id="${campaign.id}" type="button">
          <span class="thumb"${imageStyle}></span>
          <span>
            <span class="card-title-row">
              <span class="card-title">${escapeHtml(campaign.entity_name)}</span>
              <span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
            </span>
            <span class="card-meta">
              ${escapeHtml(campaign.campaign_type || "Campaign")} ·
              ${escapeHtml(campaign.branch || "Both")}<br />
              ${escapeHtml(formatDateTime(campaign.requested_publish_at))}
            </span>
          </span>
        </button>
      `;
    })
    .join("");

  campaignList.querySelectorAll(".campaign-card").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.id || "";
      renderList();
      renderDetail();
    });
  });
}

function renderDetail() {
  const campaign = state.campaigns.find(
    (item) => item.id === state.selectedId,
  );

  if (!campaign) {
    campaignDetail.innerHTML = `
      <div class="empty-detail">
        <div class="empty-icon">↗</div>
        <h2>Select a campaign</h2>
        <p>Campaign details, AI caption, images, schedule, and approval controls will appear here.</p>
      </div>
    `;
    return;
  }

  const images = Array.isArray(campaign.image_urls)
    ? campaign.image_urls
    : [];
  const status = campaignStatus(campaign);
  const editable = ["received", "processing", "ready_for_review", "failed", "approved"]
    .includes(campaign.status);
  const canApprove = ["received", "ready_for_review", "failed", "approved"]
    .includes(campaign.status);
  const canRetry = ["received", "failed"].includes(campaign.status);

  campaignDetail.innerHTML = `
    <div class="detail-grid">
      <div class="detail-main">
        <div class="detail-head">
          <div>
            <p class="kicker">CAMPAIGN REVIEW</p>
            <h2>${escapeHtml(campaign.entity_name)}</h2>
            <p class="detail-sub">
              ${escapeHtml(campaign.category || "Uncategorized")}
              ${campaign.price ? " · " + escapeHtml(campaign.price) : ""}
              · ${escapeHtml(campaign.campaign_type || "Campaign")}
            </p>
          </div>
          <span class="badge ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
        </div>

        ${campaign.description ? `<p class="detail-description">${escapeHtml(campaign.description)}</p>` : ""}

        ${images.length ? `
          <div class="image-grid">
            ${images.map((url) => `<img src="${escapeHtml(url)}" alt="Campaign media" />`).join("")}
          </div>
        ` : ""}

        <div class="editor-field">
          <label for="captionEditor">Final caption</label>
          <textarea id="captionEditor" ${editable ? "" : "disabled"}>${escapeHtml(finalCaption(campaign))}</textarea>
        </div>

        <p class="ai-note">
          ${campaign.generated_caption
            ? `AI generated with ${escapeHtml(campaign.ai_model || campaign.ai_provider || "configured model")} · attempt ${campaign.generation_attempts || 1}`
            : "No AI-generated caption is stored yet. You can retry AI or edit the website draft manually."}
        </p>
      </div>

      <aside class="detail-side">
        <div class="fact-grid">
          <div class="fact"><span>Audience</span><strong>${escapeHtml(campaign.audience || "General Modifica audience")}</strong></div>
          <div class="fact"><span>Tone</span><strong>${escapeHtml(campaign.tone || "—")}</strong></div>
          <div class="fact"><span>Promotion</span><strong>${escapeHtml(campaign.promotion || "None")}</strong></div>
          <div class="fact"><span>Source</span><strong>${escapeHtml(campaign.source_file_name || "Website")} ${campaign.source_row_number ? "· row " + campaign.source_row_number : ""}</strong></div>
        </div>

        <div class="editor-field">
          <label for="branchEditor">Branch</label>
          <select id="branchEditor" ${editable ? "" : "disabled"}>
            <option value="Both">Both</option>
            <option value="Dalig">Dalig</option>
            <option value="C. Lawis">C. Lawis</option>
          </select>
        </div>

        <div class="editor-field">
          <label for="scheduleEditor">Schedule · Philippine time</label>
          <input id="scheduleEditor" type="datetime-local" value="${escapeHtml(toManilaLocalInput(campaign.requested_publish_at))}" ${editable ? "" : "disabled"} />
        </div>

        ${campaign.last_error ? `<div class="status-box"><strong>Last error</strong><br />${escapeHtml(campaign.last_error)}</div>` : ""}

        ${campaign.cloud_post ? `
          <div class="status-box">
            <strong>Facebook queue</strong><br />
            ${escapeHtml(statusLabel(campaign.cloud_post.status))}<br />
            ${escapeHtml(formatDateTime(campaign.cloud_post.publish_at))}
            ${campaign.cloud_post.last_error ? "<br />" + escapeHtml(campaign.cloud_post.last_error) : ""}
          </div>
        ` : ""}

        <div class="action-stack">
          <button id="saveCampaignButton" class="button ghost" type="button" ${editable ? "" : "disabled"}>Save changes</button>
          <button id="retryAiButton" class="button ghost" type="button" ${canRetry ? "" : "disabled"}>Generate / retry AI</button>
          <button id="approveButton" class="button gold" type="button" ${canApprove ? "" : "disabled"}>Approve & queue</button>
        </div>
      </aside>
    </div>
  `;

  const branchEditor = $("branchEditor");
  if (branchEditor) {
    const branch = String(campaign.branch || "Both").toLowerCase();
    branchEditor.value = branch.includes("lawis")
      ? "C. Lawis"
      : branch.includes("dalig") || branch.includes("quezon")
        ? "Dalig"
        : "Both";
  }

  $("saveCampaignButton")?.addEventListener("click", saveSelected);
  $("retryAiButton")?.addEventListener("click", retryAi);
  $("approveButton")?.addEventListener("click", approveSelected);
}

async function loadCampaigns() {
  setGlobalError("");

  try {
    const payload = await api("/api/social/campaigns");
    state.campaigns = payload.campaigns || [];

    if (
      state.selectedId &&
      !state.campaigns.some((campaign) => campaign.id === state.selectedId)
    ) {
      state.selectedId = "";
    }

    if (!state.selectedId && state.campaigns.length > 0) {
      state.selectedId = state.campaigns[0].id;
    }

    showDashboard();
    renderSummary();
    renderList();
    renderDetail();
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString("en-PH", {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  } catch (error) {
    setGlobalError(error.message);
    throw error;
  }
}

function selectedEditorPayload() {
  const caption = $("captionEditor")?.value || "";
  const branch = $("branchEditor")?.value || "Both";
  const localSchedule = $("scheduleEditor")?.value || "";

  return {
    caption,
    branch,
    requestedPublishAt: localSchedule
      ? fromManilaLocalInput(localSchedule)
      : "",
  };
}

async function saveSelected() {
  if (!state.selectedId || state.busy) return;

  state.busy = true;
  setGlobalError("");

  try {
    await api(`/api/social/campaigns/${state.selectedId}`, {
      method: "PATCH",
      body: JSON.stringify(selectedEditorPayload()),
    });
    await loadCampaigns();
  } catch (error) {
    setGlobalError(error.message);
  } finally {
    state.busy = false;
  }
}

async function retryAi() {
  if (!state.selectedId || state.busy) return;

  state.busy = true;
  setGlobalError("");

  try {
    await saveSelected();
    await api(`/api/social/campaigns/${state.selectedId}/retry-ai`, {
      method: "POST",
      body: "{}",
    });
    await loadCampaigns();
  } catch (error) {
    setGlobalError(error.message);
  } finally {
    state.busy = false;
  }
}

async function approveSelected() {
  if (!state.selectedId || state.busy) return;

  const campaign = state.campaigns.find(
    (item) => item.id === state.selectedId,
  );
  if (!campaign) return;

  const confirmed = window.confirm(
    `Approve "${campaign.entity_name}" and create its Facebook publishing job?\n\nThis will move the campaign into cloud_posts.`,
  );
  if (!confirmed) return;

  state.busy = true;
  setGlobalError("");

  try {
    const payload = selectedEditorPayload();
    await api(`/api/social/campaigns/${state.selectedId}/approve`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadCampaigns();
  } catch (error) {
    setGlobalError(error.message);
  } finally {
    state.busy = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  loginButton.disabled = true;
  loginButton.textContent = "Signing in…";

  try {
    await signIn(emailInput.value.trim(), passwordInput.value);
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
    signOut(false);
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = "Sign in";
  }
});

logoutButton.addEventListener("click", () => signOut());
refreshButton.addEventListener("click", () => {
  loadCampaigns().catch(() => {});
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.status || "all";
    document
      .querySelectorAll(".filter")
      .forEach((item) => item.classList.toggle("active", item === button));
    renderList();
  });
});

if (state.token) {
  loadCampaigns().catch(() => {
    signOut(false);
  });
}

setInterval(() => {
  if (state.token && !state.busy) {
    loadCampaigns().catch(() => {});
  }
}, 15000);
