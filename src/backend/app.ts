import Fastify, { LogController } from "fastify";
import type { Logger } from "pino";

export function buildApp(logger: Logger) {
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Connectivity only: not a Health/Readiness or Published State contract.
  app.get("/ping", async () => ({ message: "pong" }));
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ message: "Not found" }),
  );
  app.setErrorHandler((_error, _request, reply) => {
    logger.error({ event: "http_request_failed" }, "HTTP request failed");
    void reply.code(500).send({ message: "Request failed" });
  });
  return app;
}
