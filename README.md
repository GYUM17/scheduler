# Online Ministry Team Meeting Grid

온라인 사역팀 전용 회의시간 조율 웹앱입니다.

- 드래그로 시간표 체크
- 가능한 시간만 체크
- 터치 입력 모드(토글/체크/지우기) 지원
- 모바일 가로 스와이프 시 오입력 방지(수직 제스처에서만 드래그 입력 시작)
- 본인 데이터만 편집 가능
- 팀 전체 공통 가능 시간 자동 계산
- 실시간 동기화(여러 명 동시 접속)
- 시간 범위: `16:00 ~ 00:00`
- 주간 초기화: 매주 일요일 `00:00 (KST)` 기준

## 1. Supabase 준비

1. Supabase 프로젝트 생성
2. `Authentication > Providers`에서 `Anonymous` 활성화
3. `SQL Editor`에서 아래 SQL 실행

```sql
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_code text not null,
  user_id uuid not null,
  display_name text not null,
  mode text not null check (mode in ('available', 'unavailable')),
  cells jsonb not null default '{}'::jsonb,
  last_editor text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (team_code, user_id)
);

alter table public.team_members enable row level security;

create policy "team_members_select"
on public.team_members
for select
to authenticated
using (team_code = 'online-ministry-team');

create policy "team_members_insert_own"
on public.team_members
for insert
to authenticated
with check (
  team_code = 'online-ministry-team'
  and auth.uid() = user_id
);

create policy "team_members_update_own"
on public.team_members
for update
to authenticated
using (
  team_code = 'online-ministry-team'
  and auth.uid() = user_id
)
with check (
  team_code = 'online-ministry-team'
  and auth.uid() = user_id
);

create policy "team_members_delete_own"
on public.team_members
for delete
to authenticated
using (
  team_code = 'online-ministry-team'
  and auth.uid() = user_id
);

create or replace function public.reset_team_members(
  p_team_code text,
  p_editor_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_team_code <> 'online-ministry-team' then
    raise exception 'invalid team code';
  end if;

  update public.team_members
  set
    cells = '{}'::jsonb,
    mode = 'available',
    last_editor = coalesce(nullif(trim(p_editor_name), ''), 'system'),
    updated_at = now()
  where team_code = p_team_code;
end;
$$;

revoke all on function public.reset_team_members(text, text) from public;
grant execute on function public.reset_team_members(text, text) to authenticated;

create or replace function public.delete_all_team_members(
  p_team_code text,
  p_editor_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_team_code <> 'online-ministry-team' then
    raise exception 'invalid team code';
  end if;

  delete from public.team_members
  where team_code = p_team_code;
end;
$$;

revoke all on function public.delete_all_team_members(text, text) from public;
grant execute on function public.delete_all_team_members(text, text) to authenticated;
```

## 2. 환경변수 설정

프로젝트 루트에서 `.env.example`을 복사해 `.env.local` 생성:

```bash
cp .env.example .env.local
```

그다음 값 입력:

```bash
NEXT_PUBLIC_SUPABASE_URL=YOUR_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

## 3. 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

## 4. 동작 방식

- 접속 시 익명 로그인으로 사용자 식별
- 첫 접속 시 이름 입력 후 사용 시작
- 첫 접속 모달에서 보기 전용으로 입장 가능(사용자 행 미생성)
- 사용자 1명당 `team_members`에 1개 행 생성
- 본인 행(`auth.uid() = user_id`)만 수정 가능
- 다른 사람 수정사항은 Realtime으로 즉시 반영
- 멤버 카드에 최근 수정 시각/편집자 표시
- 일요일 00:00(KST) 이전 데이터는 자동으로 초기화(빈 시간표) 처리
- `전체 초기화` 버튼은 경고 확인 후 팀 전체 시간표를 초기화
- `전체 사용자 삭제` 버튼은 경고 확인 후 팀 전체 사용자/시간표를 삭제

## 5. 멀티탭 검증

1. 일반 창과 시크릿 창에서 각각 접속
2. 두 창에서 서로 다른 이름 저장
3. A 창에서 시간표 드래그 수정
4. B 창에서 1초 이내 반영되는지 확인
5. B 창에서 A 사용자 행 수정 시 읽기 전용인지 확인
