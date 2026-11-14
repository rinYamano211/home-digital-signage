import Fastify, {
  LogController,
  type FastifyInstance,
  type RawServerDefault,
  type RawRequestDefaultExpression,
  type RawReplyDefaultExpression,
} from "fastify";
import type { Logger } from "pino";
import {
  DATABASE_UNAVAILABLE,
  type PublishedStatesResponse,
} from "./published-state-api.js";
import type { TimeAvailability } from "./time/display-time-availability.js";

export function buildApp(logger: Logger, routes = true) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Connectivity only: not a Health/Readiness or Published State contract.
  if (routes) registerRoutes(app);
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ message: "Not found" }),
  );
  app.setErrorHandler((_error, _request, reply) => {
    logger.error({ event: "http_request_failed" }, "HTTP request failed");
    void reply.code(500).send({ message: "Request failed" });
  });
  return app;
}

export function registerRoutes(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >,
  publishedStates: () => PublishedStatesResponse = () => DATABASE_UNAVAILABLE,
  timeAvailability: () => TimeAvailability = () => "unavailable",
) {
  app.get("/ping", async () => ({ message: "pong" }));
  // Registered whether or not the DB is usable; unusable DB answers 503.
  app.get("/api/published-states", async (_request, reply) => {
    const response = publishedStates();
    return reply.code(response.status).send(response.body);
  });
  // Current OS state, not a Published State: no DB, always 200 (technology-stack 25.4).
  app.get("/api/time-availability", async (_request, reply) => {
    let availability: TimeAvailability = "unavailable";
    try {
      availability =
        timeAvailability() === "available" ? "available" : "unavailable";
    } catch {
      /* unconfirmed time is unavailable */
    }
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .send({ availability });
  });
}
