import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";

// Display Time Availability (technology-stack 25, Issue #65). Part of the
// Common Time Module (architecture 10.1). It never feeds or reads the Provider
// send Clock Trust (`send/internal/os-sync.ts`); the two stay independent.

export type TimeAvailability = "available" | "unavailable";
export type NtpEvidence = "synchronized" | "unsynchronized" | "failed";
export type RtcEvidence = "valid" | "invalid" | "failed";
export type AvailabilityReason = "ntp" | "rtc" | "none";
export interface TimeAvailabilityResult {
  availability: TimeAvailability;
  reason: AvailabilityReason;
}

/** 2026-01-01T00:00:00Z. A fixed code value, not Config (25.2). */
export const RTC_FLOOR_EPOCH_SECONDS = 1_767_225_600;
export const RTC_SINCE_EPOCH_PATH = "/sys/class/rtc/rtc0/since_epoch";
export const CHECK_PERIOD_MS = 10_000;
export const READ_TIMEOUT_MS = 3_000;

/** `--value` prints exactly one line; anything else is a failed read. */
export function parseNtpSynchronized(output: string): NtpEvidence {
  if (output === "yes\n") return "synchronized";
  if (output === "no\n") return "unsynchronized";
  return "failed";
}

/** Decimal seconds since the epoch (UTC). A reset RTC counts again from 0. */
export function parseRtcSinceEpoch(text: string): RtcEvidence {
  if (!/^\d+\n?$/.test(text)) return "failed";
  const seconds = Number(text.trim());
  if (!Number.isSafeInteger(seconds)) return "failed";
  return seconds >= RTC_FLOOR_EPOCH_SECONDS ? "valid" : "invalid";
}

/** Either evidence suffices; with neither (read failures included) the time
 * is not shown as a normal clock (architecture 10.2, technology-stack 25.2).
 */
export function evaluateTimeAvailability(
  ntp: NtpEvidence,
  rtc: RtcEvidence,
): TimeAvailabilityResult {
  if (ntp === "synchronized")
    return { availability: "available", reason: "ntp" };
  if (rtc === "valid") return { availability: "available", reason: "rtc" };
  return { availability: "unavailable", reason: "none" };
}

export interface TimeEvidenceSources {
  ntp(signal: AbortSignal): Promise<string>;
  rtc(signal: AbortSignal): Promise<string>;
}

/** No shell, fixed arguments, no Config override (same form as C-Impl-5B-1). */
const readNtpSynchronized = (signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "timedatectl",
      ["show", "-p", "NTPSynchronized", "--value"],
      {
        encoding: "utf8",
        timeout: READ_TIMEOUT_MS,
        maxBuffer: 1024,
        signal,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export const systemTimeEvidence: TimeEvidenceSources = Object.freeze({
  ntp: readNtpSynchronized,
  rtc: (signal: AbortSignal) =>
    readFile(RTC_SINCE_EPOCH_PATH, { encoding: "utf8", signal }),
});

type Source = "ntp" | "rtc";
type MonitorLogger = Pick<Logger, "info" | "warn">;

async function read<T extends string>(
  source: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  parse: (value: string) => T,
  failed: T,
): Promise<T> {
  try {
    // The timeout ends the read even if a source ignores the abort signal.
    const value = await new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
      source(signal).then(resolve, reject);
    });
    if (signal.aborted || typeof value !== "string") return failed;
    return parse(value);
  } catch {
    return failed;
  }
}

/** Reads both evidences every 10 seconds and holds the latest result. Until
 * the first read completes (and after stop) the result is `unavailable`.
 * At most one read runs at a time.
 */
export class TimeAvailabilityMonitor {
  private result: TimeAvailabilityResult = {
    availability: "unavailable",
    reason: "none",
  };
  private evaluated = false;
  private readonly failing: Record<Source, boolean> = {
    ntp: false,
    rtc: false,
  };
  private timer?: ReturnType<typeof setInterval>;
  private running?: AbortController;
  private generation = 0;

  constructor(
    private readonly logger: MonitorLogger,
    private readonly sources: TimeEvidenceSources = systemTimeEvidence,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), CHECK_PERIOD_MS);
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.running?.abort();
    this.result = { availability: "unavailable", reason: "none" };
  }

  current(): TimeAvailability {
    return this.result.availability;
  }

  private async check(): Promise<void> {
    if (this.running || !this.timer) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.running = abort;
    const timeout = setTimeout(() => abort.abort(), READ_TIMEOUT_MS);
    try {
      const [ntp, rtc] = await Promise.all([
        read(this.sources.ntp, abort.signal, parseNtpSynchronized, "failed"),
        read(this.sources.rtc, abort.signal, parseRtcSinceEpoch, "failed"),
      ]);
      if (generation !== this.generation) return;
      this.observe("ntp", ntp === "failed");
      this.observe("rtc", rtc === "failed");
      const next = evaluateTimeAvailability(ntp, rtc);
      if (
        !this.evaluated ||
        next.availability !== this.result.availability ||
        next.reason !== this.result.reason
      )
        this.logger.info(
          { event: "time_availability_changed", ...next, ntp, rtc },
          "Display time availability changed",
        );
      this.evaluated = true;
      this.result = next;
    } catch {
      /* read() never rejects; keep the previous result */
    } finally {
      clearTimeout(timeout);
      if (this.running === abort) this.running = undefined;
    }
  }

  /** Logs only when a source starts or stops failing, not on every read. */
  private observe(source: Source, failed: boolean): void {
    if (failed === this.failing[source]) return;
    this.failing[source] = failed;
    if (failed)
      this.logger.warn(
        { event: "time_evidence_unavailable", source },
        "Time evidence could not be read",
      );
    else
      this.logger.info(
        { event: "time_evidence_recovered", source },
        "Time evidence readable again",
      );
  }
}
