// Only descriptive strategy data crosses this boundary; never executable code.
export function validateStrategy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "A complete strategy update is required for every decision.",
    );
  const plan = {};
  for (const field of [
    "thesis",
    "entryConditions",
    "holdConditions",
    "exitConditions",
    "invalidation",
    "memory",
  ]) {
    const limit = field === "memory" ? 2000 : 800;
    if (
      typeof value[field] !== "string" ||
      !value[field].trim() ||
      value[field].length > limit
    )
      throw new Error(`Strategy ${field} must contain 1–${limit} characters.`);
    plan[field] = value[field].trim();
  }
  for (const field of ["entryReadiness", "exitUrgency"]) {
    if (
      typeof value[field] !== "number" ||
      !Number.isFinite(value[field]) ||
      value[field] < 0 ||
      value[field] > 100
    )
      throw new Error(`Strategy ${field} must be a number from 0 to 100.`);
    plan[field] = value[field];
  }
  return plan;
}
