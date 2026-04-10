export const AUTO_TIMESTAMP_PARAM_KEYWORDS = ["nonce", "seq", "sequence"];

export function matchesAutoTimestampParamName(name) {
  const normalizedName = String(name ?? "")
    .trim()
    .toLowerCase();

  if (!normalizedName) return false;

  return AUTO_TIMESTAMP_PARAM_KEYWORDS.some((keyword) =>
    normalizedName.includes(keyword)
  );
}

export function getCurrentUnixTimestampSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}
