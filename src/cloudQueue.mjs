import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).trim();

const SUPABASE_SECRET_KEY = String(
  process.env.SUPABASE_SECRET_KEY || ""
).trim();

const STORAGE_BUCKET = String(
  process.env.SUPABASE_STORAGE_BUCKET ||
    "scheduled-post-images"
).trim();

const UPLOAD_BUCKET = String(
  process.env.SUPABASE_UPLOAD_BUCKET ||
    "upload-inbox"
).trim();

const APP_ROLE = String(
  process.env.APP_ROLE || "preparer"
)
  .trim()
  .toLowerCase();

const FACEBOOK_GRAPH_VERSION = "v26.0";
const FACEBOOK_TIMEOUT_MS = 60 * 1000;
const FACEBOOK_VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
const PUBLISH_RETRY_DELAY_MS = 2 * 60 * 1000;
const PUBLISH_STALE_MS = 5 * 60 * 1000;

let supabaseClient = null;
let publisherRunning = false;

export function isCloudQueueConfigured() {
  return Boolean(
    SUPABASE_URL &&
      SUPABASE_SECRET_KEY
  );
}

export function getAppRole() {
  return APP_ROLE;
}

export function shouldRunCloudPublisher() {
  return (
    APP_ROLE === "publisher" &&
    isCloudQueueConfigured()
  );
}

function getSupabase() {
  if (!isCloudQueueConfigured()) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY."
    );
  }

  if (!supabaseClient) {
    supabaseClient = createClient(
      SUPABASE_URL,
      SUPABASE_SECRET_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );
  }

  return supabaseClient;
}


function validateUploadPage(page) {
  if (
    ![
      "mlq",
      "clawis",
      "both",
    ].includes(page)
  ) {
    throw new Error(
      "Invalid Facebook Page selection."
    );
  }

  return page;
}

function validatePostingTime(
  postingTime
) {
  const clean =
    String(
      postingTime || ""
    ).trim();

  if (
    !/^([01]\d|2[0-3]):([0-5]\d)$/.test(
      clean
    )
  ) {
    throw new Error(
      "Posting time must be HH:MM."
    );
  }

  return clean;
}

function validateUploadFileMeta(
  file
) {
  const name =
    String(
      file?.name ||
      ""
    ).trim();

  const type =
    String(
      file?.type ||
      ""
    )
      .trim()
      .toLowerCase();

  const size =
    Number(
      file?.size ||
      0
    );

  const allowedTypes =
    new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
    ]);

  if (!name) {
    throw new Error(
      "Every upload needs a file name."
    );
  }

  if (
    !allowedTypes.has(type)
  ) {
    throw new Error(
      `${name}: only JPG, PNG, WEBP, and MP4 files are supported.`
    );
  }

  const maxBytes =
    45 * 1024 * 1024;

  if (
    !Number.isFinite(size) ||
    size <= 0
  ) {
    throw new Error(
      `${name}: file size is invalid.`
    );
  }

  if (size > maxBytes) {
    throw new Error(
      `${name}: files must be 45 MB or smaller on the free upload path.`
    );
  }

  return {
    name,
    type,
    size,
  };
}

export async function createUploadJobs({
  files,
  page,
  postingTime,
}) {
  const supabase =
    getSupabase();

  const cleanPage =
    validateUploadPage(
      page
    );

  const cleanPostingTime =
    validatePostingTime(
      postingTime
    );

  const cleanFiles =
    (files || []).map(
      validateUploadFileMeta
    );

  if (
    cleanFiles.length === 0
  ) {
    throw new Error(
      "Choose at least one file to upload."
    );
  }

  if (
    cleanFiles.length > 100
  ) {
    throw new Error(
      "Upload at most 100 files in one batch."
    );
  }

  const batchId =
    crypto.randomUUID();

  const jobs = [];

  for (
    const file of
    cleanFiles
  ) {
    const id =
      crypto.randomUUID();

    const storagePath =
      `${batchId}/${id}-${sanitizeFilename(
        file.name
      )}`;

    const now =
      new Date().toISOString();

    const {
      error: insertError,
    } =
      await supabase
        .from(
          "upload_jobs"
        )
        .insert({
          id,
          batch_id:
            batchId,
          storage_path:
            storagePath,
          original_name:
            file.name,
          mime_type:
            file.type,
          file_size:
            file.size,
          page:
            cleanPage,
          posting_time:
            cleanPostingTime,
          status:
            "uploading",
          updated_at:
            now,
        });

    if (insertError) {
      throw new Error(
        `Unable to create upload job for ${file.name}: ${insertError.message}`
      );
    }

    const {
      data: signed,
      error: signedError,
    } =
      await supabase
        .storage
        .from(
          UPLOAD_BUCKET
        )
        .createSignedUploadUrl(
          storagePath
        );

    if (
      signedError ||
      !signed?.signedUrl
    ) {
      await supabase
        .from(
          "upload_jobs"
        )
        .update({
          status:
            "failed",
          last_error:
            signedError?.message ||
            "Unable to create signed upload URL.",
          updated_at:
            new Date()
              .toISOString(),
        })
        .eq(
          "id",
          id
        );

      throw new Error(
        `Unable to prepare upload for ${file.name}: ${
          signedError?.message ||
          "signed URL was not returned"
        }`
      );
    }

    jobs.push({
      id,
      batchId,
      storagePath,
      originalName:
        file.name,
      mimeType:
        file.type,
      fileSize:
        file.size,
      signedUrl:
        signed.signedUrl,
      token:
        signed.token ||
        null,
    });
  }

  return {
    batchId,
    jobs,
  };
}

export async function markUploadJobReady(
  id
) {
  const supabase =
    getSupabase();

  const cleanId =
    String(
      id || ""
    ).trim();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .update({
        status:
          "pending",
        next_attempt_at:
          null,
        worker_id:
          null,
        claimed_at:
          null,
        last_error:
          null,
        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        cleanId
      )
      .eq(
        "status",
        "uploading"
      )
      .select("*")
      .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to activate uploaded file: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      "Upload job is no longer waiting for upload completion."
    );
  }

  return data;
}

export async function getUploadJobById(
  id
) {
  const supabase =
    getSupabase();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .select("*")
      .eq(
        "id",
        String(
          id || ""
        ).trim()
      )
      .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to load upload job: ${error.message}`
    );
  }

  return data || null;
}

export async function listUploadJobs(
  limit = 100
) {
  const supabase =
    getSupabase();

  const safeLimit =
    Math.min(
      200,
      Math.max(
        1,
        Number(limit) || 100
      )
    );

  const {
    data: jobs,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .select("*")
      .neq(
        "status",
        "cancelled"
      )
      .order(
        "created_at",
        {
          ascending:
            false,
        }
      )
      .limit(
        safeLimit
      );

  if (error) {
    throw new Error(
      `Unable to load upload queue: ${error.message}`
    );
  }

  const cloudIds =
    [
      ...new Set(
        (jobs || [])
          .map(
            (job) =>
              job.cloud_post_id
          )
          .filter(Boolean)
      ),
    ];

  let cloudById =
    new Map();

  if (
    cloudIds.length > 0
  ) {
    const {
      data: cloudPosts,
      error:
        cloudError,
    } =
      await supabase
        .from(
          "cloud_posts"
        )
        .select(
          "id,status,caption,publish_at,facebook_results,facebook_post_ids,last_error,published_at,updated_at"
        )
        .in(
          "id",
          cloudIds
        );

    if (cloudError) {
      throw new Error(
        `Unable to load prepared cloud posts: ${cloudError.message}`
      );
    }

    cloudById =
      new Map(
        (cloudPosts || [])
          .map(
            (post) => [
              post.id,
              post,
            ]
          )
      );
  }

  return (
    jobs || []
  ).map(
    (job) => ({
      ...job,
      cloud_post:
        job.cloud_post_id
          ? cloudById.get(
              job.cloud_post_id
            ) ||
            null
          : null,
    })
  );
}

export async function claimNextUploadJob(
  workerId
) {
  const supabase =
    getSupabase();

  const {
    data,
    error,
  } =
    await supabase
      .rpc(
        "claim_next_upload_job",
        {
          p_worker_id:
            workerId,
        }
      );

  if (error) {
    throw new Error(
      `Unable to claim upload job: ${error.message}`
    );
  }

  return (
    Array.isArray(data)
      ? data[0]
      : data
  ) || null;
}

export async function recoverStaleUploadJobs({
  staleMs =
    10 * 60 * 1000,
} = {}) {
  const supabase =
    getSupabase();

  const staleBefore =
    new Date(
      Date.now() -
        staleMs
    ).toISOString();

  const {
    data,
    error,
  } =
    await supabase
      .rpc(
        "recover_stale_upload_jobs",
        {
          p_stale_before:
            staleBefore,
        }
      );

  if (error) {
    throw new Error(
      `Unable to recover stale uploads: ${error.message}`
    );
  }

  return Number(
    data || 0
  );
}

export async function downloadUploadJobMedia({
  job,
  destinationDir,
}) {
  const supabase =
    getSupabase();

  if (
    !job?.storage_path
  ) {
    throw new Error(
      "Upload job has no storage path."
    );
  }

  fs.mkdirSync(
    destinationDir,
    {
      recursive:
        true,
    }
  );

  const {
    data,
    error,
  } =
    await supabase
      .storage
      .from(
        UPLOAD_BUCKET
      )
      .download(
        job.storage_path
      );

  if (error) {
    throw new Error(
      `Unable to download uploaded media: ${error.message}`
    );
  }

  const buffer =
    Buffer.from(
      await data
        .arrayBuffer()
    );

  const originalName =
    String(
      job.original_name ||
      "upload"
    );

  const extension =
    path
      .extname(
        originalName
      )
      .toLowerCase()
      .replace(
        /[^a-z0-9.]/g,
        ""
      )
      .slice(
        0,
        10
      );

  const filePath =
    path.join(
      destinationDir,
      `${job.id}${extension}`
    );

  fs.writeFileSync(
    filePath,
    buffer
  );

  return {
    path:
      filePath,
    originalname:
      originalName,
    mimetype:
      job.mime_type ||
      "application/octet-stream",
    size:
      Number(
        job.file_size ||
        buffer.length
      ),
  };
}


export async function saveUploadJobPreparation({
  id,
  caption,
  publishAt,
}) {
  const supabase =
    getSupabase();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .update({
        caption:
          caption ||
          null,
        publish_at:
          publishAt ||
          null,
        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        String(
          id || ""
        ).trim()
      )
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Unable to save upload preparation state: ${error.message}`
    );
  }

  return data;
}

