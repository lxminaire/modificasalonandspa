alter table public.social_campaigns
  add column if not exists ai_provider text,
  add column if not exists ai_model text,
  add column if not exists generation_attempts integer not null default 0,
  add column if not exists processing_started_at timestamptz,
  add column if not exists generated_at timestamptz;

create index if not exists social_campaigns_processing_idx
  on public.social_campaigns(status, processing_started_at)
  where status in ('received','processing','failed');

create or replace function public.claim_social_campaign_for_processing(
  p_campaign_id uuid
)
returns setof public.social_campaigns
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.social_campaigns
  set
    status = 'processing',
    generation_attempts = generation_attempts + 1,
    processing_started_at = now(),
    last_error = null,
    updated_at = now()
  where id = p_campaign_id
    and status in ('received', 'failed')
  returning *;
end;
$$;

revoke all on function public.claim_social_campaign_for_processing(uuid)
  from public, anon, authenticated;
