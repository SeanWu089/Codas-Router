// Display-only protocol v1. Never use these fields for identity or authorization.
const platforms = new Set(["darwin", "win32", "linux", "android", "ios", "unknown"]);
const formFactors = new Set(["desktop", "laptop", "phone", "tablet", "unknown"]);
const forbidden = /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

export function normalizeCoreDevice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  const { name, platform, formFactor = "unknown" } = value;
  if (typeof name !== "string" || name.length > 128 || forbidden.test(name)) return null;
  const label = name.trim();
  if (!label || Array.from(label).length > 64 ||
      !platforms.has(platform) || !formFactors.has(formFactor)) return null;
  // Explicitly select only display fields. Ignore future additions and secrets.
  return { version: 1, name: label, platform, formFactor };
}
