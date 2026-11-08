import type { Logger } from "pino";
import type {
  AcquireContext,
  AcquireResult,
  MultiHttpProvider,
} from "../acquisition/coordinator.js";
import { ABSOLUTE_MAX_BODY_BYTES, type HttpOutcome } from "../http/outcome.js";
import {
  assertion,
  parseTokenResponse,
  TOKEN_URL,
  tokenRequestBody,
  TokenCache,
  type ServiceAccount,
} from "./google-auth.js";
import {
  eventsUrl,
  MAX_PAGES,
  normalizeEvents,
  parseEventsPage,
  type EventsPage,
} from "./google-calendar.js";
import { nextTokyoMidnight, tokyoDate } from "./jst.js";
import { validScheduleData } from "./schedule-data.js";

/** Provisional period / TTL (technology-stack 11.5). */
export const SCHEDULE_PERIOD_MS = 10 * 60_000;
export const SCHEDULE_TTL_MS = 6 * 3_600_000;
const TOKEN_MAX_BODY_BYTES = 65_536;

/** Fixed log classification (technology-stack 18.7). Never the token, key,
 * Calendar ID, URL, titles or any error Body.
 */
export type ScheduleFailureReason =
  | "auth_failed"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "clock_moved_back";

type Step<T> = { ok: true; value: T } | { ok: false; result: AcquireResult };
type ScheduleLogger = Pick<Logger, "debug" | "info" | "warn">;

export interface ScheduleProviderOptions {
  readonly calendarId: string;
  readonly account: ServiceAccount;
  readonly logger: ScheduleLogger;
}