export async function completeUploadJob({
  id,
  cloudPostId,
  caption,
  publishAt,
}) {
  const supabase =
    getSupabase();

  const now =
    new Date()
      .toISOString();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .update({
        status:
          "completed",
        cloud_post_id:
          cloudPostId,
        caption:
          caption ||
          null,
        publish_at:
          publishAt ||
          null,
        last_error:
          null,
        worker_id:
          null,
        claimed_at:
          null,
        next_attempt_at:
          null,
        completed_at:
          now,
        updated_at:
          now,
      })
      .eq(
        "id",
        String(
          id || ""
        ).trim()
      )
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Unable to complete upload job: ${error.message}`
    );
  }

  return data;
}

export async function retryUploadJob({
  id,
  error,
  delayMs =
    2 * 60 * 1000,
}) {
  const supabase =
    getSupabase();

  const current =
    await getUploadJobById(
      id
    );

  if (!current) {
    return null;
  }

  const attempts =
    Number(
      current.attempts ||
      0
    );

  const maxAttempts =
    Number(
      current.max_attempts ||
      5
    );

  const exhausted =
    attempts >=
    maxAttempts;

  const message =
    error?.response?.data
      ? JSON.stringify(
          error.response.data
        )
      : error?.message ||
        String(
          error ||
          "Unknown upload processing error."
        );

  const {
    data,
    error:
      updateError,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .update({
        status:
          exhausted
            ? "failed"
            : "retry",
        worker_id:
          null,
        claimed_at:
          null,
        next_attempt_at:
          exhausted
            ? null
            : new Date(
                Date.now() +
                  delayMs
              )
                .toISOString(),
        last_error:
          message,
        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        current.id
      )
      .select("*")
      .single();

  if (updateError) {
    throw new Error(
      `Unable to save upload retry state: ${updateError.message}`
    );
  }

  return data;
}

export async function removeUploadInboxObject(
  storagePath
) {
  if (!storagePath) {
    return;
  }

  const supabase =
    getSupabase();

  const {
    error,
  } =
    await supabase
      .storage
      .from(
        UPLOAD_BUCKET
      )
      .remove([
        storagePath,
      ]);

  if (error) {
    console.warn(
      `Unable to remove upload inbox media ${storagePath}:`,
      error.message
    );
  }
}


export async function cancelUploadJobsByCloudPostId(
  cloudPostId
) {
  const supabase =
    getSupabase();

  const cleanId =
    String(
      cloudPostId || ""
    ).trim();

  if (!cleanId) {
    return [];
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .update({
        status:
          "cancelled",
        worker_id:
          null,
        claimed_at:
          null,
        next_attempt_at:
          null,
        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "cloud_post_id",
        cleanId
      )
      .neq(
        "status",
        "processing"
      )
      .select("*");

  if (error) {
    throw new Error(
      `Unable to synchronize cancelled upload jobs: ${error.message}`
    );
  }

  return data || [];
}

export async function cancelUploadJob(
  id
) {
  const supabase =
    getSupabase();

  const job =
    await getUploadJobById(
      id
    );

  if (!job) {
    throw new Error(
      "Upload job was not found."
    );
  }

  if (
    job.status ===
    "processing"
  ) {
    throw new Error(
      "This upload is currently being processed and cannot be deleted yet."
    );
  }

  if (
    job.status ===
    "cancelled"
  ) {
    return job;
  }

  if (
    job.status !==
    "completed"
  ) {
    await removeUploadInboxObject(
      job.storage_path
    );
  }

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "upload_jobs"
      )
      .update({
        status:
          "cancelled",
        worker_id:
          null,
        claimed_at:
          null,
        next_attempt_at:
          null,
        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        "id",
        job.id
      )
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Unable to cancel upload job: ${error.message}`
    );
  }

  return data;
}


function getFacebookPages(page) {
  const pages = {
    mlq: {
      pageId:
        process.env.MLQ_PAGE_ID,
      accessToken:
        process.env.MLQ_PAGE_ACCESS_TOKEN,
    },
    clawis: {
      pageId:
        process.env.C_LAWIS_PAGE_ID,
      accessToken:
        process.env.C_LAWIS_PAGE_ACCESS_TOKEN,
    },
  };

  if (page === "both") {
    return [
      {
        key: "mlq",
        ...pages.mlq,
      },
      {
        key: "clawis",
        ...pages.clawis,
      },
    ];
  }

  if (!pages[page]) {
    return [];
  }

  return [
    {
      key: page,
      ...pages[page],
    },
  ];
}

function sanitizeFilename(value) {
  const cleaned = String(
    value || "image"
  )
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "image";
}

function makeIdempotencyKey({
  sourceAssetId,
  sourceDriveId,
  localQueueItemId,
  page,
  publishAt,
}) {
  const source =
    sourceAssetId ||
    sourceDriveId ||
    `local-${localQueueItemId}`;

  const digest = crypto
    .createHash("sha256")
    .update(
      `${source}|${page}|${publishAt}`
    )
    .digest("hex")
    .slice(0, 24);

  return `modifica-${digest}`;
}

function pageConflicts(
  targetPage,
  existingPage
) {
  if (
    targetPage === "both" ||
    existingPage === "both"
  ) {
    return true;
  }

  return targetPage === existingPage;
}

export async function getCloudOccupiedUnixTimes(
  page
) {
  const supabase = getSupabase();

  const { data, error } =
    await supabase
      .from("cloud_posts")
      .select(
        "publish_at,page,status"
      )
      .in("status", [
        "ready",
        "publishing",
        "retry",
        "partial",
        "scheduled",
        "published",
      ])
      .gte(
        "publish_at",
        new Date(
          Date.now() -
            48 * 60 * 60 * 1000
        ).toISOString()
      );

  if (error) {
    throw new Error(
      `Unable to read cloud schedule: ${error.message}`
    );
  }

  const occupied = new Set();

  for (const row of data || []) {
    if (
      !pageConflicts(
        page,
        row.page
      )
    ) {
      continue;
    }

    const timestamp = new Date(
      row.publish_at
    ).getTime();

    if (
      Number.isFinite(timestamp)
    ) {
      occupied.add(
        Math.floor(
          timestamp / 1000
        )
      );
    }
  }

  return occupied;
}

