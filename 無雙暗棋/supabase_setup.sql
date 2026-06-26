-- =====================================================================
-- 無雙暗棋 — 測試碼 / 設備綁定系統  Supabase 一次性建置腳本
-- ---------------------------------------------------------------------
-- 使用方式：
--   1. 到 https://supabase.com 註冊並新建一個免費 Project
--   2. 左側選單 → SQL Editor → New query
--   3. 把本檔全部內容貼上 → 按 Run
--   4. 完成後到 Project Settings → API 取得：
--        - Project URL              → 填入 game.js 的 SUPABASE_URL
--        - Project API keys 的 anon  → 填入 game.js 的 SUPABASE_ANON_KEY
--
-- 安全說明：
--   - 兩張表都開啟 RLS 且「不設任何政策」→ 前端（anon key）無法直接讀寫，
--     100 組碼不會外洩。
--   - 所有存取一律透過下方 SECURITY DEFINER 函式進行，邏輯在資料庫端把關。
-- =====================================================================

-- ---------- 資料表 ----------
create table if not exists public.access_codes (
    code       text primary key,
    device_id  text,
    bound_at   timestamptz
);

create table if not exists public.app_config (
    key   text primary key,
    value text
);

-- 預設測試員密碼（可日後在管理頁修改）
insert into public.app_config (key, value)
values ('tester_password', 'PHIL59')
on conflict (key) do nothing;

-- ---------- 開啟 RLS（不加政策 = 前端無法直接存取） ----------
alter table public.access_codes enable row level security;
alter table public.app_config  enable row level security;

-- ---------- 產生 100 組隨機碼（6 位、英數、排除易混淆字元 0 O 1 I L） ----------
do $$
declare
    alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    c text;
    i int;
begin
    -- 僅在尚未有資料時才灌入，避免重複執行洗掉既有綁定
    if (select count(*) from public.access_codes) = 0 then
        while (select count(*) from public.access_codes) < 100 loop
            c := '';
            for i in 1..6 loop
                c := c || substr(alphabet, floor(random() * length(alphabet))::int + 1, 1);
            end loop;
            begin
                insert into public.access_codes(code) values (c);
            exception when unique_violation then
                -- 撞碼則略過，重抽
            end;
        end loop;
    end if;
end $$;

-- ---------- 函式：驗證 + 綁定（玩家進入時呼叫） ----------
create or replace function public.redeem_code(p_code text, p_device text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tester text;
    v_device text;
    v_norm   text := upper(btrim(p_code));
begin
    select value into v_tester from app_config where key = 'tester_password';

    -- 測試員密碼：直接放行，不檢查設備
    if v_tester is not null and v_norm = upper(btrim(v_tester)) then
        return json_build_object('status', 'tester');
    end if;

    select device_id into v_device from access_codes where code = v_norm;
    if not found then
        return json_build_object('status', 'invalid');
    end if;

    if v_device is null then
        -- 原子綁定：只在仍未綁定時才寫入
        update access_codes
           set device_id = p_device, bound_at = now()
         where code = v_norm and device_id is null;
        if found then
            return json_build_object('status', 'ok', 'bound', true);
        else
            -- 競態：剛好被別處綁走，重新判斷
            select device_id into v_device from access_codes where code = v_norm;
            if v_device = p_device then
                return json_build_object('status', 'ok', 'bound', false);
            else
                return json_build_object('status', 'device_mismatch');
            end if;
        end if;
    elsif v_device = p_device then
        return json_build_object('status', 'ok', 'bound', false);
    else
        return json_build_object('status', 'device_mismatch');
    end if;
end $$;

-- ---------- 函式：管理頁讀取（需測試員密碼） ----------
create or replace function public.admin_data(p_password text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tester text;
begin
    select value into v_tester from app_config where key = 'tester_password';
    if v_tester is null or upper(btrim(p_password)) <> upper(btrim(v_tester)) then
        return json_build_object('error', 'auth');
    end if;

    return json_build_object(
        'tester_password', v_tester,
        'codes', (
            select coalesce(json_agg(
                json_build_object('code', code, 'device_id', device_id, 'bound_at', bound_at)
                order by code
            ), '[]'::json)
            from access_codes
        )
    );
end $$;

-- ---------- 函式：修改測試員密碼（需舊密碼） ----------
create or replace function public.admin_set_tester(p_old text, p_new text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tester text;
begin
    select value into v_tester from app_config where key = 'tester_password';
    if v_tester is null or upper(btrim(p_old)) <> upper(btrim(v_tester)) then
        return json_build_object('error', 'auth');
    end if;
    if btrim(p_new) = '' then
        return json_build_object('error', 'empty');
    end if;

    update app_config set value = btrim(p_new) where key = 'tester_password';
    return json_build_object('status', 'ok', 'tester_password', btrim(p_new));
end $$;

-- ---------- 函式：解除某組碼的綁定（需測試員密碼） ----------
create or replace function public.admin_unbind(p_password text, p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tester text;
begin
    select value into v_tester from app_config where key = 'tester_password';
    if v_tester is null or upper(btrim(p_password)) <> upper(btrim(v_tester)) then
        return json_build_object('error', 'auth');
    end if;

    update access_codes
       set device_id = null, bound_at = null
     where code = upper(btrim(p_code));
    return json_build_object('status', 'ok');
end $$;

-- ---------- 授權前端（anon）只能呼叫上述函式 ----------
grant execute on function public.redeem_code(text, text)     to anon, authenticated;
grant execute on function public.admin_data(text)            to anon, authenticated;
grant execute on function public.admin_set_tester(text, text) to anon, authenticated;
grant execute on function public.admin_unbind(text, text)    to anon, authenticated;

-- 完成。可執行下列查詢檢視產生的 100 組碼：
--   select code, device_id, bound_at from public.access_codes order by code;
