function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeOpenAIFramePeriod(
  verificationStatus: "on_track" | "uncertain" | "off_track",
  strongLock: boolean
): number {
  if (verificationStatus === "off_track") return 1;
  if (verificationStatus === "uncertain") return 1;
  return strongLock ? 3 : 2;
}

export function recommendIntervalMs(
  verificationStatus: "on_track" | "uncertain" | "off_track",
  totalMs: number,
  strongLock: boolean
): number {
  if (verificationStatus === "on_track" && strongLock) {
    return clamp(Math.round(90 + totalMs * 0.25), 80, 180);
  }
  if (verificationStatus === "on_track") {
    return clamp(Math.round(130 + totalMs * 0.3), 90, 240);
  }
  if (verificationStatus === "uncertain") {
    return clamp(Math.round(180 + totalMs * 0.4), 120, 320);
  }
  return clamp(Math.round(240 + totalMs * 0.5), 160, 420);
}