export async function prepareCloudPost({
  localQueueItemId,
  sourceAssetId,
  sourceDriveId,
  sourceName,
  page,
  caption,
  publishAt,
  files,
}) {
  const supabase = getSupabase();

  if (
    !Array.isArray(files) ||
    files.length === 0
  ) {
    throw new Error(
      "At least one prepared media file is required for the cloud queue."
    );
  }

  const idempotencyKey =
    makeIdempotencyKey({
      sourceAssetId,
      sourceDriveId,
      localQueueItemId,
      page,
      publishAt,
    });

  const {
    data: existing,
    error: existingError,
  } = await supabase
    .from("cloud_posts")
    .select("*")
    .eq(
      "idempotency_key",
      idempotencyKey
    )
    .maybeSingle();

  if (existingError) {
    throw new Error(
      `Unable to check cloud queue: ${existingError.message}`
    );
  }

  if (
    existing &&
    [
      "ready",
      "publishing",
      "retry",
      "partial",
      "published",
    ].includes(existing.status)
  ) {
    return {
      cloudPost: existing,
      reused: true,
    };
  }

  const imagePaths = [];

  for (
    let index = 0;
    index < files.length;
    index += 1
  ) {
    const file = files[index];
    const originalName =
      file.originalname ||
      path.basename(file.path);

    const storagePath =
      `${idempotencyKey}/${String(
        index + 1
      ).padStart(2, "0")}-${sanitizeFilename(
        originalName
      )}`;

    const fileBuffer =
      fs.readFileSync(file.path);

    const { error: uploadError } =
      await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(
          storagePath,
          fileBuffer,
          {
            contentType:
              file.mimetype ||
              "application/octet-stream",
            upsert: true,
          }
        );

    if (uploadError) {
      throw new Error(
        `Unable to upload prepared media file ${index + 1} to Supabase: ${uploadError.message}`
      );
    }

    imagePaths.push(
      storagePath
    );
  }

  const payload = {
    idempotency_key:
      idempotencyKey,
    source_asset_id:
      sourceAssetId || null,
    source_drive_id:
      sourceDriveId || null,
    source_name:
      sourceName ||
      "Uploaded Post",
    local_queue_item_id:
      localQueueItemId || null,
    page,
    caption,
    publish_at:
      new Date(
        publishAt
      ).toISOString(),
    image_paths:
      imagePaths,
    status: "ready",
    attempts: 0,
    next_attempt_at: null,
    worker_id: null,
    claimed_at: null,
    facebook_results: null,
    facebook_post_ids: null,
    last_error: null,
    published_at: null,
    updated_at:
      new Date().toISOString(),
  };

  const { data, error } =
    await supabase
      .from("cloud_posts")
      .upsert(payload, {
        onConflict:
          "idempotency_key",
      })
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Unable to save prepared cloud post: ${error.message}`
    );
  }

  return {
    cloudPost: data,
    reused: false,
  };
}

export async function getCloudPostsByIds(
  ids
) {
  const cleanIds = [
    ...new Set(
      (ids || []).filter(Boolean)
    ),
  ];

  if (cleanIds.length === 0) {
    return [];
  }

  const supabase = getSupabase();

  const { data, error } =
    await supabase
      .from("cloud_posts")
      .select(
        "id,status,caption,publish_at,attempts,max_attempts,facebook_results,facebook_post_ids,last_error,published_at,updated_at"
      )
      .in("id", cleanIds);

  if (error) {
    throw new Error(
      `Unable to synchronize cloud posts: ${error.message}`
    );
  }

  return data || [];
}


export async function updatePreparedCloudPost({
  id,
  caption,
  publishAt,
}) {
  const supabase = getSupabase();

  const cleanId =
    String(id || "").trim();

  const cleanCaption =
    String(caption || "").trim();

  const publishDate =
    new Date(publishAt);

  if (!cleanId) {
    throw new Error(
      "Cloud post ID is required."
    );
  }

  if (!cleanCaption) {
    throw new Error(
      "Caption cannot be empty."
    );
  }

  if (
    !Number.isFinite(
      publishDate.getTime()
    )
  ) {
    throw new Error(
      "Publish time is invalid."
    );
  }

  if (
    publishDate.getTime() <=
    Date.now() + 11 * 60 * 1000
  ) {
    throw new Error(
      "Choose a publish time at least 11 minutes in the future so Facebook can accept it as a native scheduled post."
    );
  }

  const now =
    new Date().toISOString();

  const { data, error } =
    await supabase
      .from("cloud_posts")
      .update({
        caption:
          cleanCaption,
        publish_at:
          publishDate.toISOString(),
        status: "ready",
        attempts: 0,
        next_attempt_at: null,
        worker_id: null,
        claimed_at: null,
        facebook_results: null,
        facebook_post_ids: null,
        last_error: null,
        published_at: null,
        updated_at: now,
      })
      .eq(
        "id",
        cleanId
      )
      .in(
        "status",
        [
          "ready",
          "retry",
        ]
      )
      .is(
        "worker_id",
        null
      )
      .select("*")
      .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to update cloud draft: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      "This post is already publishing, published, cancelled, or otherwise no longer editable."
    );
  }

  return data;
}

export async function cancelPreparedCloudPost(
  id
) {
  const supabase = getSupabase();

  const cleanId =
    String(id || "").trim();

  if (!cleanId) {
    throw new Error(
      "Cloud post ID is required."
    );
  }

  const now =
    new Date().toISOString();

  // Claim cancellation atomically before removing files so the
  // publisher cannot take this job at the same time.
  const {
    data: cancelled,
    error: cancelError,
  } = await supabase
    .from("cloud_posts")
    .update({
      status: "cancelled",
      next_attempt_at: null,
      worker_id: null,
      claimed_at: null,
      last_error: null,
      updated_at: now,
    })
    .eq(
      "id",
      cleanId
    )
    .in(
      "status",
      [
        "ready",
        "retry",
        "failed",
        "partial",
      ]
    )
    .is(
      "worker_id",
      null
    )
    .select("*")
    .maybeSingle();

  if (cancelError) {
    throw new Error(
      `Unable to cancel cloud draft: ${cancelError.message}`
    );
  }

  if (!cancelled) {
    throw new Error(
      "This post is already publishing, published, cancelled, or otherwise no longer deletable."
    );
  }

  await removeCloudImages(
    cancelled.image_paths || []
  );

  const {
    data,
    error,
  } = await supabase
    .from("cloud_posts")
    .update({
      image_paths: [],
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      "id",
      cleanId
    )
    .eq(
      "status",
      "cancelled"
    )
    .select("*")
    .single();

  if (error) {
    throw new Error(
      `Draft was cancelled, but cleanup metadata could not be saved: ${error.message}`
    );
  }

  return data;
}



function getNativeScheduledPostId(result) {
  if (!result || typeof result !== "object") {
    return "";
  }

  return String(
    result.scheduledPostId ||
      result.postId ||
      result.verification?.scheduledPostId ||
      "",
  ).trim();
}

function assertManagedPublishTime(publishAt) {
  const date = new Date(publishAt);

  if (!Number.isFinite(date.getTime())) {
    throw new Error("Publish time is invalid.");
  }

  if (date.getTime() <= Date.now() + 11 * 60 * 1000) {
    throw new Error(
      "Choose a publish time at least 11 minutes in the future.",
    );
  }

  return date;
}

export async function editManagedCloudPost({
  id,
  caption,
  publishAt,
}) {
  const supabase = getSupabase();
  const cleanId = String(id || "").trim();
  const cleanCaption = String(caption || "").trim();
  const publishDate = assertManagedPublishTime(publishAt);

  if (!cleanId) {
    throw new Error("Cloud post ID is required.");
  }

  if (!cleanCaption) {
    throw new Error("Caption cannot be empty.");
  }

  const { data: post, error } = await supabase
    .from("cloud_posts")
    .select("*")
    .eq("id", cleanId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to load scheduled post: ${error.message}`,
    );
  }

  if (!post) {
    throw new Error("Scheduled post was not found.");
  }

  if (["ready", "retry"].includes(post.status)) {
    return updatePreparedCloudPost({
      id: cleanId,
      caption: cleanCaption,
      publishAt: publishDate.toISOString(),
    });
  }

  if (post.status !== "scheduled") {
    throw new Error(
      "This post is already publishing, published, cancelled, or otherwise no longer editable.",
    );
  }

  const selectedPages = getFacebookPages(post.page);
  const results = parseResults(post.facebook_results);
  const resultByPage = new Map(
    results.map((result) => [result.page, result]),
  );
  const scheduledUnix = Math.floor(publishDate.getTime() / 1000);
  const updatedResults = [];
  const failures = [];

  for (const selectedPage of selectedPages) {
    const prior = resultByPage.get(selectedPage.key);
    const postId = getNativeScheduledPostId(prior);

    if (!selectedPage.pageId || !selectedPage.accessToken) {
      failures.push(
        `${selectedPage.key}: Facebook Page configuration is missing.`,
      );
      continue;
    }

    if (!postId) {
      failures.push(
        `${selectedPage.key}: scheduled Facebook post ID is missing.`,
      );
      continue;
    }

    try {
      const params = new URLSearchParams();
      params.append("message", cleanCaption);
      params.append("scheduled_publish_time", String(scheduledUnix));
      params.append("access_token", selectedPage.accessToken);

      await axios.post(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${encodeURIComponent(postId)}`,
        params,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: FACEBOOK_TIMEOUT_MS,
        },
      );

      updatedResults.push({
        ...prior,
        page: selectedPage.key,
        success: true,
        nativeScheduled: true,
        scheduledPostId: postId,
        postId,
        scheduledPublishTime: scheduledUnix,
        verification: {
          ...(prior?.verification || {}),
          verified: true,
          verifiedBy: "owner_edit",
          verifiedAt: new Date().toISOString(),
          scheduledPostId: postId,
          scheduledPublishTime: scheduledUnix,
        },
      });
    } catch (updateError) {
      failures.push(
        `${selectedPage.key}: ${
          updateError.response?.data?.error?.message ||
          updateError.message ||
          String(updateError)
        }`,
      );
      updatedResults.push(prior);
    }
  }

  if (failures.length > 0) {
    await updateCloudPost(cleanId, {
      facebook_results: updatedResults,
      last_error:
        "Scheduled post edit was only partially applied: " +
        failures.join(" | "),
    });

    throw new Error(
      "Scheduled post edit was only partially applied: " +
        failures.join(" | "),
    );
  }

  return updateCloudPost(cleanId, {
    caption: cleanCaption,
    publish_at: publishDate.toISOString(),
    facebook_results: updatedResults,
    last_error: null,
  });
}

export async function cancelManagedCloudPost(id) {
  const supabase = getSupabase();
  const cleanId = String(id || "").trim();

  if (!cleanId) {
    throw new Error("Cloud post ID is required.");
  }

  const { data: post, error } = await supabase
    .from("cloud_posts")
    .select("*")
    .eq("id", cleanId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to load scheduled post: ${error.message}`,
    );
  }

  if (!post) {
    throw new Error("Scheduled post was not found.");
  }

  if (["ready", "retry", "failed"].includes(post.status)) {
    return cancelPreparedCloudPost(cleanId);
  }

  if (post.status !== "scheduled") {
    throw new Error(
      "This post is already publishing, published, cancelled, or otherwise no longer deletable.",
    );
  }

  const selectedPages = getFacebookPages(post.page);
  const results = parseResults(post.facebook_results);
  const resultByPage = new Map(
    results.map((result) => [result.page, result]),
  );
  const updatedResults = [];
  const failures = [];

  for (const selectedPage of selectedPages) {
    const prior = resultByPage.get(selectedPage.key);
    const postId = getNativeScheduledPostId(prior);

    if (!selectedPage.pageId || !selectedPage.accessToken) {
      failures.push(
        `${selectedPage.key}: Facebook Page configuration is missing.`,
      );
      updatedResults.push(prior);
      continue;
    }

    if (!postId) {
      failures.push(
        `${selectedPage.key}: scheduled Facebook post ID is missing.`,
      );
      updatedResults.push(prior);
      continue;
    }

    try {
      const response = await axios.delete(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${encodeURIComponent(postId)}`,
        {
          params: {
            access_token: selectedPage.accessToken,
          },
          timeout: FACEBOOK_TIMEOUT_MS,
        },
      );

      if (response.data?.success === false) {
        throw new Error("Facebook did not confirm deletion.");
      }

      updatedResults.push({
        ...prior,
        page: selectedPage.key,
        success: false,
        cancelled: true,
        cancelledAt: new Date().toISOString(),
      });
    } catch (deleteError) {
      failures.push(
        `${selectedPage.key}: ${
          deleteError.response?.data?.error?.message ||
          deleteError.message ||
          String(deleteError)
        }`,
      );
      updatedResults.push(prior);
    }
  }

  if (failures.length > 0) {
    await updateCloudPost(cleanId, {
      status: "partial",
      facebook_results: updatedResults,
      last_error:
        "Scheduled post deletion was only partially applied: " +
        failures.join(" | "),
    });

    throw new Error(
      "Scheduled post deletion was only partially applied: " +
        failures.join(" | "),
    );
  }

  await removeCloudImages(post.image_paths || []);

  return updateCloudPost(cleanId, {
    status: "cancelled",
    facebook_results: updatedResults,
    facebook_post_ids: null,
    image_paths: [],
    next_attempt_at: null,
    worker_id: null,
    claimed_at: null,
    last_error: null,
  });
}

export async function cancelAllPreparedCloudPosts() {
  const supabase = getSupabase();

  const {
    data: rows,
    error,
  } = await supabase
    .from("cloud_posts")
    .select("id,status")
    .in(
      "status",
      [
        "ready",
        "retry",
        "failed",
        "partial",
      ]
    )
    .is(
      "worker_id",
      null
    )
    .order(
      "publish_at",
      {
        ascending: true,
      }
    );

  if (error) {
    throw new Error(
      `Unable to load scheduled cloud drafts: ${error.message}`
    );
  }

  const cancelled = [];
  const skipped = [];
  const failures = [];

  for (const row of rows || []) {
    try {
      const result =
        await cancelPreparedCloudPost(
          row.id
        );

      cancelled.push(
        result
      );
    } catch (cancelError) {
      const message =
        cancelError.message ||
        String(cancelError);

      if (
        message.includes(
          "no longer deletable"
        )
      ) {
        skipped.push({
          id: row.id,
          reason: message,
        });
      } else {
        failures.push({
          id: row.id,
          error: message,
        });
      }
    }
  }

  return {
    cancelled,
    skipped,
    failures,
  };
}


function isRetryableFacebookError(
  error
) {
  const code = String(
    error?.code ||
      error?.cause?.code ||
      error?.errno ||
      ""
  ).toUpperCase();

  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNABORTED",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ENETDOWN",
      "ENETUNREACH",
      "EHOSTDOWN",
      "EHOSTUNREACH",
      "ESOCKETTIMEDOUT",
    ].includes(code)
  ) {
    return true;
  }

  const status = Number(
    error?.response?.status ||
      error?.status ||
      0
  );

  if (
    status === 408 ||
    status === 429 ||
    status >= 500
  ) {
    return true;
  }

  const graphError =
    error?.response?.data?.error ||
    null;

  if (
    graphError?.is_transient ===
    true
  ) {
    return true;
  }

  const message = String(
    error?.message ||
      JSON.stringify(
        error?.response?.data ||
          error ||
          ""
      )
  ).toLowerCase();

  return [
    "timeout",
    "timed out",
    "etimedout",
    "econnreset",
    "econnaborted",
    "eai_again",
    "enotfound",
    "getaddrinfo",
    "network error",
    "temporarily unavailable",
  ].some((part) =>
    message.includes(part)
  );
}

function normalizeMessage(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function findRecentMatchingPost({
  selectedPage,
  caption,
  publishAt,
}) {
  const since = Math.floor(
    (
      new Date(
        publishAt || Date.now()
      ).getTime() -
      10 * 60 * 1000
    ) / 1000
  );

  const response =
    await axios.get(
      `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/published_posts`,
      {
        params: {
          fields:
            "id,message,created_time,permalink_url",
          limit: 50,
          since,
          access_token:
            selectedPage.accessToken,
        },
        timeout: 20000,
      }
    );

  const expected =
    normalizeMessage(caption);

  return (
    response.data?.data || []
  ).find(
    (post) =>
      normalizeMessage(
        post.message
      ) === expected
  ) || null;
}


function sleep(
  milliseconds
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

function normalizeFacebookBoolean(
  value
) {
  if (
    value === true ||
    value === false
  ) {
    return value;
  }

  if (
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() ===
      "true"
  ) {
    return true;
  }

  if (
    value === 0 ||
    value === "0" ||
    String(value).toLowerCase() ===
      "false"
  ) {
    return false;
  }

  return null;
}

async function readFacebookPublishedObject({
  selectedPage,
  objectId,
  mediaType,
}) {
  const primaryFields =
    mediaType === "video"
      ? "id,description,created_time,permalink_url,is_published"
      : "id,message,created_time,permalink_url,is_published";

  try {
    const response =
      await axios.get(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${encodeURIComponent(
          objectId
        )}`,
        {
          params: {
            fields:
              primaryFields,
            access_token:
              selectedPage.accessToken,
          },
          timeout:
            20000,
        }
      );

    return {
      data:
        response.data ||
        null,
      usedFallbackFields:
        false,
    };
  } catch (error) {
    const message =
      String(
        error.response?.data?.error
          ?.message ||
        error.message ||
        ""
      ).toLowerCase();

    const unsupportedField =
      message.includes(
        "nonexisting field"
      ) ||
      message.includes(
        "unknown field"
      ) ||
      message.includes(
        "cannot query field"
      ) ||
      message.includes(
        "is_published"
      );

    if (!unsupportedField) {
      throw error;
    }

    const fallbackFields =
      mediaType === "video"
        ? "id,description,created_time,permalink_url"
        : "id,message,created_time,permalink_url";

    const response =
      await axios.get(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${encodeURIComponent(
          objectId
        )}`,
        {
          params: {
            fields:
              fallbackFields,
            access_token:
              selectedPage.accessToken,
          },
          timeout:
            20000,
        }
      );

    return {
      data:
        response.data ||
        null,
      usedFallbackFields:
        true,
    };
  }
}

async function verifyFacebookPublication({
  selectedPage,
  createdObjectId,
  caption,
  publishAt,
  mediaType,
}) {
  const delays = [
    0,
    2000,
    3000,
    4000,
    6000,
  ];

  let lastDirectObject =
    null;

  let lastPublishedMatch =
    null;

  let lastDirectError =
    null;

  let lastPublishedListError =
    null;

  let usedFallbackFields =
    false;

  for (
    let attemptIndex = 0;
    attemptIndex <
      delays.length;
    attemptIndex += 1
  ) {
    const delay =
      delays[
        attemptIndex
      ];

    if (delay > 0) {
      await sleep(
        delay
      );
    }

    try {
      const direct =
        await readFacebookPublishedObject({
          selectedPage,
          objectId:
            createdObjectId,
          mediaType,
        });

      lastDirectObject =
        direct.data;

      usedFallbackFields =
        direct.usedFallbackFields;

      lastDirectError =
        null;
    } catch (error) {
      lastDirectError =
        error;
    }

    try {
      lastPublishedMatch =
        await findRecentMatchingPost({
          selectedPage,
          caption,
          publishAt,
        });

      lastPublishedListError =
        null;
    } catch (error) {
      lastPublishedListError =
        error;
    }

    const directIsPublished =
      normalizeFacebookBoolean(
        lastDirectObject
          ?.is_published
      );

    const directObjectExists =
      Boolean(
        lastDirectObject?.id
      );

    const publishedFeedMatch =
      Boolean(
        lastPublishedMatch?.id
      );

    // The strongest signal is the Page's published_posts edge.
    // A photo can exist in Photos without being a surfaced Page post,
    // so we do not mark the job Published until published_posts confirms it.
    if (
      publishedFeedMatch &&
      directIsPublished !==
        false
    ) {
      return {
        verified: true,
        verifiedAt:
          new Date()
            .toISOString(),
        verificationAttempts:
          attemptIndex + 1,
        createdObjectId:
          String(
            createdObjectId
          ),
        directObjectExists,
        directObjectId:
          lastDirectObject?.id ||
          null,
        directIsPublished,
        directPermalinkUrl:
          lastDirectObject
            ?.permalink_url ||
          null,
        usedFallbackFields,
        publishedPostId:
          lastPublishedMatch.id,
        publishedPermalinkUrl:
          lastPublishedMatch
            .permalink_url ||
          null,
        publishedCreatedTime:
          lastPublishedMatch
            .created_time ||
          null,
      };
    }
  }

  return {
    verified: false,
    verifiedAt:
      new Date()
        .toISOString(),
    verificationAttempts:
      delays.length,
    createdObjectId:
      String(
        createdObjectId
      ),
    directObjectExists:
      Boolean(
        lastDirectObject?.id
      ),
    directObjectId:
      lastDirectObject?.id ||
      null,
    directIsPublished:
      normalizeFacebookBoolean(
        lastDirectObject
          ?.is_published
      ),
    directPermalinkUrl:
      lastDirectObject
        ?.permalink_url ||
      null,
    usedFallbackFields,
    publishedPostId:
      lastPublishedMatch?.id ||
      null,
    publishedPermalinkUrl:
      lastPublishedMatch
        ?.permalink_url ||
      null,
    directLookupError:
      lastDirectError
        ? String(
            lastDirectError
              .response?.data?.error
              ?.message ||
            lastDirectError
              .message ||
            lastDirectError
          )
        : null,
    publishedListError:
      lastPublishedListError
        ? String(
            lastPublishedListError
              .response?.data?.error
              ?.message ||
            lastPublishedListError
              .message ||
            lastPublishedListError
          )
        : null,
  };
}


function inferCloudMimeType(
  name,
  currentType
) {
  const type =
    String(
      currentType || ""
    ).toLowerCase();

  if (
    type &&
    type !==
      "application/octet-stream"
  ) {
    return type;
  }

  const lowerName =
    String(name || "")
      .toLowerCase();

  if (
    lowerName.endsWith(
      ".mp4"
    )
  ) {
    return "video/mp4";
  }

  if (
    lowerName.endsWith(
      ".png"
    )
  ) {
    return "image/png";
  }

  if (
    lowerName.endsWith(
      ".webp"
    )
  ) {
    return "image/webp";
  }

  if (
    lowerName.endsWith(
      ".gif"
    )
  ) {
    return "image/gif";
  }

  return "image/jpeg";
}

function isCloudVideoFile(
  file
) {
  return (
    String(
      file?.mimeType || ""
    )
      .toLowerCase() ===
      "video/mp4" ||
    String(
      file?.name || ""
    )
      .toLowerCase()
      .endsWith(".mp4")
  );
}


async function downloadCloudMedia(
  imagePaths
) {
  const supabase = getSupabase();
  const files = [];

  for (
    let index = 0;
    index < imagePaths.length;
    index += 1
  ) {
    const storagePath =
      imagePaths[index];

    const { data, error } =
      await supabase.storage
        .from(STORAGE_BUCKET)
        .download(storagePath);

    if (error || !data) {
      throw new Error(
        `Unable to download prepared cloud media ${index + 1}: ${error?.message || "No file returned."}`
      );
    }

    const arrayBuffer =
      await data.arrayBuffer();

    const name =
      path.basename(
        storagePath
      ) ||
      `media-${index + 1}`;

    files.push({
      buffer: Buffer.from(
        arrayBuffer
      ),
      name,
      mimeType:
        inferCloudMimeType(
          name,
          data.type
        ),
    });
  }

  return files;
}


function getFacebookScheduleUnix(
  publishAt
) {
  const timestamp =
    Math.floor(
      new Date(
        publishAt
      ).getTime() /
        1000
    );

  if (
    !Number.isFinite(
      timestamp
    )
  ) {
    throw new Error(
      "Facebook native schedule time is invalid."
    );
  }

  return timestamp;
}

function isFacebookNativeScheduleFarEnough(
  publishAt
) {
  return (
    new Date(
      publishAt
    ).getTime() >=
    Date.now() +
      10 * 60 * 1000
  );
}

async function findScheduledMatchingPost({
  selectedPage,
  caption,
  publishAt,
}) {
  const expectedMessage =
    normalizeMessage(
      caption
    );

  const expectedUnix =
    getFacebookScheduleUnix(
      publishAt
    );

  const response =
    await axios.get(
      `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/scheduled_posts`,
      {
        params: {
          fields:
            "id,message,scheduled_publish_time,created_time,permalink_url",
          limit: 100,
          access_token:
            selectedPage.accessToken,
        },
        timeout:
          20000,
      }
    );

  const candidates =
    response.data?.data ||
    [];

  return (
    candidates.find(
      (post) => {
        const messageMatches =
          normalizeMessage(
            post.message
          ) ===
          expectedMessage;

        const scheduledUnix =
          Number(
            post.scheduled_publish_time ||
            0
          );

        const timeMatches =
          scheduledUnix > 0
            ? Math.abs(
                scheduledUnix -
                  expectedUnix
              ) <=
              120
            : true;

        return (
          messageMatches &&
          timeMatches
        );
      }
    ) ||
    candidates.find(
      (post) => {
        const scheduledUnix =
          Number(
            post.scheduled_publish_time ||
            0
          );

        return (
          scheduledUnix > 0 &&
          Math.abs(
            scheduledUnix -
              expectedUnix
          ) <=
            60
        );
      }
    ) ||
    null
  );
}

async function verifyNativeScheduledPost({
  selectedPage,
  caption,
  publishAt,
}) {
  const delays = [
    0,
    1500,
    2500,
    4000,
    6000,
  ];

  let lastError =
    null;

  for (
    let index = 0;
    index <
      delays.length;
    index += 1
  ) {
    if (
      delays[index] >
      0
    ) {
      await sleep(
        delays[index]
      );
    }

    try {
      const scheduledPost =
        await findScheduledMatchingPost({
          selectedPage,
          caption,
          publishAt,
        });

      if (scheduledPost) {
        return {
          verified: true,
          verifiedBy:
            "scheduled_posts",
          verifiedAt:
            new Date()
              .toISOString(),
          verificationAttempts:
            index + 1,
          scheduledPostId:
            scheduledPost.id,
          scheduledPublishTime:
            scheduledPost
              .scheduled_publish_time ||
            getFacebookScheduleUnix(
              publishAt
            ),
          permalinkUrl:
            scheduledPost
              .permalink_url ||
            null,
        };
      }
    } catch (error) {
      lastError =
        error;
    }
  }

  return {
    verified: false,
    verifiedBy:
      "scheduled_posts",
    verifiedAt:
      new Date()
        .toISOString(),
    verificationAttempts:
      delays.length,
    scheduledPublishTime:
      getFacebookScheduleUnix(
        publishAt
      ),
    error:
      lastError
        ? String(
            lastError
              .response?.data?.error
              ?.message ||
            lastError
              .message ||
            lastError
          )
        : "Facebook did not return the post from scheduled_posts.",
  };
}

async function scheduleNativeFacebookPost({
  selectedPage,
  caption,
  files,
  publishAt,
}) {
  if (
    !isFacebookNativeScheduleFarEnough(
      publishAt
    )
  ) {
    throw new Error(
      "Facebook native scheduled posts require at least about 10 minutes of lead time."
    );
  }

  const scheduledPublishTime =
    getFacebookScheduleUnix(
      publishAt
    );

  const videoFiles =
    files.filter(
      isCloudVideoFile
    );

  if (
    videoFiles.length >
      0
  ) {
    if (
      videoFiles.length !==
        1 ||
      files.length !==
        1
    ) {
      throw new Error(
        "Cloud video posts must contain exactly one MP4 file."
      );
    }

    const video =
      videoFiles[0];

    const form =
      new FormData();

    form.append(
      "source",
      video.buffer,
      {
        filename:
          video.name ||
          "video.mp4",
        contentType:
          "video/mp4",
      }
    );

    form.append(
      "description",
      caption
    );

    form.append(
      "published",
      "false"
    );

    form.append(
      "scheduled_publish_time",
      String(
        scheduledPublishTime
      )
    );

    form.append(
      "unpublished_content_type",
      "SCHEDULED"
    );

    form.append(
      "access_token",
      selectedPage.accessToken
    );

    const response =
      await axios.post(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/videos`,
        form,
        {
          headers:
            form.getHeaders(),
          maxBodyLength:
            Infinity,
          maxContentLength:
            Infinity,
          timeout:
            FACEBOOK_VIDEO_TIMEOUT_MS,
        }
      );

    const createdObjectId =
      response.data?.post_id ||
      response.data?.id;

    if (!createdObjectId) {
      throw new Error(
        "Facebook accepted the video request but did not return an ID."
      );
    }

    const verification =
      await verifyNativeScheduledPost({
        selectedPage,
        caption,
        publishAt,
      });

    if (
      !verification.verified
    ) {
      const error =
        new Error(
          "Facebook accepted the scheduled video request, but scheduled_posts did not confirm it."
        );

      error.facebookUncertain =
        true;

      error.createdObjectId =
        createdObjectId;

      error.verification =
        verification;

      throw error;
    }

    return {
      nativeScheduled: true,
      mediaType:
        "video",
      createdObjectId,
      scheduledPostId:
        verification
          .scheduledPostId,
      postId:
        verification
          .scheduledPostId,
      uploadedPhotoIds: [],
      scheduledPublishTime,
      verification,
    };
  }

  const uploadedPhotoIds =
    [];

  for (
    let index = 0;
    index <
      files.length;
    index += 1
  ) {
    const file =
      files[index];

    const form =
      new FormData();

    form.append(
      "source",
      file.buffer,
      {
        filename:
          file.name,
        contentType:
          file.mimeType,
      }
    );

    form.append(
      "published",
      "false"
    );

    form.append(
      "access_token",
      selectedPage.accessToken
    );

    const response =
      await axios.post(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/photos`,
        form,
        {
          headers:
            form.getHeaders(),
          timeout:
            FACEBOOK_TIMEOUT_MS,
        }
      );

    const photoId =
      response.data?.id;

    if (!photoId) {
      throw new Error(
        `Facebook did not return a photo ID for scheduled image ${index + 1}.`
      );
    }

    uploadedPhotoIds.push(
      photoId
    );
  }

  const params =
    new URLSearchParams();

  params.append(
    "message",
    caption
  );

  params.append(
    "published",
    "false"
  );

  params.append(
    "scheduled_publish_time",
    String(
      scheduledPublishTime
    )
  );

  params.append(
    "unpublished_content_type",
    "SCHEDULED"
  );

  uploadedPhotoIds.forEach(
    (photoId, index) => {
      params.append(
        `attached_media[${index}]`,
        JSON.stringify({
          media_fbid:
            photoId,
        })
      );
    }
  );

  params.append(
    "access_token",
    selectedPage.accessToken
  );

  const response =
    await axios.post(
      `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/feed`,
      params,
      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        timeout:
          FACEBOOK_TIMEOUT_MS,
      }
    );

  const createdObjectId =
    response.data?.id;

  if (!createdObjectId) {
    throw new Error(
      "Facebook accepted the scheduled photo request but did not return a Page Post ID."
    );
  }

  const verification =
    await verifyNativeScheduledPost({
      selectedPage,
      caption,
      publishAt,
    });

  if (
    !verification.verified
  ) {
    const error =
      new Error(
        "Facebook accepted the scheduled photo request, but scheduled_posts did not confirm it."
      );

    error.facebookUncertain =
      true;

    error.createdObjectId =
      createdObjectId;

    error.uploadedPhotoIds =
      uploadedPhotoIds;

    error.verification =
      verification;

    throw error;
  }

  return {
    nativeScheduled: true,
    mediaType:
      "photo",
    createdObjectId,
    scheduledPostId:
      verification
        .scheduledPostId,
    postId:
      verification
        .scheduledPostId,
    uploadedPhotoIds,
    scheduledPublishTime,
    verification,
  };
}

function hasNativeScheduledResults({
  selectedPages,
  resultByPage,
}) {
  return selectedPages.every(
    (page) =>
      resultByPage.get(
        page.key
      )?.nativeScheduled ===
      true
  );
}

async function verifyPreviouslyScheduledCloudPost({
  job,
  selectedPages,
  resultByPage,
}) {
  const results =
    [];

  for (
    const selectedPage of
    selectedPages
  ) {
    const prior =
      resultByPage.get(
        selectedPage.key
      );

    try {
      const existingPost =
        await findRecentMatchingPost({
          selectedPage,
          caption:
            job.caption,
          publishAt:
            job.publish_at,
        });

      if (existingPost) {
        const verified = {
          ...prior,
          page:
            selectedPage.key,
          success: true,
          nativeScheduled: true,
          publishedVerified:
            true,
          postId:
            existingPost.id,
          publishedPostId:
            existingPost.id,
          permalinkUrl:
            existingPost
              .permalink_url ||
            prior?.permalinkUrl ||
            null,
          verification: {
            ...(prior?.verification ||
              {}),
            verified: true,
            verifiedBy:
              "published_posts_after_native_schedule",
            publishedVerifiedAt:
              new Date()
                .toISOString(),
            publishedPostId:
              existingPost.id,
            publishedPermalinkUrl:
              existingPost
                .permalink_url ||
              null,
            publishedCreatedTime:
              existingPost
                .created_time ||
              null,
          },
        };

        resultByPage.set(
          selectedPage.key,
          verified
        );

        results.push(
          verified
        );
      } else {
        const pending = {
          ...prior,
          page:
            selectedPage.key,
          success: false,
          nativeScheduled: true,
          publishedVerified:
            false,
          retryable: true,
          uncertain: true,
          error:
            "Facebook has not exposed the native scheduled post in published_posts yet.",
        };

        resultByPage.set(
          selectedPage.key,
          pending
        );

        results.push(
          pending
        );
      }
    } catch (error) {
      const pending = {
        ...prior,
        page:
          selectedPage.key,
        success: false,
        nativeScheduled: true,
        publishedVerified:
          false,
        retryable: true,
        uncertain: true,
        error:
          error.response?.data ||
          error.message ||
          String(error),
      };

      resultByPage.set(
        selectedPage.key,
        pending
      );

      results.push(
        pending
      );
    }
  }

  const failures =
    results.filter(
      (result) =>
        !result.success
    );

  const postIds = {};

  for (
    const result of
    results.filter(
      (result) =>
        result.success
    )
  ) {
    if (
      result.postId
    ) {
      postIds[
        result.page
      ] =
        result.postId;
    }
  }

  if (
    failures.length ===
    0
  ) {
    return updateCloudPost(
      job.id,
      {
        status:
          "published",
        facebook_results:
          results,
        facebook_post_ids:
          postIds,
        published_at:
          new Date()
            .toISOString(),
        next_attempt_at:
          null,
        worker_id:
          null,
        claimed_at:
          null,
        last_error:
          null,
      }
    );
  }

  const attempts =
    Number(
      job.attempts ||
      0
    );

  const maxAttempts =
    Number(
      job.max_attempts ||
      5
    );

  if (
    attempts <
    maxAttempts
  ) {
    return updateCloudPost(
      job.id,
      {
        status:
          "retry",
        facebook_results:
          results,
        facebook_post_ids:
          postIds,
        next_attempt_at:
          new Date(
            Date.now() +
              PUBLISH_RETRY_DELAY_MS
          ).toISOString(),
        worker_id:
          null,
        claimed_at:
          null,
        last_error:
          failures
            .map(
              (failure) =>
                `${failure.page}: ${typeof failure.error === "string" ? failure.error : JSON.stringify(failure.error)}`
            )
            .join(
              " | "
            ),
      }
    );
  }

  return updateCloudPost(
    job.id,
    {
      status:
        results.some(
          (result) =>
            result.success
        )
          ? "partial"
          : "failed",
      facebook_results:
        results,
      facebook_post_ids:
        postIds,
      next_attempt_at:
        null,
      worker_id:
        null,
      claimed_at:
        null,
      last_error:
        failures
          .map(
            (failure) =>
              `${failure.page}: ${typeof failure.error === "string" ? failure.error : JSON.stringify(failure.error)}`
          )
          .join(
            " | "
          ),
    }
  );
}

async function publishImmediateFacebookPost({
  selectedPage,
  caption,
  files,
}) {
  if (
    !selectedPage.pageId ||
    !selectedPage.accessToken
  ) {
    throw new Error(
      `Facebook configuration missing for ${selectedPage.key}.`
    );
  }

  const videoFiles =
    files.filter(
      isCloudVideoFile
    );

  if (
    videoFiles.length > 0
  ) {
    if (
      files.length !== 1 ||
      videoFiles.length !== 1
    ) {
      throw new Error(
        "Cloud publisher supports either photo posts or one MP4 video per post, not mixed media."
      );
    }

    const video =
      videoFiles[0];

    const form =
      new FormData();

    form.append(
      "source",
      video.buffer,
      {
        filename:
          video.name ||
          "video.mp4",
        contentType:
          "video/mp4",
      }
    );

    form.append(
      "description",
      caption
    );

    form.append(
      "published",
      "true"
    );

    form.append(
      "access_token",
      selectedPage.accessToken
    );

    const response =
      await axios.post(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/videos`,
        form,
        {
          headers:
            form.getHeaders(),
          maxBodyLength:
            Infinity,
          maxContentLength:
            Infinity,
          timeout:
            FACEBOOK_VIDEO_TIMEOUT_MS,
        }
      );

    const videoId =
      response.data?.id;

    if (!videoId) {
      throw new Error(
        "Facebook did not return a video ID."
      );
    }

    return {
      id: videoId,
      uploadedPhotoIds: [],
      mediaType: "video",
    };
  }

  const uploadedPhotoIds = [];

  for (
    let index = 0;
    index < files.length;
    index += 1
  ) {
    const file = files[index];
    const form = new FormData();

    form.append(
      "source",
      file.buffer,
      {
        filename: file.name,
        contentType:
          file.mimeType,
      }
    );

    form.append(
      "published",
      "false"
    );

    // For an immediate multi-photo post, upload the photos as
    // unpublished media only. temporary=true is reserved for
    // Facebook-native scheduled posts.
    form.append(
      "access_token",
      selectedPage.accessToken
    );

    const response =
      await axios.post(
        `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/photos`,
        form,
        {
          headers:
            form.getHeaders(),
          timeout:
            FACEBOOK_TIMEOUT_MS,
        }
      );

    const photoId =
      response.data?.id;

    if (!photoId) {
      throw new Error(
        `Facebook did not return a photo ID for image ${index + 1}.`
      );
    }

    uploadedPhotoIds.push(
      photoId
    );
  }

  const params =
    new URLSearchParams();

  params.append(
    "message",
    caption
  );

  params.append(
    "published",
    "true"
  );

  uploadedPhotoIds.forEach(
    (photoId, index) => {
      params.append(
        `attached_media[${index}]`,
        JSON.stringify({
          media_fbid: photoId,
        })
      );
    }
  );

  params.append(
    "access_token",
    selectedPage.accessToken
  );

  const response =
    await axios.post(
      `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${selectedPage.pageId}/feed`,
      params,
      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        timeout:
          FACEBOOK_TIMEOUT_MS,
      }
    );

  if (!response.data?.id) {
    throw new Error(
      "Facebook did not return a post ID."
    );
  }

  return {
    id: response.data.id,
    uploadedPhotoIds,
    mediaType: "photo",
  };
}

