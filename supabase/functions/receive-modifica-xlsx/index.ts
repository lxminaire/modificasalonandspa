import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import ExcelJS from "npm:exceljs@4.4.0";

const WEBSITE_URL = "https://kqumdpovvxnspnkzzvae.supabase.co";
const WEBSITE_PUBLISHABLE_KEY =
  "sb_publishable_yqzLXNLxK9CaTG-AnCHDAg_nnbR4upu";
const IMPORT_BUCKET = "campaign-imports";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SheetRow = {
  rowNumber: number;
  values: Record<string, string>;
};

type ServiceMeta = {
  name: string;
  category: string;
  categoryLabel: string;
  price: string;
  description: string;
  imageUrl: string;
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

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHeader(value: string, index: number) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return normalized || "column_" + String(index + 1);
}

function dedupeHeaders(headers: string[]) {
  const counts = new Map<string, number>();

  return headers.map((header) => {
    const count = counts.get(header) ?? 0;
    counts.set(header, count + 1);
    return count === 0 ? header : header + "_" + String(count + 1);
  });
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function excelSerialToDate(serial: number) {
  if (!Number.isFinite(serial)) return null;
  const milliseconds = Math.round((serial - 25569) * 86_400_000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date: Date) {
  return (
    String(date.getUTCFullYear()) +
    "-" +
    pad2(date.getUTCMonth() + 1) +
    "-" +
    pad2(date.getUTCDate())
  );
}

function formatTime(hours: number, minutes: number) {
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return "";
  }

  return pad2(hours) + ":" + pad2(minutes);
}

function normalizeDateText(value: string) {
  const text = value.trim();
  if (!text) return "";

  const canonical = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (canonical) {
    return (
      canonical[1] +
      "-" +
      pad2(Number(canonical[2])) +
      "-" +
      pad2(Number(canonical[3]))
    );
  }

  const slashDate = text.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+.*)?$/,
  );
  if (slashDate) {
    return (
      slashDate[3] +
      "-" +
      pad2(Number(slashDate[1])) +
      "-" +
      pad2(Number(slashDate[2]))
    );
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1) {
    const date = excelSerialToDate(numeric);
    return date ? formatDate(date) : text;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : formatDate(parsed);
}

function normalizeTimeText(value: string) {
  const text = value.trim();
  if (!text) return "";

  const twentyFourHour = text.match(
    /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/,
  );
  if (twentyFourHour) {
    return formatTime(
      Number(twentyFourHour[1]),
      Number(twentyFourHour[2]),
    );
  }

  const twelveHour = text.match(
    /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM)$/i,
  );
  if (twelveHour) {
    let hours = Number(twelveHour[1]);
    const minutes = Number(twelveHour[2]);
    const meridiem = twelveHour[3].toUpperCase();

    if (hours >= 1 && hours <= 12) {
      if (hours === 12) hours = 0;
      if (meridiem === "PM") hours += 12;
      return formatTime(hours, minutes);
    }
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 0) {
    const fraction = ((numeric % 1) + 1) % 1;
    const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
    return formatTime(
      Math.floor(totalMinutes / 60),
      totalMinutes % 60,
    );
  }

  const isoTime = text.match(/T(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (isoTime) {
    return formatTime(Number(isoTime[1]), Number(isoTime[2]));
  }

  return text;
}

function cellResultValue(cell: ExcelJS.Cell) {
  const value = cell.value;

  if (
    value &&
    typeof value === "object" &&
    "result" in value &&
    (value as { result?: unknown }).result !== undefined
  ) {
    return (value as { result?: unknown }).result;
  }

  return value;
}

function normalizeCell(cell: ExcelJS.Cell, header: string) {
  const value = cellResultValue(cell);
  const isDateColumn = [
    "schedule_date",
    "date",
    "post_date",
    "publish_date",
  ].includes(header);
  const isTimeColumn = [
    "schedule_time",
    "time",
    "post_time",
    "publish_time",
  ].includes(header);

  if (isDateColumn) {
    if (value instanceof Date) return formatDate(value);
    if (typeof value === "number") {
      const date = excelSerialToDate(value);
      return date ? formatDate(date) : "";
    }
    return normalizeDateText(
      cell.text?.trim?.() ?? String(value ?? "").trim(),
    );
  }

  if (isTimeColumn) {
    if (value instanceof Date) {
      return formatTime(value.getUTCHours(), value.getUTCMinutes());
    }
    if (typeof value === "number") {
      const fraction = ((value % 1) + 1) % 1;
      const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
      return formatTime(
        Math.floor(totalMinutes / 60),
        totalMinutes % 60,
      );
    }
    return normalizeTimeText(
      cell.text?.trim?.() ?? String(value ?? "").trim(),
    );
  }

  return cell.text?.trim?.() ?? String(value ?? "").trim();
}

function readSheet(worksheet: ExcelJS.Worksheet) {
  const headerRow = worksheet.getRow(1);
  const width = Math.max(worksheet.columnCount, headerRow.actualCellCount);
  const headers = dedupeHeaders(
    Array.from({ length: width }, (_, index) =>
      normalizeHeader(
        headerRow.getCell(index + 1).text?.trim?.() ??
          String(headerRow.getCell(index + 1).value ?? "").trim(),
        index,
      ),
    ),
  );

  const rows: SheetRow[] = [];

  for (
    let rowNumber = 2;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    const values: Record<string, string> = {};

    headers.forEach((header, index) => {
      values[header] = normalizeCell(row.getCell(index + 1), header);
    });

    if (Object.values(values).some((value) => value.length > 0)) {
      rows.push({ rowNumber, values });
    }
  }

  return { headers, rows };
}

function readAlias(
  row: Record<string, string>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const value = clean(row[key]);
    if (value) return value;
  }

  return "";
}

