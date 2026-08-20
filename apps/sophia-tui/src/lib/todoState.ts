export type TodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoState {
  items: TodoItem[];
  updatedAt: number | null;
}

export const EMPTY_TODO_STATE: TodoState = { items: [], updatedAt: null };

export type TodoEvent = {
  type: string;
  items?: unknown;
  source?: unknown;
};

function normalizeStatus(value: unknown): TodoStatus {
  if (value === "in_progress" || value === "completed" || value === "failed") {
    return value;
  }
  return "pending";
}

function normalizeItems(rawItems: unknown): TodoItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.flatMap((raw, index): TodoItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) return [];
    return [{
      id: typeof row.id === "string" && row.id ? row.id : `td-${index}`,
      content,
      status: normalizeStatus(row.status),
    }];
  });
}

export function todoReducer(state: TodoState, event: TodoEvent): TodoState {
  if (event.type === "run_start") return EMPTY_TODO_STATE;
  if (event.type !== "todo_update" || !Array.isArray(event.items)) return state;
  const incoming = normalizeItems(event.items);
  const source = typeof event.source === "string" ? event.source : "";
  if (source === "todo_write" && state.items.length > 0) {
    const byId = new Map(state.items.map((item) => [item.id, item]));
    for (const item of incoming) byId.set(item.id, item);
    const merged = [
      ...state.items.map((item) => byId.get(item.id) ?? item),
      ...incoming.filter((item) => !state.items.some((row) => row.id === item.id)),
    ];
    return { items: merged, updatedAt: Date.now() };
  }
  return { items: incoming, updatedAt: Date.now() };
}

