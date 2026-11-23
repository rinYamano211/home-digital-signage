/* global process, fetch, AbortSignal, performance, console */
// API part of the Issue #13 metrics (technology-stack 27.2, 27.4). Called by
// collect-metrics.sh. Prints one CSV fragment of 30 fields. Never prints
// `data`: only meta values that match the expected formats are printed.
const base = process.env.HDS_API_BASE ?? "http://127.0.0.1:3000";
const timeoutMs = Number(process.env.HDS_API_TIMEOUT_MS ?? 3000);
const KEYS = [
  "schedule",
  "currentWeather",
  "hourlyWeather",
  "weeklyWeather",
  "rainForecast",
];
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const RESULTS = ["success", "failure"];
const SOURCES = ["externalApi", "cache"];
const AVAILABILITY = ["available", "unavailable"];

const object = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const instant = (v) =>
  v === null ? "null" : typeof v === "string" && INSTANT.test(v) ? v : "ERR";
const oneOf = (v, allowed) =>
  v === null ? "null" : allowed.includes(v) ? v : "ERR";

// result: OK, HTTP_<code>, TIMEOUT, CONN_ERR or INVALID_JSON (27.4).
async function get(path) {
  const started = performance.now();
  const elapsed = () => String(Math.round(performance.now() - started));
  try {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200)
      return { result: `HTTP_${response.status}`, ms: elapsed() };
    try {
      return { result: "OK", ms: elapsed(), body: JSON.parse(text) };
    } catch {
      return { result: "INVALID_JSON", ms: elapsed() };
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { result: timedOut ? "TIMEOUT" : "CONN_ERR", ms: elapsed() };
  }
}

const fields = [];

const time = await get("/api/time-availability");
let availability = "ERR";
if (time.result === "OK") {
  const value = object(time.body) ? time.body.availability : undefined;
  if (AVAILABILITY.includes(value)) availability = value;
  else time.result = "INVALID_JSON";
}
fields.push(time.result, time.ms, availability);

const states = await get("/api/published-states");
const all = object(states.body) ? states.body.states : undefined;
if (states.result === "OK" && !object(all)) states.result = "INVALID_JSON";
fields.push(states.result, states.ms);
for (const key of KEYS) {
  const meta =
    states.result === "OK" && object(all[key]) ? all[key].meta : undefined;
  if (!object(meta)) {
    fields.push("ERR", "ERR", "ERR", "ERR", "ERR");
    continue;
  }
  fields.push(
    instant(meta.lastAttemptAt),
    oneOf(meta.lastAttemptResult, RESULTS),
    instant(meta.dataUpdatedAt),
    instant(meta.expiresAt),
    oneOf(meta.dataSource, SOURCES),
  );
}

console.log(fields.join(","));
