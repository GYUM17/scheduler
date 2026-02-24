"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TeamMember = {
  id: string;
  team_code: string;
  user_id: string;
  display_name: string;
  cells: Record<string, true>;
  updated_at: string | null;
  last_editor: string | null;
  is_stale: boolean;
  is_legacy_unavailable_mode: boolean;
};

type DrawingState = {
  active: boolean;
  value: boolean;
};

type TimeBlock = {
  day: number;
  startSlot: number;
  endSlot: number;
  minutes: number;
};

const TEAM_CODE = "online-ministry-team";
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const DISPLAY_DAY_ORDER = [6, 0, 1, 2, 3, 4, 5];
const START_HOUR = 16;
const END_HOUR = 24;
const SLOT_MINUTES = 30;
const SLOT_COUNT = ((END_HOUR - START_HOUR) * 60) / SLOT_MINUTES;
const DURATION_OPTIONS = [30, 60, 90, 120];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEK_START_DAY = 0;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const HAS_SUPABASE_ENV = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let cachedClient: SupabaseClient | null | undefined;

function getSupabaseClient(): SupabaseClient | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  if (!HAS_SUPABASE_ENV) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  return cachedClient;
}

function keyFor(day: number, slot: number): string {
  return `${day}-${slot}`;
}

function slotToTime(slot: number): string {
  const total = (START_HOUR * 60 + slot * SLOT_MINUTES) % (24 * 60);
  const hour = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const min = (total % 60).toString().padStart(2, "0");
  return `${hour}:${min}`;
}

function getKstWeekStartMs(date = new Date()): number {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  const dayOfWeek = shifted.getUTCDay();
  const diff = (dayOfWeek - WEEK_START_DAY + 7) % 7;
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - diff);
  return shifted.getTime() - KST_OFFSET_MS;
}

function isStaleWeek(updatedAt: string | null, weekStartMs: number): boolean {
  if (!updatedAt) {
    return true;
  }

  const ms = new Date(updatedAt).getTime();
  if (Number.isNaN(ms)) {
    return true;
  }

  return ms < weekStartMs;
}

function sanitizeCells(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, true> = {};
  for (const [key, marked] of Object.entries(value)) {
    if (marked) {
      result[key] = true;
    }
  }

  return result;
}

function toMember(row: unknown): TeamMember {
  const data = (row ?? {}) as Record<string, unknown>;
  const legacyUnavailable = data.mode === "unavailable";

  return {
    id: typeof data.id === "string" ? data.id : "",
    team_code: typeof data.team_code === "string" ? data.team_code : TEAM_CODE,
    user_id: typeof data.user_id === "string" ? data.user_id : "",
    display_name: typeof data.display_name === "string" ? data.display_name : "이름 미지정",
    cells: legacyUnavailable ? {} : sanitizeCells(data.cells),
    updated_at: typeof data.updated_at === "string" ? data.updated_at : null,
    last_editor: typeof data.last_editor === "string" ? data.last_editor : null,
    is_stale: false,
    is_legacy_unavailable_mode: legacyUnavailable,
  };
}

function isAvailable(member: TeamMember, key: string): boolean {
  return Boolean(member.cells[key]);
}

function classForCell(
  marked: boolean,
  common: boolean,
  availabilityRatio: number,
): string {
  if (common) {
    return "bg-emerald-300/70 hover:bg-emerald-300";
  }

  if (marked) {
    return "bg-sky-300/80 hover:bg-sky-300";
  }

  if (availabilityRatio > 0.66) {
    return "bg-emerald-100/65 hover:bg-emerald-100";
  }

  if (availabilityRatio > 0.33) {
    return "bg-amber-100/60 hover:bg-amber-100";
  }

  return "bg-white/90 hover:bg-slate-100";
}

function sameCells(left: Record<string, true>, right: Record<string, true>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (!right[key]) {
      return false;
    }
  }

  return true;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "기록 없음";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "기록 없음";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