/** Schedule Service Provider for Google Calendar (Issue #10). */
export function createScheduleProvider(
  options: ScheduleProviderOptions,
): MultiHttpProvider {
  const tokens = new TokenCache();
  const { calendarId, account, logger } = options;

  const fail = (
    signal: AbortSignal,
    reason: ScheduleFailureReason,
    http?: { status: number; retryAfter?: string },
  ): AcquireResult => {
    // An aborted attempt is not a Provider failure; it is not logged.
    if (!signal.aborted)
      logger.warn(
        {
          event: "schedule_acquisition_failed",
          reason,
          ...(http ? { httpStatus: http.status } : {}),
        },
        "Schedule acquisition failed",
      );
    return {
      kind: "failure",
      ...(http ? { httpStatus: http.status } : {}),
      ...(http?.retryAfter !== undefined
        ? { retryAfter: http.retryAfter }
        : {}),
    };
  };

  /** Transport-level failures; null when there is a complete response. */
  const transport = (
    signal: AbortSignal,
    outcome: HttpOutcome,
  ): AcquireResult | null => {
    switch (outcome.kind) {
      case "response":
        return null;
      case "timeout":
        return fail(signal, "timeout");
      case "body_too_large":
        return fail(signal, "invalid_response", outcome.http);
      default:
        return fail(signal, "network_error", outcome.http);
    }
  };

  const statusFailure = (
    signal: AbortSignal,
    http: { status: number; retryAfter?: string },
    stage: "token" | "events",
  ): AcquireResult => {
    if (http.status === 429) return fail(signal, "rate_limited", http);
    if (http.status >= 500) return fail(signal, "server_error", http);
    if (stage === "token") return fail(signal, "auth_failed", http);
    if (http.status === 401) {
      tokens.clear(); // re-authenticate on the next attempt, never now
      return fail(signal, "auth_failed", http);
    }
    if (http.status === 403 || http.status === 404)
      return fail(signal, "forbidden", http); // not shared / no access
    return fail(signal, "http_error", http);
  };

  const accessToken = async (ctx: AcquireContext): Promise<Step<string>> => {
    const cached = tokens.get(Date.now());
    if (cached !== null) return { ok: true, value: cached };
    const requestedAt = Date.now();
    const outcome = await ctx.http({
      url: TOKEN_URL,
      maxBodyBytes: TOKEN_MAX_BODY_BYTES,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenRequestBody(assertion(account, requestedAt)),
    });
    const broken = transport(ctx.signal, outcome);
    if (broken) return { ok: false, result: broken };
    if (outcome.kind !== "response") throw new Error("unreachable");
    if (outcome.http.status !== 200)
      return {
        ok: false,
        result: statusFailure(ctx.signal, outcome.http, "token"),
      };
    const token = parseTokenResponse(outcome.body);
    if (!token) return { ok: false, result: fail(ctx.signal, "auth_failed") };
    // An aborted attempt never caches a token.
    if (ctx.signal.aborted) return { ok: false, result: { kind: "failure" } };
    tokens.set(token.accessToken, requestedAt, token.expiresInMs);
    return { ok: true, value: token.accessToken };
  };

  const page = async (
    ctx: AcquireContext,
    token: string,
    targetDate: string,
    pageToken?: string,
  ): Promise<Step<EventsPage>> => {
    const outcome = await ctx.http({
      url: eventsUrl(calendarId, targetDate, pageToken),
      maxBodyBytes: ABSOLUTE_MAX_BODY_BYTES,
      headers: { authorization: `Bearer ${token}` },
    });
    const broken = transport(ctx.signal, outcome);
    if (broken) return { ok: false, result: broken };
    if (outcome.kind !== "response") throw new Error("unreachable");
    if (outcome.http.status !== 200)
      return {
        ok: false,
        result: statusFailure(ctx.signal, outcome.http, "events"),
      };
    const parsed = parseEventsPage(outcome.body);
    return parsed
      ? { ok: true, value: parsed }
      : { ok: false, result: fail(ctx.signal, "invalid_response") };
  };

  return Object.freeze({
    stateKey: "schedule",
    periodMs: SCHEDULE_PERIOD_MS,
    quota: false,
    /** Success period capped at the next JST midnight (18.7). */
    nextPeriodMs: (startedAtMs: number) =>
      Math.min(
        SCHEDULE_PERIOD_MS,
        nextTokyoMidnight(startedAtMs) - startedAtMs,
      ),
    async acquire(ctx: AcquireContext): Promise<AcquireResult> {
      const startedAtMs = Date.parse(ctx.startedAt);
      if (!Number.isFinite(startedAtMs)) return { kind: "failure" };
      const targetDate = tokyoDate(startedAtMs); // fixed for this attempt
      const token = await accessToken(ctx);
      if (!token.ok) return token.result;
      const items: NonNullable<EventsPage["items"]> = [];
      let next: string | undefined;
      let pages = 0;
      do {
        if (ctx.signal.aborted) return { kind: "failure" };
        if (pages === MAX_PAGES) return fail(ctx.signal, "invalid_response");
        const result = await page(ctx, token.value, targetDate, next);
        if (!result.ok) return result.result;
        pages++;
        items.push(...(result.value.items ?? []));
        next = result.value.nextPageToken;
      } while (next !== undefined);
      // Shutdown after the last response: no success / discard log, and the
      // Coordinator saves nothing (18.7). Same result as the earlier checks.
      if (ctx.signal.aborted) return { kind: "failure" };
      const events = normalizeEvents(items, targetDate);
      const data = { date: targetDate, events };
      if (events === null || !validScheduleData(data, targetDate))
        return fail(ctx.signal, "invalid_response");
      const completedAtMs = Date.now();
      const completedDate = tokyoDate(completedAtMs);
      if (completedDate > targetDate) {
        logger.info(
          { event: "schedule_result_discarded", reason: "date_rolled_over" },
          "Schedule result for a past date discarded",
        );
        return { kind: "discard" };
      }
      if (completedDate < targetDate)
        return fail(ctx.signal, "clock_moved_back");
      logger.debug(
        { event: "schedule_acquired", pages, events: events.length },
        "Schedule acquired",
      );
      return {
        kind: "success",
        data,
        expiresAt: new Date(completedAtMs + SCHEDULE_TTL_MS).toISOString(),
      };
    },
  } satisfies MultiHttpProvider);
}
