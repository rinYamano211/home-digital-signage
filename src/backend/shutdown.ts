import type { EventEmitter } from "node:events";
import type { Logger } from "pino";

type Closeable = { close(): Promise<unknown> };

export function installShutdown(
  app: Closeable,
  logger: Logger,
  timeoutMs: number,
  finish: (code: number) => void,
  signals: Pick<EventEmitter, "on" | "off">,
) {
  let pending: Promise<void> | undefined;
  const dispose = () => {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
  };
  const shutdown = (): Promise<void> => {
    if (pending) return pending;
    pending = new Promise<void>((resolve) => {
      let completed = false;
      const complete = (code: number, event: string) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        dispose();
        if (code === 0) logger.info({ event }, "Backend stopped");
        else logger.error({ event }, "Backend shutdown failed");
        finish(code);
        resolve();
      };
      // Keep the deadline alive while closing, then always clear it.
      const timer = setTimeout(
        () => complete(1, "shutdown_timeout"),
        timeoutMs,
      );
      Promise.resolve()
        .then(() => app.close())
        .then(
          () => complete(0, "shutdown_complete"),
          () => complete(1, "shutdown_failed"),
        );
    });
    return pending;
  };
  function onSignal() {
    void shutdown();
  }
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  return { shutdown, dispose };
}