async function updateCloudPost(
  id,
  patch
) {
  const supabase = getSupabase();

  const { data, error } =
    await supabase
      .from("cloud_posts")
      .update({
        ...patch,
        updated_at:
          new Date().toISOString(),
      })
      .eq("id", id)
      .select("*")
      .single();

  if (error) {
    throw new Error(
      `Unable to update cloud post ${id}: ${error.message}`
    );
  }

  return data;
}

async function removeCloudImages(
  imagePaths
) {
  if (
    !Array.isArray(
      imagePaths
    ) ||
    imagePaths.length === 0
  ) {
    return;
  }

  const supabase = getSupabase();

  const { error } =
    await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(imagePaths);

  if (error) {
    console.warn(
      "Cloud post published, but temporary media cleanup failed:",
      error.message
    );
  }
}

function parseResults(value) {
  if (Array.isArray(value)) {
    return value;
  }

  return [];
}

async function publishClaimedCloudPost(
  job
) {
  const selectedPages =
    getFacebookPages(job.page);

  if (
    selectedPages.length ===
    0
  ) {
    return updateCloudPost(
      job.id,
      {
        status: "failed",
        last_error:
          `Invalid Facebook Page selection: ${job.page}`,
      }
    );
  }

  let results =
    parseResults(
      job.facebook_results
    );

  const resultByPage =
    new Map(
      results.map((result) => [
        result.page,
        result,
      ])
    );

  if (
    hasNativeScheduledResults({
      selectedPages,
      resultByPage,
    }) &&
    new Date(
      job.publish_at
    ).getTime() <=
      Date.now() +
        2 * 60 * 1000
  ) {
    return verifyPreviouslyScheduledCloudPost({
      job,
      selectedPages,
      resultByPage,
    });
  }

  let files;

  try {
    files =
      await downloadCloudMedia(
        job.image_paths || []
      );
  } catch (error) {
    const retryable =
      isRetryableFacebookError(
        error
      );

    if (
      retryable &&
      Number(job.attempts || 0) <
        Number(job.max_attempts || 5)
    ) {
      return updateCloudPost(
        job.id,
        {
          status: "retry",
          next_attempt_at:
            new Date(
              Date.now() +
                PUBLISH_RETRY_DELAY_MS
            ).toISOString(),
          worker_id: null,
          claimed_at: null,
          last_error:
            error.message,
        }
      );
    }

    return updateCloudPost(
      job.id,
      {
        status: "failed",
        worker_id: null,
        claimed_at: null,
        last_error:
          error.message,
      }
    );
  }

  for (const selectedPage of selectedPages) {
    const prior =
      resultByPage.get(
        selectedPage.key
      );

    if (prior?.success) {
      continue;
    }

    if (
      prior?.nativeScheduled ===
        true &&
      prior?.success !==
        true &&
      new Date(
        job.publish_at
      ).getTime() >
        Date.now()
    ) {
      try {
        const existingScheduled =
          await findScheduledMatchingPost({
            selectedPage,
            caption:
              job.caption,
            publishAt:
              job.publish_at,
          });

        if (
          existingScheduled
        ) {
          resultByPage.set(
            selectedPage.key,
            {
              ...prior,
              page:
                selectedPage.key,
              success: true,
              nativeScheduled:
                true,
              publishedVerified:
                false,
              scheduledPostId:
                existingScheduled.id,
              postId:
                existingScheduled.id,
              permalinkUrl:
                existingScheduled
                  .permalink_url ||
                null,
              verification: {
                verified: true,
                verifiedBy:
                  "scheduled_posts_recovery",
                verifiedAt:
                  new Date()
                    .toISOString(),
                scheduledPostId:
                  existingScheduled.id,
                scheduledPublishTime:
                  existingScheduled
                    .scheduled_publish_time ||
                  getFacebookScheduleUnix(
                    job.publish_at
                  ),
                permalinkUrl:
                  existingScheduled
                    .permalink_url ||
                  null,
              },
            }
          );

          results =
            selectedPages
              .map(
                (page) =>
                  resultByPage.get(
                    page.key
                  )
              )
              .filter(Boolean);

          await updateCloudPost(
            job.id,
            {
              facebook_results:
                results,
            }
          );

          continue;
        }
      } catch (scheduledRecoveryError) {
        if (
          isRetryableFacebookError(
            scheduledRecoveryError
          )
        ) {
          return updateCloudPost(
            job.id,
            {
              status:
                "retry",
              next_attempt_at:
                new Date(
                  Date.now() +
                    PUBLISH_RETRY_DELAY_MS
                ).toISOString(),
              worker_id:
                null,
              claimed_at:
                null,
              last_error:
                `Facebook scheduled-post verification is temporarily unavailable for ${selectedPage.key}: ${scheduledRecoveryError.message}`,
            }
          );
        }
      }
    }

    const shouldVerifyBeforeSend =
      Number(job.attempts || 0) > 1 ||
      String(
        job.last_error || ""
      )
        .toLowerCase()
        .includes("stale") ||
      (
        prior?.uncertain ===
          true &&
        prior?.nativeScheduled !==
          true
      );

    if (shouldVerifyBeforeSend) {
      try {
        const existingPost =
          await findRecentMatchingPost({
            selectedPage,
            caption:
              job.caption,
            publishAt:
              job.publish_at,
          });

        if (existingPost) {
          resultByPage.set(
            selectedPage.key,
            {
              page:
                selectedPage.key,
              success: true,
              recovered: true,
              postId:
                existingPost.id,
              permalinkUrl:
                existingPost.permalink_url ||
                null,
              verification: {
                verified: true,
                verifiedBy:
                  "published_posts_recovery",
                verifiedAt:
                  new Date()
                    .toISOString(),
                publishedPostId:
                  existingPost.id,
                publishedPermalinkUrl:
                  existingPost.permalink_url ||
                  null,
                publishedCreatedTime:
                  existingPost.created_time ||
                  null,
              },
            }
          );

          results =
            selectedPages
              .map((page) =>
                resultByPage.get(
                  page.key
                )
              )
              .filter(Boolean);

          await updateCloudPost(
            job.id,
            {
              facebook_results:
                results,
            }
          );

          continue;
        }
      } catch (verifyError) {
        if (
          isRetryableFacebookError(
            verifyError
          )
        ) {
          return updateCloudPost(
            job.id,
            {
              status: "retry",
              next_attempt_at:
                new Date(
                  Date.now() +
                    PUBLISH_RETRY_DELAY_MS
                ).toISOString(),
              worker_id: null,
              claimed_at: null,
              last_error:
                `Facebook verification is temporarily unavailable for ${selectedPage.key}: ${verifyError.message}`,
            }
          );
        }

        throw verifyError;
      }
    }

    try {
      if (
        isFacebookNativeScheduleFarEnough(
          job.publish_at
        )
      ) {
        const scheduled =
          await scheduleNativeFacebookPost({
            selectedPage,
            caption:
              job.caption,
            files,
            publishAt:
              job.publish_at,
          });

        resultByPage.set(
          selectedPage.key,
          {
            page:
              selectedPage.key,
            success: true,
            nativeScheduled:
              true,
            publishedVerified:
              false,
            postId:
              scheduled.postId,
            scheduledPostId:
              scheduled
                .scheduledPostId,
            createdObjectId:
              scheduled
                .createdObjectId,
            mediaType:
              scheduled.mediaType,
            uploadedPhotoIds:
              scheduled
                .uploadedPhotoIds,
            scheduledPublishTime:
              scheduled
                .scheduledPublishTime,
            permalinkUrl:
              scheduled
                .verification
                ?.permalinkUrl ||
              null,
            verification:
              scheduled
                .verification,
          }
        );
      } else {
        // Safety fallback for an old/edited job that is already too close
        // to its publish time for Facebook native scheduling.
        const published =
          await publishImmediateFacebookPost({
            selectedPage,
            caption:
              job.caption,
            files,
          });

        const verification =
          await verifyFacebookPublication({
            selectedPage,
            createdObjectId:
              published.id,
            caption:
              job.caption,
            publishAt:
              job.publish_at,
            mediaType:
              published.mediaType ||
              "photo",
          });

        if (
          verification.verified
        ) {
          resultByPage.set(
            selectedPage.key,
            {
              page:
                selectedPage.key,
              success: true,
              postId:
                verification
                  .publishedPostId ||
                published.id,
              createdObjectId:
                published.id,
              mediaType:
                published.mediaType ||
                "photo",
              uploadedPhotoIds:
                published
                  .uploadedPhotoIds,
              permalinkUrl:
                verification
                  .publishedPermalinkUrl ||
                verification
                  .directPermalinkUrl ||
                null,
              verification,
            }
          );
        } else {
          resultByPage.set(
            selectedPage.key,
            {
              page:
                selectedPage.key,
              success: false,
              retryable: true,
              uncertain: true,
              postId:
                published.id,
              createdObjectId:
                published.id,
              mediaType:
                published.mediaType ||
                "photo",
              uploadedPhotoIds:
                published
                  .uploadedPhotoIds,
              error:
                "Facebook accepted the immediate creation request, but published_posts has not confirmed the Page post yet.",
              verification,
            }
          );
        }
      }
    } catch (error) {
      if (
        isRetryableFacebookError(
          error
        )
      ) {
        try {
          const recoveringFutureSchedule =
            new Date(
              job.publish_at
            ).getTime() >
            Date.now();

          const existingPost =
            recoveringFutureSchedule
              ? await findScheduledMatchingPost({
                  selectedPage,
                  caption:
                    job.caption,
                  publishAt:
                    job.publish_at,
                })
              : await findRecentMatchingPost({
                  selectedPage,
                  caption:
                    job.caption,
                  publishAt:
                    job.publish_at,
                });

          if (existingPost) {
            resultByPage.set(
              selectedPage.key,
              recoveringFutureSchedule
                ? {
                    page:
                      selectedPage.key,
                    success: true,
                    recovered: true,
                    nativeScheduled:
                      true,
                    publishedVerified:
                      false,
                    scheduledPostId:
                      existingPost.id,
                    postId:
                      existingPost.id,
                    permalinkUrl:
                      existingPost.permalink_url ||
                      null,
                    verification: {
                      verified: true,
                      verifiedBy:
                        "scheduled_posts_recovery",
                      verifiedAt:
                        new Date()
                          .toISOString(),
                      scheduledPostId:
                        existingPost.id,
                      scheduledPublishTime:
                        existingPost
                          .scheduled_publish_time ||
                        getFacebookScheduleUnix(
                          job.publish_at
                        ),
                    },
                  }
                : {
                    page:
                      selectedPage.key,
                    success: true,
                    recovered: true,
                    postId:
                      existingPost.id,
                    permalinkUrl:
                      existingPost.permalink_url ||
                      null,
                    verification: {
                      verified: true,
                      verifiedBy:
                        "published_posts_recovery",
                      verifiedAt:
                        new Date()
                          .toISOString(),
                      publishedPostId:
                        existingPost.id,
                      publishedPermalinkUrl:
                        existingPost.permalink_url ||
                        null,
                      publishedCreatedTime:
                        existingPost.created_time ||
                        null,
                    },
                  }
            );
          } else {
            resultByPage.set(
              selectedPage.key,
              {
                page:
                  selectedPage.key,
                success: false,
                retryable: true,
                uncertain: false,
                error:
                  error.response?.data ||
                  error.message ||
                  String(error),
              }
            );
          }
        } catch (verifyError) {
          resultByPage.set(
            selectedPage.key,
            {
              page:
                selectedPage.key,
              success: false,
              retryable: true,
              uncertain: true,
              error:
                error.response?.data ||
                error.message ||
                String(error),
              verificationError:
                verifyError.message,
            }
          );
        }
      } else if (
        error.facebookUncertain
      ) {
        resultByPage.set(
          selectedPage.key,
          {
            page:
              selectedPage.key,
            success: false,
            retryable: true,
            uncertain: true,
            nativeScheduled:
              true,
            createdObjectId:
              error.createdObjectId ||
              null,
            uploadedPhotoIds:
              error.uploadedPhotoIds ||
              [],
            verification:
              error.verification ||
              null,
            error:
              error.message ||
              String(error),
          }
        );
      } else {
        resultByPage.set(
          selectedPage.key,
          {
            page:
              selectedPage.key,
            success: false,
            retryable: false,
            error:
              error.response?.data ||
              error.message ||
              String(error),
          }
        );
      }
    }

    results =
      selectedPages
        .map((page) =>
          resultByPage.get(
            page.key
          )
        )
        .filter(Boolean);

    await updateCloudPost(
      job.id,
      {
        facebook_results:
          results,
      }
    );
  }

  results =
    selectedPages
      .map((page) =>
        resultByPage.get(
          page.key
        ) || {
          page: page.key,
          success: false,
          retryable: true,
          uncertain: true,
          error:
            "No publishing result was recorded.",
        }
      );

  const successes =
    results.filter(
      (result) =>
        result.success
    );

  const failures =
    results.filter(
      (result) =>
        !result.success
    );

  const postIds = {};

  for (const result of successes) {
    if (result.postId) {
      postIds[result.page] =
        result.postId;
    }
  }

  if (failures.length === 0) {
    const allNativeScheduled =
      results.length > 0 &&
      results.every(
        (result) =>
          result.nativeScheduled ===
            true &&
          result.publishedVerified !==
            true
      );

    if (
      allNativeScheduled
    ) {
      const scheduled =
        await updateCloudPost(
          job.id,
          {
            status:
              "scheduled",
            facebook_results:
              results,
            facebook_post_ids:
              postIds,
            image_paths: [],
            published_at:
              null,
            next_attempt_at:
              null,
            worker_id:
              null,
            claimed_at:
              null,
            last_error:
              null,
          }
        );

      await removeCloudImages(
        job.image_paths || []
      );

      return scheduled;
    }

    const published =
      await updateCloudPost(
        job.id,
        {
          status: "published",
          facebook_results:
            results,
          facebook_post_ids:
            postIds,
          published_at:
            new Date().toISOString(),
          next_attempt_at: null,
          worker_id: null,
          claimed_at: null,
          last_error: null,
        }
      );

    await removeCloudImages(
      job.image_paths || []
    );

    return published;
  }

  const retryableFailures =
    failures.filter(
      (failure) =>
        failure.retryable
    );

  const attempts = Number(
    job.attempts || 0
  );

  const maxAttempts = Number(
    job.max_attempts || 5
  );

  const errorText =
    failures
      .map(
        (failure) =>
          `${failure.page}: ${
            typeof failure.error ===
            "string"
              ? failure.error
              : JSON.stringify(
                  failure.error
                )
          }${
            failure.uncertain
              ? " (Facebook publish verification pending)"
              : ""
          }`
      )
      .join(" | ");

  if (
    retryableFailures.length > 0 &&
    attempts < maxAttempts
  ) {
    return updateCloudPost(
      job.id,
      {
        status: "retry",
        facebook_results:
          results,
        facebook_post_ids:
          postIds,
        next_attempt_at:
          new Date(
            Date.now() +
              PUBLISH_RETRY_DELAY_MS
          ).toISOString(),
        worker_id: null,
        claimed_at: null,
        last_error:
          errorText,
      }
    );
  }

  return updateCloudPost(
    job.id,
    {
      status:
        successes.length > 0
          ? "partial"
          : "failed",
      facebook_results:
        results,
      facebook_post_ids:
        postIds,
      next_attempt_at: null,
      worker_id: null,
      claimed_at: null,
      last_error:
        errorText,
    }
  );
}

