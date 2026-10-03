const state = {
  campaigns: [],
  selectedId: null,
};

const campaignList = document.getElementById("campaignList");
const statusFilter = document.getElementById("statusFilter");
const refreshButton = document.getElementById("refreshButton");
const emptyReview = document.getElementById("emptyReview");
const reviewContent = document.getElementById("reviewContent");
const reviewTitle = document.getElementById("reviewTitle");
const reviewSource = document.getElementById("reviewSource");
const reviewMeta = document.getElementById("reviewMeta");
const reviewStatus = document.getElementById("reviewStatus");
const reviewAudience = document.getElementById("reviewAudience");
const reviewTone = document.getElementById("reviewTone");
const reviewBranch = document.getElementById("reviewBranch");
const reviewSchedule = document.getElementById("reviewSchedule");
const reviewDescription = document.getElementById("reviewDescription");
const imageGrid = document.getElementById("imageGrid");
const captionInput = document.getElementById("captionInput");
const captionHint = document.getElementById("captionHint");
const scheduleInput = document.getElementById("scheduleInput");
const saveButton = document.getElementById("saveButton");
const approveButton = document.getElementById("approveButton");
const reviewError = document.getElementById("reviewError");
const reviewSuccess = document.getElementById("reviewSuccess");
const technicalPayload = document.getElementById("technicalPayload");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status) {
  return String(status || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid schedule";

  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const parsed = new Date(`${value}:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function showMessage(target, message) {
  reviewError.hidden = true;
  reviewSuccess.hidden = true;
  if (!message) return;
  target.textContent = message;
  target.hidden = false;
}

function selectedCampaign() {
  return state.campaigns.find((item) => item.id === state.selectedId) || null;
}

function updateStats() {
  const count = (statuses) =>
    state.campaigns.filter((item) => statuses.includes(item.status)).length;

  document.getElementById("incomingCount").textContent =
    count(["received", "processing", "failed"]);
  document.getElementById("reviewCount").textContent =
    count(["ready_for_review"]);
  document.getElementById("queuedCount").textContent =
    count(["queued", "scheduled"]);
  document.getElementById("publishedCount").textContent =
    count(["published"]);
}

function renderCampaignList() {
  const filter = statusFilter.value;
  const visible = state.campaigns.filter(
    (campaign) => filter === "all" || campaign.status === filter,
  );

  if (visible.length === 0) {
    campaignList.innerHTML =
      '<div class="empty-state">No campaigns match this filter.</div>';
    return;
  }

  campaignList.innerHTML = visible
    .map((campaign) => {
      const active = campaign.id === state.selectedId ? " active" : "";
      const source = campaign.sourceFileName
        ? `${campaign.sourceFileName}${campaign.sourceRowNumber ? ` · row ${campaign.sourceRowNumber}` : ""}`
        : "Website intake";
      const image = campaign.imageUrls?.[0]
        ? `<div class="campaign-thumb" style="background-image:url('${escapeHtml(campaign.imageUrls[0])}')"></div>`
        : '<div class="campaign-thumb placeholder">M</div>';

      return `
        <button class="campaign-card${active}" data-campaign-id="${escapeHtml(campaign.id)}" type="button">
          ${image}
          <div class="campaign-card-copy">
            <div class="campaign-card-top">
              <strong>${escapeHtml(campaign.entityName)}</strong>
              <span class="mini-status status-${escapeHtml(campaign.status)}">${escapeHtml(statusLabel(campaign.status))}</span>
            </div>
            <span>${escapeHtml(campaign.promotion || campaign.campaignType || "Campaign")}</span>
            <small>${escapeHtml(source)} · ${escapeHtml(formatDateTime(campaign.requestedPublishAt))}</small>
          </div>
        </button>
      `;
    })
    .join("");

  campaignList.querySelectorAll("[data-campaign-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.campaignId;
      renderCampaignList();
      renderReview();
    });
  });
}

function renderReview() {
  const campaign = selectedCampaign();

  if (!campaign) {
    emptyReview.hidden = false;
    reviewContent.hidden = true;
    return;
  }

  emptyReview.hidden = true;
  reviewContent.hidden = false;
  showMessage(reviewError, "");
  showMessage(reviewSuccess, "");

  reviewTitle.textContent = campaign.entityName || "Campaign";
  reviewSource.textContent = campaign.sourceFileName
    ? `${campaign.sourceFileName}${campaign.sourceRowNumber ? ` · row ${campaign.sourceRowNumber}` : ""}`
    : "WEBSITE CAMPAIGN";
  reviewMeta.textContent = [
    campaign.category,
    campaign.price,
    campaign.promotion,
  ]
    .filter(Boolean)
    .join(" · ");
  reviewStatus.textContent = statusLabel(campaign.status);
  reviewStatus.className = `status-badge status-${campaign.status}`;
  reviewAudience.textContent = campaign.audience || "General Modifica audience";
  reviewTone.textContent = campaign.tone || "—";
  reviewBranch.textContent = campaign.branch || "Both";
  reviewSchedule.textContent = formatDateTime(campaign.requestedPublishAt);
  reviewDescription.textContent =
    campaign.description || "No additional service description was supplied.";

  imageGrid.innerHTML = (campaign.imageUrls || [])
    .map(
      (url, index) => `
        <figure>
          <img src="${escapeHtml(url)}" alt="Campaign image ${index + 1}" />
        </figure>
      `,
    )
    .join("");

  if (!imageGrid.innerHTML) {
    imageGrid.innerHTML =
      '<div class="image-empty">No campaign images supplied.</div>';
  }

  const caption =
    campaign.editedCaption ||
    campaign.generatedCaption ||
    campaign.captionDraft ||
    "";
  captionInput.value = caption;

  captionHint.textContent = campaign.generatedCaption
    ? `AI-generated with ${campaign.aiModel || campaign.aiProvider || "Modifica Social AI"} · edit before approval if needed.`
    : campaign.captionDraft
      ? "Showing the website draft because an AI caption is not available yet."
      : "No caption is available yet.";

  scheduleInput.value = toLocalInput(campaign.requestedPublishAt);

  const locked = ["queued", "scheduled", "published"].includes(campaign.status);
  captionInput.disabled = locked;
  scheduleInput.disabled = locked;
  saveButton.disabled = locked;
  approveButton.disabled = locked;
  approveButton.textContent = locked
    ? campaign.status === "published"
      ? "Published"
      : campaign.status === "scheduled"
        ? "Facebook Scheduled"
        : "Already Queued"
    : "Approve & Queue";

  technicalPayload.textContent = JSON.stringify(campaign, null, 2);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed with HTTP ${response.status}`);
  }

  return data;
}

