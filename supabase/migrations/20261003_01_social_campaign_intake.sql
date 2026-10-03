create table if not exists public.social_campaigns (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  batch_name text,
  idempotency_key text not null unique,
  source text not null default 'modifica-website',
  source_file_name text,
  source_sheet_name text,
  source_row_number integer,
  business text not null default 'Modifica Salon & Spa',
  entity_type text not null default 'service'
    check (entity_type in ('service','product','generic')),
  entity_id text,
  entity_name text not null,
  category text,
  price text,
  description text,
  campaign_type text,
  promotion text,
  audience text,
  tone text,
  branch text,
  cta text,
  image_urls jsonb not null default '[]'::jsonb,
  requested_publish_at timestamptz,
  timezone text not null default 'Asia/Manila',
  caption_draft text,
  generated_caption text,
  edited_caption text,
  ai_context jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  status text not null default 'received'
    check (status in (
      'received',
      'processing',
      'ready_for_review',
      'approved',
      'queued',
      'scheduled',
      'published',
      'failed',
      'cancelled'
    )),
  cloud_post_id uuid references public.cloud_posts(id) on delete set null,
  submitted_by_user_id uuid,
  submitted_by_email text,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  approved_at timestamptz,
  queued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists social_campaigns_status_created_idx
  on public.social_campaigns(status, created_at desc);

create index if not exists social_campaigns_requested_publish_idx
  on public.social_campaigns(requested_publish_at)
  where requested_publish_at is not null;

create index if not exists social_campaigns_batch_idx
  on public.social_campaigns(batch_id);

create index if not exists social_campaigns_cloud_post_idx
  on public.social_campaigns(cloud_post_id)
  where cloud_post_id is not null;

alter table public.social_campaigns enable row level security;
revoke all on table public.social_campaigns from anon, authenticated;
