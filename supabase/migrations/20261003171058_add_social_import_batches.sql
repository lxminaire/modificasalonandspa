create table if not exists public.social_import_batches (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  batch_name text,
  source text not null default 'modifica-website',
  source_file_name text not null,
  source_sheet_name text,
  storage_bucket text,
  storage_path text unique,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  file_sha256 text,
  status text not null default 'uploaded'
    check (status in (
      'uploaded',
      'parsing',
      'imported',
      'processing',
      'ready_for_review',
      'completed',
      'failed',
      'cancelled'
    )),
  total_rows integer not null default 0 check (total_rows >= 0),
  imported_rows integer not null default 0 check (imported_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  submitted_by_user_id uuid,
  submitted_by_email text,
  last_error text,
  received_at timestamptz not null default now(),
  parsing_started_at timestamptz,
  parsed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists social_import_batches_status_created_idx
  on public.social_import_batches(status, created_at desc);

create index if not exists social_import_batches_file_sha_idx
  on public.social_import_batches(file_sha256)
  where file_sha256 is not null;

alter table public.social_import_batches enable row level security;
revoke all on table public.social_import_batches from anon, authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'campaign-imports',
  'campaign-imports',
  false,
  5242880,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into public.social_import_batches (
  id,
  idempotency_key,
  batch_name,
  source,
  source_file_name,
  source_sheet_name,
  status,
  total_rows,
  imported_rows,
  submitted_by_user_id,
  submitted_by_email,
  received_at,
  parsed_at,
  created_at,
  updated_at
)
select
  sc.batch_id,
  'legacy:' || sc.batch_id::text,
  max(sc.batch_name),
  max(sc.source),
  coalesce(max(sc.source_file_name), 'legacy-import'),
  max(sc.source_sheet_name),
  'imported',
  count(*)::integer,
  count(*)::integer,
  max(sc.submitted_by_user_id::text)::uuid,
  max(sc.submitted_by_email),
  min(sc.received_at),
  max(sc.processed_at),
  min(sc.created_at),
  max(sc.updated_at)
from public.social_campaigns sc
where not exists (
  select 1
  from public.social_import_batches sib
  where sib.id = sc.batch_id
)
group by sc.batch_id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'social_campaigns_batch_id_fkey'
      and conrelid = 'public.social_campaigns'::regclass
  ) then
    alter table public.social_campaigns
      add constraint social_campaigns_batch_id_fkey
      foreign key (batch_id)
      references public.social_import_batches(id)
      on delete restrict;
  end if;
end
$$;