async function loadCampaigns({ preserveSelection = true } = {}) {
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing…";

  try {
    const data = await api("/api/social-campaigns?limit=150");
    state.campaigns = data.campaigns || [];
    updateStats();

    if (
      !preserveSelection ||
      !state.campaigns.some((item) => item.id === state.selectedId)
    ) {
      const preferred =
        state.campaigns.find((item) => item.status === "ready_for_review") ||
        state.campaigns.find((item) => item.status === "received") ||
        state.campaigns[0];
      state.selectedId = preferred?.id || null;
    }

    renderCampaignList();
    renderReview();
  } catch (error) {
    campaignList.innerHTML =
      `<div class="empty-state error-text">${escapeHtml(error.message)}</div>`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh";
  }
}

async function saveSelected() {
  const campaign = selectedCampaign();
  if (!campaign) return;

  saveButton.disabled = true;
  showMessage(reviewError, "");
  showMessage(reviewSuccess, "");

  try {
    const requestedPublishAt = fromLocalInput(scheduleInput.value);
    if (scheduleInput.value && !requestedPublishAt) {
      throw new Error("The selected schedule could not be parsed.");
    }

    const data = await api(
      `/api/social-campaigns/${encodeURIComponent(campaign.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          editedCaption: captionInput.value,
          requestedPublishAt,
        }),
      },
    );

    state.campaigns = state.campaigns.map((item) =>
      item.id === data.campaign.id ? data.campaign : item,
    );
    renderCampaignList();
    renderReview();
    showMessage(reviewSuccess, "Campaign changes saved.");
  } catch (error) {
    showMessage(reviewError, error.message);
  } finally {
    saveButton.disabled = false;
  }
}

async function approveSelected() {
  const campaign = selectedCampaign();
  if (!campaign) return;

  approveButton.disabled = true;
  saveButton.disabled = true;
  showMessage(reviewError, "");
  showMessage(reviewSuccess, "");

  try {
    const requestedPublishAt = fromLocalInput(scheduleInput.value);
    if (!requestedPublishAt) {
      throw new Error("Choose a valid publish schedule before queueing.");
    }

    const data = await api(
      `/api/social-campaigns/${encodeURIComponent(campaign.id)}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          caption: captionInput.value,
          requestedPublishAt,
        }),
      },
    );

    state.campaigns = state.campaigns.map((item) =>
      item.id === data.campaign.id ? data.campaign : item,
    );
    updateStats();
    renderCampaignList();
    renderReview();

    showMessage(
      reviewSuccess,
      data.duplicate
        ? "Campaign was already connected to the Facebook queue."
        : "Approved and added to the Facebook publishing queue.",
    );
  } catch (error) {
    showMessage(reviewError, error.message);
    approveButton.disabled = false;
    saveButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => loadCampaigns());
statusFilter.addEventListener("change", renderCampaignList);
saveButton.addEventListener("click", saveSelected);
approveButton.addEventListener("click", approveSelected);

loadCampaigns({ preserveSelection: false });
setInterval(() => loadCampaigns(), 30000);
