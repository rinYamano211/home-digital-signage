import Fastify, {
  LogController,
  type FastifyInstance,
  type RawServerDefault,
  type RawRequestDefaultExpression,
  type RawReplyDefaultExpression,
} from "fastify";
import type { Logger } from "pino";

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
) {
  app.get("/ping", async () => ({ message: "pong" }));
}