async function recoverStaleCloudClaims() {
  const supabase = getSupabase();

  const staleBefore =
    new Date(
      Date.now() -
        PUBLISH_STALE_MS
    ).toISOString();

  const { error } =
    await supabase.rpc(
      "recover_stale_cloud_posts",
      {
        p_stale_before:
          staleBefore,
      }
    );

  if (error) {
    throw new Error(
      `Unable to recover stale cloud publisher jobs: ${error.message}`
    );
  }
}

async function claimCloudPostForNativeScheduling(
  workerId
) {
  const supabase = getSupabase();

  const { data, error } =
    await supabase.rpc(
      "claim_native_schedule_cloud_post",
      {
        p_worker_id:
          workerId,
      }
    );

  if (error) {
    throw new Error(
      `Unable to claim cloud post for native scheduling/verification: ${error.message}`
    );
  }

  if (
    !Array.isArray(data) ||
    data.length === 0
  ) {
    return null;
  }

  return data[0];
}

export async function runDueCloudPublisher({
  maxJobs = 5,
} = {}) {
  if (!shouldRunCloudPublisher()) {
    return {
      skipped: true,
      reason:
        "APP_ROLE is not publisher or Supabase is not configured.",
      processed: 0,
    };
  }

  if (publisherRunning) {
    return {
      skipped: true,
      reason:
        "Cloud publisher is already running.",
      processed: 0,
    };
  }

  publisherRunning = true;

  const workerId =
    `render-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;

  const results = [];

  try {
    await recoverStaleCloudClaims();

    for (
      let index = 0;
      index < maxJobs;
      index += 1
    ) {
      const job =
        await claimCloudPostForNativeScheduling(
          workerId
        );

      if (!job) {
        break;
      }

      try {
        const result =
          await publishClaimedCloudPost(
            job
          );

        results.push({
          id: job.id,
          status:
            result.status,
        });
      } catch (error) {
        const attempts = Number(
          job.attempts || 0
        );

        const maxAttempts = Number(
          job.max_attempts || 5
        );

        const retryable =
          isRetryableFacebookError(
            error
          );

        const status =
          retryable &&
          attempts < maxAttempts
            ? "retry"
            : "failed";

        await updateCloudPost(
          job.id,
          {
            status,
            next_attempt_at:
              status === "retry"
                ? new Date(
                    Date.now() +
                      PUBLISH_RETRY_DELAY_MS
                  ).toISOString()
                : null,
            worker_id: null,
            claimed_at: null,
            last_error:
              error.message ||
              String(error),
          }
        );

        results.push({
          id: job.id,
          status,
          error:
            error.message ||
            String(error),
        });
      }
    }

    return {
      skipped: false,
      processed:
        results.length,
      results,
    };
  } finally {
    publisherRunning = false;
  }
}

export function kickCloudPublisher() {
  if (!shouldRunCloudPublisher()) {
    return;
  }

  void runDueCloudPublisher()
    .then((result) => {
      if (
        result.processed > 0
      ) {
        console.log(
          "Cloud publisher:",
          result.results
        );
      }
    })
    .catch((error) => {
      console.error(
        "Cloud publisher failed:",
        error.message || error
      );
    });
}