export default function Home() {
  const client = useMemo(() => getSupabaseClient(), []);
  const [userId, setUserId] = useState("");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [minimumDuration, setMinimumDuration] = useState(60);
  const [currentWeekStartMs, setCurrentWeekStartMs] = useState(() => getKstWeekStartMs());
  const [displayNameInput, setDisplayNameInput] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem("meet-display-name") ?? "";
  });
  const [draftCells, setDraftCells] = useState<Record<string, true>>({});
  const [drawing, setDrawing] = useState<DrawingState>({ active: false, value: true });
  const [isRealtimeSubscribed, setIsRealtimeSubscribed] = useState(false);
  const [needsNameSetup, setNeedsNameSetup] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    HAS_SUPABASE_ENV
      ? "인증 상태 확인 중..."
      : "Supabase 환경변수(NEXT_PUBLIC_SUPABASE_URL/ANON_KEY)를 설정해주세요.",
  );
  const draftCellsRef = useRef<Record<string, true>>({});

  useEffect(() => {
    draftCellsRef.current = draftCells;
  }, [draftCells]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCurrentWeekStartMs((prev) => {
        const next = getKstWeekStartMs();
        return next === prev ? prev : next;
      });
    }, 60 * 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!client) {
      return;
    }

    let ignore = false;

    const bootstrap = async () => {
      const { data, error } = await client.auth.getUser();
      if (ignore) {
        return;
      }

      const isMissingSessionError = error?.message
        ?.toLowerCase()
        .includes("auth session missing");
      if (error?.message && !isMissingSessionError) {
        setStatusMessage(`인증 조회 실패: ${error.message}`);
        return;
      }

      const existingUserId = data.user?.id;
      if (existingUserId) {
        setUserId(existingUserId);
        setStatusMessage("연결됨");
        return;
      }

      const { error: signInError } = await client.auth.signInAnonymously();
      if (ignore) {
        return;
      }

      if (signInError?.message) {
        setStatusMessage(`익명 로그인 실패: ${signInError.message}`);
        return;
      }

      setStatusMessage("연결됨");
    };

    void bootstrap();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user?.id ?? "";
      setUserId(nextUserId);
      if (nextUserId) {
        setStatusMessage("연결됨");
      }
    });

    return () => {
      ignore = true;
      subscription.unsubscribe();
    };
  }, [client]);

  const fetchMembers = useCallback(async () => {
    if (!client || !userId) {
      return;
    }

    const { data, error } = await client
      .from("team_members")
      .select("*")
      .eq("team_code", TEAM_CODE)
      .order("updated_at", { ascending: false });

    if (error?.message) {
      setStatusMessage(`팀 데이터 조회 실패: ${error.message}`);
      return;
    }

    const nextMembers = (data ?? []).map((row) => {
      const member = toMember(row);
      if (isStaleWeek(member.updated_at, currentWeekStartMs)) {
        return {
          ...member,
          cells: {},
          is_stale: true,
        };
      }

      return {
        ...member,
        is_stale: false,
      };
    });
    setMembers(nextMembers);
  }, [client, currentWeekStartMs, userId]);

  useEffect(() => {
    if (!client || !userId) {
      return;
    }

    queueMicrotask(() => {
      void fetchMembers();
    });

    const channel = client
      .channel(`team-members-${TEAM_CODE}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "team_members",
          filter: `team_code=eq.${TEAM_CODE}`,
        },
        () => {
          void fetchMembers();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setIsRealtimeSubscribed(true);
          setStatusMessage("연결됨");
          void fetchMembers();
        }

        if (status === "CHANNEL_ERROR") {
          setIsRealtimeSubscribed(false);
          setStatusMessage("실시간 연결 실패: Supabase Realtime 설정을 확인해주세요.");
        }
      });

    const pollId = window.setInterval(() => {
      void fetchMembers();
    }, isRealtimeSubscribed ? 10000 : 700);

    return () => {
      window.clearInterval(pollId);
      setIsRealtimeSubscribed(false);
      void client.removeChannel(channel);
    };
  }, [client, fetchMembers, isRealtimeSubscribed, userId]);

  useEffect(() => {
    if (!client || !userId) {
      return;
    }

    let ignore = false;

    const ensureMyRow = async () => {
      const { data, error } = await client
        .from("team_members")
        .select("*")
        .eq("team_code", TEAM_CODE)
        .eq("user_id", userId)
        .maybeSingle();

      if (ignore) {
        return;
      }

      if (error?.message) {
        setStatusMessage(`내 행 확인 실패: ${error.message}`);
        return;
      }

      if (data) {
        const existingMember = toMember(data);
        setNeedsNameSetup(false);
        if (!displayNameInput.trim()) {
          setDisplayNameInput(existingMember.display_name);
        }

        if (
          isStaleWeek(existingMember.updated_at, currentWeekStartMs) ||
          existingMember.is_legacy_unavailable_mode
        ) {
          const { error: resetError } = await client
            .from("team_members")
            .update({
              mode: "available",
              cells: {},
              last_editor: existingMember.display_name,
              updated_at: new Date().toISOString(),
            })
            .eq("team_code", TEAM_CODE)
            .eq("user_id", userId);

          if (!ignore && resetError?.message) {
            setStatusMessage(`주간 초기화 실패: ${resetError.message}`);
          }
        }

        return;
      }

      const defaultName = window.localStorage.getItem("meet-display-name")?.trim() ?? "";
      if (!defaultName) {
        setNeedsNameSetup(true);
        setStatusMessage("첫 접속입니다. 이름을 입력해주세요.");
        return;
      }

      const { error: insertError } = await client.from("team_members").insert({
        team_code: TEAM_CODE,
        user_id: userId,
        display_name: defaultName,
        mode: "available",
        cells: {},
        last_editor: defaultName,
        updated_at: new Date().toISOString(),
      });

      if (ignore) {
        return;
      }

      if (insertError?.message) {
        setStatusMessage(`내 행 생성 실패: ${insertError.message}`);
        return;
      }

      setDisplayNameInput(defaultName);
      setNeedsNameSetup(false);
      setStatusMessage("연결됨");
      void fetchMembers();
    };

    void ensureMyRow();

    return () => {
      ignore = true;
    };
  }, [client, currentWeekStartMs, displayNameInput, fetchMembers, userId]);

  const myMember = useMemo(
    () => members.find((member) => member.user_id === userId),
    [members, userId],
  );

  const resolvedSelectedMemberId =
    members.some((member) => member.id === selectedMemberId)
      ? selectedMemberId
      : (myMember?.id ?? members[0]?.id ?? "");

  const selectedMember = useMemo(
    () => members.find((member) => member.id === resolvedSelectedMemberId),
    [members, resolvedSelectedMemberId],
  );

  const canEditSelected = Boolean(selectedMember && selectedMember.user_id === userId);

  useEffect(() => {
    if (drawing.active || !myMember) {
      return;
    }

    const nextCells = myMember.cells;
    queueMicrotask(() => {
      setDraftCells((previous) => (sameCells(previous, nextCells) ? previous : nextCells));
    });
  }, [drawing.active, myMember]);

  const persistMyCells = useCallback(
    async (nextCells: Record<string, true>) => {
      if (!client || !myMember || !userId) {
        return;
      }

      if (sameCells(myMember.cells, nextCells)) {
        return;
      }

      const editorName = myMember.display_name;
      const { error } = await client
        .from("team_members")
        .update({
          cells: nextCells,
          last_editor: editorName,
          updated_at: new Date().toISOString(),
        })
        .eq("team_code", TEAM_CODE)
        .eq("user_id", userId);

      if (error?.message) {
        setStatusMessage(`저장 실패: ${error.message}`);
        return;
      }

      setStatusMessage("연결됨");
    },
    [client, myMember, userId],
  );

  const paintCell = useCallback(
    (day: number, slot: number, value: boolean) => {
      if (!canEditSelected) {
        return;
      }

      const key = keyFor(day, slot);
      setDraftCells((previous) => {
        const currentlyMarked = Boolean(previous[key]);
        if (currentlyMarked === value) {
          return previous;
        }

        const nextCells = { ...previous };
        if (value) {
          nextCells[key] = true;
        } else {
          delete nextCells[key];
        }

        return nextCells;
      });
    },
    [canEditSelected],
  );

  useEffect(() => {
    if (!drawing.active || !canEditSelected) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void persistMyCells(draftCells);
    }, 120);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [canEditSelected, draftCells, drawing.active, persistMyCells]);

  const stopDrawing = useCallback(() => {
    setDrawing((previous) =>
      previous.active ? { active: false, value: previous.value } : previous,
    );

    if (canEditSelected) {
      void persistMyCells(draftCellsRef.current);
    }
  }, [canEditSelected, persistMyCells]);

  useEffect(() => {
    window.addEventListener("pointerup", stopDrawing);
    window.addEventListener("pointercancel", stopDrawing);
    return () => {
      window.removeEventListener("pointerup", stopDrawing);
      window.removeEventListener("pointercancel", stopDrawing);
    };
  }, [stopDrawing]);

  useEffect(() => {
    if (!drawing.active) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const cellButton = target?.closest<HTMLButtonElement>("[data-cell='1']");

      if (!cellButton) {
        return;
      }

      const day = Number(cellButton.dataset.day);
      const slot = Number(cellButton.dataset.slot);

      if (Number.isNaN(day) || Number.isNaN(slot)) {
        return;
      }

      paintCell(day, slot, drawing.value);
    };

    window.addEventListener("pointermove", handlePointerMove);
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [drawing.active, drawing.value, paintCell]);

  const displayedCells = useMemo(() => {
    if (!selectedMember) {
      return {};
    }

    if (selectedMember.user_id === userId) {
      return draftCells;
    }

    return selectedMember.cells;
  }, [draftCells, selectedMember, userId]);

  const membersForCalculation = useMemo(
    () =>
      members.map((member) =>
        member.user_id === userId
          ? {
              ...member,
              cells: draftCells,
            }
          : member,
      ),
    [draftCells, members, userId],
  );

  const availabilityCountByCell = useMemo(() => {
    const counts: Record<string, number> = {};

    for (let day = 0; day < DAY_LABELS.length; day += 1) {
      for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
        const key = keyFor(day, slot);
        counts[key] = membersForCalculation.reduce(
          (count, member) => count + (isAvailable(member, key) ? 1 : 0),
          0,
        );
      }
    }

    return counts;
  }, [membersForCalculation]);

  const commonCells = useMemo(() => {
    const common: Record<string, true> = {};

    if (membersForCalculation.length === 0) {
      return common;
    }

    for (let day = 0; day < DAY_LABELS.length; day += 1) {
      for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
        const key = keyFor(day, slot);
        if (availabilityCountByCell[key] === membersForCalculation.length) {
          common[key] = true;
        }
      }
    }

    return common;
  }, [availabilityCountByCell, membersForCalculation.length]);

  const commonCellCount = useMemo(() => Object.keys(commonCells).length, [commonCells]);

  const recommendedBlocks = useMemo(() => {
    const blocks: TimeBlock[] = [];

    if (membersForCalculation.length === 0) {
      return blocks;
    }

    const minSlots = Math.max(1, Math.floor(minimumDuration / SLOT_MINUTES));

    for (let day = 0; day < DAY_LABELS.length; day += 1) {
      let start = -1;

      for (let slot = 0; slot <= SLOT_COUNT; slot += 1) {
        const currentKey = slot < SLOT_COUNT ? keyFor(day, slot) : "";
        const common = slot < SLOT_COUNT && Boolean(commonCells[currentKey]);

        if (common && start < 0) {
          start = slot;
        }

        if (!common && start >= 0) {
          const length = slot - start;
          if (length >= minSlots) {
            blocks.push({
              day,
              startSlot: start,
              endSlot: slot,
              minutes: length * SLOT_MINUTES,
            });
          }
          start = -1;
        }
      }
    }

    return blocks;
  }, [commonCells, membersForCalculation.length, minimumDuration]);

  const saveDisplayName = useCallback(async () => {
    const trimmed = displayNameInput.trim();
    if (!client || !userId || !trimmed) {
      return;
    }

    const payload = {
      display_name: trimmed,
      mode: "available",
      last_editor: trimmed,
      updated_at: new Date().toISOString(),
    };

    const { error } = myMember
      ? await client
          .from("team_members")
          .update(payload)
          .eq("team_code", TEAM_CODE)
          .eq("user_id", userId)
      : await client.from("team_members").insert({
          team_code: TEAM_CODE,
          user_id: userId,
          display_name: trimmed,
          mode: "available",
          cells: {},
          last_editor: trimmed,
          updated_at: new Date().toISOString(),
        });

    if (error?.message) {
      setStatusMessage(`이름 저장 실패: ${error.message}`);
      return;
    }

    window.localStorage.setItem("meet-display-name", trimmed);
    setNeedsNameSetup(false);
    setStatusMessage("연결됨");
    await fetchMembers();
  }, [client, displayNameInput, fetchMembers, myMember, userId]);

  const clearMyCells = useCallback(async () => {
    if (!myMember) {
      return;
    }

    const empty: Record<string, true> = {};
    setDraftCells(empty);
    await persistMyCells(empty);
  }, [myMember, persistMyCells]);

  const deleteMyUser = useCallback(async () => {
    if (!client || !userId) {
      return;
    }

    const confirmed = window.confirm(
      "내 사용자 정보를 삭제합니다.\n내 이름/시간표가 목록에서 사라집니다.\n정말 진행할까요?",
    );
    if (!confirmed) {
      return;
    }

    setStatusMessage("내 사용자 삭제 진행 중...");

    const { error } = await client
      .from("team_members")
      .delete()
      .eq("team_code", TEAM_CODE)
      .eq("user_id", userId);

    if (error?.message) {
      setStatusMessage(
        `내 사용자 삭제 실패: ${error.message} (team_members DELETE 정책을 확인해주세요.)`,
      );
      return;
    }

    window.localStorage.removeItem("meet-display-name");
    setDisplayNameInput("");
    setNeedsNameSetup(true);
    setSelectedMemberId("");
    setDraftCells({});
    setStatusMessage("내 사용자 삭제 완료");
    await fetchMembers();
  }, [client, fetchMembers, userId]);

  const resetAllSchedules = useCallback(async () => {
    if (!client || !userId) {
      return;
    }

    const confirmed = window.confirm(
      "전체 시간표를 초기화합니다.\n팀원 전체의 가능한 시간 체크가 모두 삭제됩니다.\n정말 진행할까요?",
    );

    if (!confirmed) {
      return;
    }

    setStatusMessage("전체 초기화 진행 중...");

    const editorName =
      myMember?.display_name || displayNameInput.trim() || `온라인사역-${userId.slice(0, 4)}`;
    const { error } = await client.rpc("reset_team_members", {
      p_team_code: TEAM_CODE,
      p_editor_name: editorName,
    });

    if (error?.message) {
      const missingRpc =
        error.message.includes("Could not find the function") ||
        error.message.includes("reset_team_members");
      if (missingRpc) {
        setStatusMessage("전체 초기화 실패: reset_team_members RPC를 먼저 생성해주세요.");
      } else {
        setStatusMessage(`전체 초기화 실패: ${error.message}`);
      }
      return;
    }

    setStatusMessage("전체 초기화 완료");
    await fetchMembers();
  }, [client, displayNameInput, fetchMembers, myMember, userId]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_15%_20%,#dbeafe_0%,transparent_45%),radial-gradient(circle_at_85%_15%,#fde68a_0%,transparent_40%),linear-gradient(155deg,#eff6ff_0%,#f8fafc_45%,#ecfeff_100%)] px-4 py-8 text-slate-900 md:px-8">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 rounded-[30px] border border-slate-200/70 bg-white/75 p-4 shadow-[0_35px_90px_-35px_rgba(15,23,42,0.35)] backdrop-blur md:p-8">
        <header className="animate-fade-up rounded-2xl border border-slate-200/80 bg-slate-50/80 px-5 py-5">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-slate-600">Online Ministry Team</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-4xl">
            온라인 사역팀 회의 시간 조율표
          </h1>
          <p className="mt-2 text-sm text-slate-600 md:text-base">
            각자 가능한 시간만 체크하면 공통 가능한 시간이 자동으로 계산됩니다. 본인 시간표만 편집할 수 있고, 변경은 실시간 동기화됩니다.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            매주 일요일 00:00(KST) 기준으로 자동 초기화됩니다.
          </p>
          <p className="mt-2 text-xs text-slate-500">연결 상태: {statusMessage}</p>
        </header>

        <section className="animate-fade-up rounded-2xl border border-slate-200/90 bg-white/90 p-4 [animation-delay:120ms] md:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={displayNameInput}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveDisplayName();
                }
              }}
              placeholder="내 이름"
              className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none ring-offset-2 focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
            />
            <button
              type="button"
              onClick={() => {
                void saveDisplayName();
              }}
              className="h-10 rounded-xl bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
            >
              이름 저장
            </button>

            <button
              type="button"
              onClick={() => {
                void clearMyCells();
              }}
              disabled={!myMember}
              className="h-10 rounded-xl border border-slate-300 px-3 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
            >
              내 시간표 비우기
            </button>

            <button
              type="button"
              onClick={() => {
                void deleteMyUser();
              }}
              disabled={!myMember}
              className="h-10 rounded-xl border border-rose-300 bg-rose-50 px-3 text-sm text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-400"
            >
              내 사용자 삭제
            </button>

            <button
              type="button"
              onClick={() => {
                void resetAllSchedules();
              }}
              disabled={!myMember}
              className="h-10 rounded-xl border border-rose-300 bg-rose-50 px-3 text-sm text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-400"
            >
              전체 초기화
            </button>

            {!canEditSelected && myMember ? (
              <button
                type="button"
                onClick={() => setSelectedMemberId(myMember.id)}
                className="h-10 rounded-xl border border-sky-300 bg-sky-50 px-3 text-sm text-sky-700 hover:bg-sky-100"
              >
                내 시간표로 이동
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {members.map((member) => {
              const selected = member.id === resolvedSelectedMemberId;
              const mine = member.user_id === userId;

              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setSelectedMemberId(member.id)}
                  className={`rounded-xl border px-3 py-2 text-left text-sm transition ${
                    selected
                      ? "border-slate-800 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"
                  }`}
                >
                  <p className="font-semibold">
                    {member.display_name}
                    {mine ? " (나)" : ""}
                  </p>
                  <p className={`text-xs ${selected ? "text-slate-200" : "text-slate-500"}`}>
                    최근 수정 {formatUpdatedAt(member.updated_at)}
                  </p>
                  <p className={`text-xs ${selected ? "text-slate-200" : "text-slate-500"}`}>
                    편집자 {member.last_editor ?? member.display_name}
                  </p>
                  {member.is_stale ? (
                    <p className={`text-xs ${selected ? "text-amber-200" : "text-amber-600"}`}>
                      지난 주 데이터 (이번 주 초기화됨)
                    </p>
                  ) : null}
                  {member.is_legacy_unavailable_mode ? (
                    <p className={`text-xs ${selected ? "text-amber-200" : "text-amber-600"}`}>
                      구버전 불가능 체크 데이터 (가능 체크 방식으로 초기화됨)
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-slate-500">
            현재 보기: <span className="font-semibold text-slate-700">{selectedMember?.display_name ?? "없음"}</span>
            {canEditSelected ? " (편집 가능)" : " (읽기 전용)"}
          </p>
        </section>

        <section className="grid animate-fade-up gap-4 [animation-delay:220ms] lg:grid-cols-[1fr_340px]">
          <div className="overflow-auto rounded-2xl border border-slate-200 bg-white/90 p-3 md:p-4">
            <table className="min-w-[760px] border-separate border-spacing-0 overflow-hidden rounded-xl">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 h-10 w-20 border border-slate-300 bg-slate-100 text-center text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Time
                  </th>
                  {DISPLAY_DAY_ORDER.map((dayIndex) => (
                    <th
                      key={dayIndex}
                      className="sticky top-0 z-10 h-10 border border-slate-300 bg-slate-100 text-center text-sm font-semibold text-slate-700"
                    >
                      {DAY_LABELS[dayIndex]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: SLOT_COUNT }, (_, slot) => (
                  <tr key={slot}>
                    <th className="sticky left-0 z-10 h-8 border border-slate-300 bg-slate-50 px-1 text-xs font-medium text-slate-600">
                      {slotToTime(slot)}
                    </th>

                    {DISPLAY_DAY_ORDER.map((dayIndex) => {
                      const dayLabel = DAY_LABELS[dayIndex];
                      const key = keyFor(dayIndex, slot);
                      const marked = Boolean(displayedCells[key]);
                      const common = Boolean(commonCells[key]);
                      const count = availabilityCountByCell[key] ?? 0;
                      const ratio =
                        membersForCalculation.length > 0 ? count / membersForCalculation.length : 0;

                      return (
                        <td key={`${dayLabel}-${slot}`} className="p-0">
                          <button
                            type="button"
                            data-cell="1"
                            data-day={dayIndex}
                            data-slot={slot}
                            onPointerDown={() => {
                              if (!canEditSelected) {
                                return;
                              }

                              const nextValue = !Boolean(displayedCells[key]);
                              setDrawing({ active: true, value: nextValue });
                              paintCell(dayIndex, slot, nextValue);
                            }}
                            onPointerEnter={() => {
                              if (!drawing.active) {
                                return;
                              }
                              paintCell(dayIndex, slot, drawing.value);
                            }}
                            className={`h-8 w-full touch-none border border-slate-300 transition-colors ${classForCell(
                              marked,
                              common,
                              ratio,
                            )} ${!canEditSelected ? "cursor-not-allowed" : "cursor-cell"}`}
                            title={`${dayLabel} ${slotToTime(slot)} (${count}/${membersForCalculation.length}명 가능)`}
                            aria-label={`${dayLabel} ${slotToTime(slot)} 셀`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white/90 p-4">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs uppercase tracking-[0.18em] text-emerald-700">공통 가능 시간</p>
              <p className="mt-1 text-2xl font-semibold text-emerald-900">
                {commonCellCount}
                <span className="ml-1 text-sm font-medium text-emerald-700">칸</span>
              </p>
              <p className="mt-2 text-xs text-emerald-800">
                총 {SLOT_COUNT * DAY_LABELS.length}칸 중 모두 가능한 시간 수
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <label htmlFor="duration" className="text-sm font-semibold text-slate-700">
                최소 회의 길이
              </label>
              <select
                id="duration"
                value={minimumDuration}
                onChange={(event) => setMinimumDuration(Number(event.target.value))}
                className="mt-2 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none ring-offset-2 focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
              >
                {DURATION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}분 이상
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold text-slate-800">추천 가능한 연속 시간</p>
              <div className="mt-3 space-y-2">
                {recommendedBlocks.length === 0 ? (
                  <p className="text-sm text-slate-500">조건을 만족하는 공통 시간대가 아직 없습니다.</p>
                ) : (
                  [...recommendedBlocks]
                    .sort(
                      (left, right) =>
                        DISPLAY_DAY_ORDER.indexOf(left.day) - DISPLAY_DAY_ORDER.indexOf(right.day) ||
                        left.startSlot - right.startSlot,
                    )
                    .slice(0, 12)
                    .map((block) => (
                    <div
                      key={`${block.day}-${block.startSlot}-${block.endSlot}`}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                    >
                      <p className="text-sm font-semibold text-slate-700">{DAY_LABELS[block.day]}</p>
                      <p className="text-sm text-slate-600">
                        {slotToTime(block.startSlot)} - {slotToTime(block.endSlot)} ({block.minutes}분)
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <p>색상 가이드</p>
              <p>초록: 전원 가능 / 파랑: 현재 선택 멤버 가능 체크</p>
            </div>
          </aside>
        </section>
      </main>

      {needsNameSetup ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">First Setup</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">이름을 먼저 입력해주세요</h2>
            <p className="mt-2 text-sm text-slate-600">
              팀원 식별과 수정자 표시를 위해 첫 접속 시 이름이 필요합니다.
            </p>
            <input
              value={displayNameInput}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveDisplayName();
                }
              }}
              placeholder="예: 김OO"
              className="mt-4 h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none ring-offset-2 focus:border-slate-500 focus:ring-2 focus:ring-slate-300"
            />
            <button
              type="button"
              onClick={() => {
                void saveDisplayName();
              }}
              disabled={!displayNameInput.trim()}
              className="mt-3 h-11 w-full rounded-xl bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              시작하기
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