async function sha256(value: Uint8Array | string) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseApprovedRows(value: unknown) {
  const text = clean(value);
  if (!text) return [] as number[];

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("approvedRowNumbers must be a JSON array.");
  }

  return Array.from(
    new Set(
      parsed
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 2),
    ),
  ).sort((left, right) => left - right);
}

function parseRequestedPublishAt(date: string, time: string) {
  if (!date && !time) return null;
  if (!date || !time) {
    throw new Error("Schedule date and time must be supplied together.");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid schedule date: " + date);
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Invalid schedule time: " + time);
  }

  const parsed = new Date(date + "T" + time + ":00+08:00");
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid requested publish time.");
  }

  return parsed.toISOString();
}

function safeFileName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return normalized || "campaign-import.xlsx";
}

function chunk<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function verifyWebsiteOwner(authorization: string) {
  const userResponse = await fetch(WEBSITE_URL + "/auth/v1/user", {
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
    WEBSITE_URL +
      "/rest/v1/site_admins?select=user_id&user_id=eq." +
      encodeURIComponent(user.id) +
      "&limit=1",
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

  const rows = (await adminResponse.json()) as Array<{ user_id: string }>;
  if (rows.length === 0) {
    throw new Error("Owner access is required.");
  }

  return {
    id: user.id,
    email: user.email || "",
  };
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

  const socialUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!socialUrl || !serviceRoleKey) {
    return json({ error: "Modifica Social backend is not configured" }, 500);
  }

  try {
    const owner = await verifyWebsiteOwner(authorization);
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return json({ error: "An XLSX file is required." }, 400);
    }

    const fileName =
      clean(form.get("fileName")) || file.name || "campaign-import.xlsx";
    if (!fileName.toLowerCase().endsWith(".xlsx")) {
      return json({ error: "Only .xlsx campaign files are supported." }, 400);
    }

    if (file.size <= 0) {
      return json({ error: "The uploaded XLSX is empty." }, 400);
    }

    if (file.size > MAX_FILE_BYTES) {
      return json({ error: "The XLSX must be 5 MB or smaller." }, 413);
    }

    const approvedRowNumbers = parseApprovedRows(
      form.get("approvedRowNumbers"),
    );
    const approvedSet = new Set(approvedRowNumbers);
    const batchName =
      clean(form.get("batchName")) || fileName;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileHash = await sha256(bytes);
    const selectionHash = await sha256(
      approvedRowNumbers.length > 0
        ? approvedRowNumbers.join(",")
        : "all-rows",
    );
    const idempotencyKey =
      "modifica-website-xlsx:" +
      owner.id +
      ":" +
      fileHash +
      ":" +
      selectionHash;

    const social = createClient(socialUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: existing, error: existingError } = await social
      .from("social_import_batches")
      .select(
        "id,batch_name,source_file_name,status,total_rows,imported_rows,failed_rows,received_at,parsed_at,last_error",
      )
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (existing) {
      return json({
        outcome: "duplicate",
        batchId: existing.id,
        batchName: existing.batch_name,
        fileName: existing.source_file_name,
        status: existing.status,
        totalRows: existing.total_rows,
        importedRows: existing.imported_rows,
        failedRows: existing.failed_rows,
        receivedAt: existing.received_at,
        parsedAt: existing.parsed_at,
        lastError: existing.last_error,
      });
    }

    const batchId = crypto.randomUUID();
    const now = new Date();
    const storagePath =
      "website-imports/" +
      String(now.getUTCFullYear()) +
      "/" +
      pad2(now.getUTCMonth() + 1) +
      "/" +
      batchId +
      "/" +
      safeFileName(fileName);
    const contentType =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const { error: uploadError } = await social.storage
      .from(IMPORT_BUCKET)
      .upload(storagePath, bytes, {
        contentType,
        upsert: false,
      });

    if (uploadError) {
      throw new Error("Unable to store the XLSX: " + uploadError.message);
    }

    const receivedAt = new Date().toISOString();
    const { error: batchInsertError } = await social
      .from("social_import_batches")
      .insert({
        id: batchId,
        idempotency_key: idempotencyKey,
        batch_name: batchName,
        source: "modifica-website",
        source_file_name: fileName,
        storage_bucket: IMPORT_BUCKET,
        storage_path: storagePath,
        mime_type: contentType,
        file_size: bytes.byteLength,
        file_sha256: fileHash,
        status: "parsing",
        submitted_by_user_id: owner.id,
        submitted_by_email: owner.email || null,
        received_at: receivedAt,
        parsing_started_at: receivedAt,
      });

    if (batchInsertError) {
      await social.storage
        .from(IMPORT_BUCKET)
        .remove([storagePath])
        .catch(() => undefined);
      throw new Error(batchInsertError.message);
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);

      const campaignSheet =
        workbook.getWorksheet("Campaign Plan") ||
        workbook.worksheets.find((sheet) => sheet.state === "visible") ||
        workbook.worksheets[0];

      if (!campaignSheet) {
        throw new Error("No campaign worksheet was found.");
      }

      const campaignData = readSheet(campaignSheet);
      if (campaignData.rows.length === 0) {
        throw new Error("No campaign rows were found.");
      }

      const selectedRows =
        approvedSet.size > 0
          ? campaignData.rows.filter((row) => approvedSet.has(row.rowNumber))
          : campaignData.rows;

      if (selectedRows.length === 0) {
        throw new Error("None of the approved rows exist in the XLSX.");
      }

      if (selectedRows.length > MAX_ROWS) {
        throw new Error(
          "Submit at most " + String(MAX_ROWS) + " campaign rows per batch.",
        );
      }

      const cmsSheet = workbook.getWorksheet("CMS Lists");
      const serviceIndex = new Map<string, ServiceMeta>();

      if (cmsSheet) {
        const cmsData = readSheet(cmsSheet);

        for (const row of cmsData.rows) {
          const name = readAlias(row.values, [
            "service_name",
            "service",
            "name",
          ]);

          if (!name) continue;

          serviceIndex.set(normalizeText(name), {
            name,
            category: readAlias(row.values, ["category"]),
            categoryLabel: readAlias(row.values, ["category_label"]),
            price: readAlias(row.values, ["price"]),
            description: readAlias(row.values, ["description"]),
            imageUrl: readAlias(row.values, ["image_url", "image"]),
          });
        }
      }

      const campaignRows: Record<string, unknown>[] = [];
      const rowErrors: Array<{ rowNumber: number; error: string }> = [];

      for (const row of selectedRows) {
        try {
          const serviceName = readAlias(row.values, [
            "service_name",
            "service",
            "name",
            "service_title",
          ]);

          if (!serviceName) {
            throw new Error("Missing service_name.");
          }

          const service =
            serviceIndex.get(normalizeText(serviceName)) || null;
          const campaignType =
            readAlias(row.values, [
              "campaign_type",
              "type",
              "post_type",
              "campaign",
            ]) || "Service Promotion";
          const promotion = readAlias(row.values, [
            "promotion",
            "promo",
            "offer",
            "campaign_name",
          ]);
          const audience = readAlias(row.values, [
            "target_audience",
            "audience",
            "target",
            "customer",
          ]);
          const tone =
            readAlias(row.values, ["tone", "voice", "brand_tone"]) ||
            "Warm, polished, and approachable";
          const branch =
            readAlias(row.values, ["branch", "location"]) || "Both";
          const cta =
            readAlias(row.values, [
              "cta",
              "call_to_action",
              "action",
            ]) || "Book your appointment";
          const scheduleDate = readAlias(row.values, [
            "schedule_date",
            "date",
            "post_date",
            "publish_date",
          ]);
          const scheduleTime = readAlias(row.values, [
            "schedule_time",
            "time",
            "post_time",
            "publish_time",
          ]);
          const requestedPublishAt = parseRequestedPublishAt(
            scheduleDate,
            scheduleTime,
          );
          const category =
            service?.category ||
            readAlias(row.values, ["category", "service_category"]);
          const price =
            service?.price ||
            readAlias(row.values, ["price", "price_label"]);
          const description =
            service?.description ||
            readAlias(row.values, [
              "description",
              "details",
              "service_description",
            ]);

          const images = [
            readAlias(row.values, [
              "image_1",
              "image",
              "image_url",
              "photo",
              "photo_1",
            ]),
            readAlias(row.values, [
              "image_2",
              "image_url_2",
              "photo_2",
            ]),
            readAlias(row.values, [
              "image_3",
              "image_url_3",
              "photo_3",
            ]),
          ].filter(Boolean);

          if (images.length === 0 && service?.imageUrl) {
            images.push(service.imageUrl);
          }

          const rowIdempotencyKey =
            "modifica-xlsx:" +
            batchId +
            ":row:" +
            String(row.rowNumber);

          campaignRows.push({
            batch_id: batchId,
            batch_name: batchName,
            idempotency_key: rowIdempotencyKey,
            source: "modifica-website-xlsx",
            source_file_name: fileName,
            source_sheet_name: campaignSheet.name,
            source_row_number: row.rowNumber,
            business: "Modifica Salon & Spa",
            entity_type: "service",
            entity_name: service?.name || serviceName,
            category: category || null,
            price: price || null,
            description: description || null,
            campaign_type: campaignType || null,
            promotion: promotion || null,
            audience: audience || null,
            tone: tone || null,
            branch: branch || null,
            cta: cta || null,
            image_urls: images.slice(0, 10),
            requested_publish_at: requestedPublishAt,
            timezone: "Asia/Manila",
            caption_draft: null,
            ai_context: {
              brand: "Modifica Salon & Spa",
              category,
              service: service?.name || serviceName,
              price,
              description,
              audience,
              tone,
              objective: promotion
                ? "Promote " + promotion + " and encourage appointment bookings"
                : "Introduce the service and encourage appointment bookings",
              cta,
            },
            raw_payload: row.values,
            status: "received",
            submitted_by_user_id: owner.id,
            submitted_by_email: owner.email || null,
          });
        } catch (error) {
          rowErrors.push({
            rowNumber: row.rowNumber,
            error:
              error instanceof Error
                ? error.message
                : "Unable to normalize row.",
          });
        }
      }

      if (campaignRows.length === 0) {
        throw new Error(
          rowErrors[0]?.error || "No valid campaign rows could be imported.",
        );
      }

      const { data: inserted, error: insertError } = await social
        .from("social_campaigns")
        .insert(campaignRows)
        .select("id,source_row_number,status");

      if (insertError) {
        throw new Error(insertError.message);
      }

      const campaignIds = (inserted || []).map((row) => row.id);
      const geminiConfigured = Boolean(
        clean(Deno.env.get("GEMINI_API_KEY")),
      );
      const parsedAt = new Date().toISOString();

      const { error: batchUpdateError } = await social
        .from("social_import_batches")
        .update({
          source_sheet_name: campaignSheet.name,
          status: geminiConfigured ? "processing" : "imported",
          total_rows: selectedRows.length,
          imported_rows: campaignRows.length,
          failed_rows: rowErrors.length,
          parsed_at: parsedAt,
          last_error:
            rowErrors.length > 0
              ? String(rowErrors.length) + " row(s) failed validation."
              : null,
          updated_at: parsedAt,
        })
        .eq("id", batchId);

      if (batchUpdateError) {
        throw new Error(batchUpdateError.message);
      }

      if (geminiConfigured && campaignIds.length > 0) {
        const processUrl =
          socialUrl + "/functions/v1/process-social-campaigns";
        const tasks = chunk(campaignIds, 20).map((campaignIdChunk) =>
          fetch(processUrl, {
            method: "POST",
            headers: {
              Authorization: "Bearer " + serviceRoleKey,
              apikey: serviceRoleKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              campaignIds: campaignIdChunk,
            }),
          }).catch((error) => {
            console.error(
              "Unable to start AI processing for campaign chunk:",
              error,
            );
          }),
        );

        EdgeRuntime.waitUntil(Promise.all(tasks));
      }

      return json({
        outcome: "received",
        batchId,
        batchName,
        fileName,
        storagePath,
        sheetName: campaignSheet.name,
        selectedRows: selectedRows.length,
        importedRows: campaignRows.length,
        failedRows: rowErrors.length,
        rowErrors,
        aiProcessing: {
          configured: geminiConfigured,
          started: geminiConfigured && campaignIds.length > 0,
          campaignCount: campaignIds.length,
        },
        campaigns: inserted || [],
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to process campaign XLSX.";

      await social
        .from("social_import_batches")
        .update({
          status: "failed",
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", batchId);

      return json(
        {
          error: message,
          batchId,
          fileName,
        },
        400,
      );
    }
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to receive campaign XLSX.",
      },
      403,
    );
  }
});
