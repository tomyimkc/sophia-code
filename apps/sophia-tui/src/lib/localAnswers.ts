export function isModelIdentityQuestion(input: string): boolean {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ");
  return /^(what|which) (model|llm) (are you using|are you running|is active|is running)( right now| now)?$/.test(
    normalized,
  );
}

export function localModelIdentityAnswer(
  input: string,
  opts: { model: string; runtime: "sophia" | "prime" },
): string | null {
  if (!isModelIdentityQuestion(input)) return null;
  const runtime = opts.runtime === "prime" ? "Prime" : "Sophia";
  return `Active model: ${opts.model} · runtime: ${runtime}.`;
}
