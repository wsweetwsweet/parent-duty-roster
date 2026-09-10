-- ============================================================
-- 家長值班排班系統 — Supabase 資料庫初始化
-- 用法：Supabase Dashboard → SQL Editor → New query → 全部貼上 → Run
-- ============================================================

-- 1) 設定 / 學生名單 / 假日（放在同一個 jsonb 文件，整班共用一列）
create table if not exists board_meta (
  id          int primary key default 1,
  doc         jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint board_meta_single_row check (id = 1)
);

insert into board_meta (id, doc) values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- 2) 班表：一格一列，避免多人同時編輯互相覆蓋
create table if not exists shifts (
  d           date not null,
  period      text not null,          -- 'p9' 第九節 / 'night' 晚自習
  slot_idx    int  not null default 0,-- 同一時段需要多位家長時的第幾位
  student_id  text,                   -- 對應學生 id；null = 尚未安排
  locked      boolean not null default false, -- 鎖定後自動排班不會動它
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (d, period, slot_idx)
);

create index if not exists shifts_d_idx on shifts (d);

-- 3) 開啟即時同步（Realtime）
alter table board_meta replica identity full;
alter table shifts     replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table board_meta;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table shifts;
  exception when duplicate_object then null;
  end;
end $$;

-- 4) 權限
-- 本系統設計為「不需登入，家長進來選自己名字」，
-- 因此使用 anon key 直接讀寫。任何拿到網址的人都能修改班表。
-- 這對班級內部使用通常可接受；若需要更嚴格，請改用 Supabase Auth。
alter table board_meta enable row level security;
alter table shifts     enable row level security;

drop policy if exists "anon full access board_meta" on board_meta;
create policy "anon full access board_meta" on board_meta
  for all to anon using (true) with check (true);

drop policy if exists "anon full access shifts" on shifts;
create policy "anon full access shifts" on shifts
  for all to anon using (true) with check (true);

-- 完成。回到 Settings → API 複製 Project URL 與 anon public key。
