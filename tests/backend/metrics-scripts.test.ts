import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// Issue #13 (technology-stack 27). Runs on Linux (CI) only: the scripts read
// /proc and use flock. systemctl, vcgencmd, journalctl, timedatectl, ip,
// pgrep and grim are fakes; /sys is a fake tree. The API helper is real.
const linux = test.runIf(process.platform === "linux");
const collect = resolve("scripts/collect-metrics.sh");
const render = resolve("scripts/check-render.sh");
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise((done) => server.close(done));
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stderr: string;
}

function run(script: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done) => {
    execFile("sh", [script], { env }, (error, _stdout, stderr) =>
      done({ code: error ? Number(error.code ?? 1) : 0, stderr }),
    );
  });
}

const fake = (lines: string[]) => ["#!/bin/sh", ...lines, ""].join("\n");

async function tool(bin: string, name: string, lines: string[]) {
  await writeFile(join(bin, name), fake(lines));
  await chmod(join(bin, name), 0o755);
}

async function api(): Promise<string> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/time-availability")
      return response.end('{"availability":"available"}');
    const meta = {
      dataUpdatedAt: "2026-11-23T01:00:00.000Z",
      expiresAt: "2026-11-23T03:00:00.000Z",
      lastAttemptAt: "2026-11-23T01:00:00.000Z",
      lastAttemptResult: "success",
      publishedAt: "2026-11-23T01:00:00.000Z",
      dataSource: "externalApi",
    };
    response.end(
      JSON.stringify({
        schemaVersion: 1,
        states: {
          schedule: { data: { events: [{ title: "SECRET-TITLE" }] }, meta },
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function collectSetup() {
  const root = await mkdtemp(join(tmpdir(), "hds-metrics-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const sys = join(root, "sys");
  const metrics = join(root, "metrics");
  const data = join(root, "data");
  const base = join(root, "opt");
  const kioskMode = join(root, "kiosk-mode");
  const pid = String(process.pid);
  for (const d of [
    bin,
    metrics,
    data,
    join(base, "releases/20261123-000000-abc1234"),
    join(sys, "fs/cgroup/backend"),
    join(sys, "fs/cgroup/kiosk"),
    join(sys, "class/thermal/thermal_zone0"),
    join(sys, "class/thermal/cooling_device0"),
    join(sys, "class/net/wlan0"),
  ])
    await mkdir(d, { recursive: true });
  await symlink(
    join(base, "releases/20261123-000000-abc1234"),
    join(base, "current"),
  );
  await writeFile(join(sys, "fs/cgroup/backend/cgroup.procs"), `${pid}\n`);
  await writeFile(join(sys, "fs/cgroup/kiosk/cgroup.procs"), `${pid}\n`);
  await writeFile(join(sys, "class/thermal/thermal_zone0/temp"), "45000\n");
  await writeFile(join(sys, "class/thermal/cooling_device0/type"), "pwm-fan\n");
  await writeFile(join(sys, "class/thermal/cooling_device0/cur_state"), "2\n");
  await writeFile(join(sys, "class/net/wlan0/operstate"), "up\n");
  await writeFile(join(data, "signage.db"), Buffer.alloc(4096));
  await writeFile(join(data, "signage.db-wal"), Buffer.alloc(100));
  await writeFile(kioskMode, "ok");
  const systemctlLog = join(root, "systemctl.log");
  await tool(bin, "systemctl", [
    `printf '%s\\n' "$*" >> '${systemctlLog}'`,
    'case "$*" in',
    `  *--user*) [ "$(cat '${kioskMode}')" = ok ] || exit 1`,
    "    printf 'ActiveState=active\\nNRestarts=0\\nControlGroup=/kiosk\\n' ;;",
    `  *MainPID*) echo ${pid} ;;`,
    "  *nginx*) printf 'ActiveState=active\\nNRestarts=0\\nControlGroup=\\n' ;;",
    "  *) printf 'ActiveState=active\\nNRestarts=2\\nControlGroup=/backend\\n' ;;",
    "esac",
  ]);
  await tool(bin, "vcgencmd", ["echo throttled=0x0"]);
  await tool(bin, "journalctl", [
    "echo 'Archived and active journals take up 24.0M in the file system.'",
  ]);
  await tool(bin, "timedatectl", ["echo yes"]);
  await tool(bin, "ip", ["echo 'default via 192.0.2.1 dev wlan0'"]);
  await tool(bin, "pgrep", [`echo ${pid}`]);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HDS_METRICS_DIR: metrics,
    HDS_DATA_DIR: data,
    HDS_BASE: base,
    HDS_SYSFS: sys,
    HDS_API_BASE: await api(),
  };
  return { metrics, kioskMode, systemctlLog, env };
}

async function rows(dir: string, prefix: string) {
  const files = (await readdir(dir)).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".csv"),
  );
  expect(files).toHaveLength(1);
  const lines = (await readFile(join(dir, files[0]), "utf8"))
    .trimEnd()
    .split("\n");
  // Exactly one header line, at the top.
  expect(lines[0]).toMatch(/^ts_utc,seq,boot_id,/);
  expect(lines.filter((line) => line.startsWith("ts_utc,"))).toHaveLength(1);
  const header = lines[0].split(",");
  expect(new Set(header).size).toBe(header.length);
  return {
    file: join(dir, files[0]),
    text: lines.join("\n"),
    rows: lines.slice(1).map((line) => {
      const values = line.split(",");
      expect(values).toHaveLength(header.length);
      return Object.fromEntries(header.map((h, i) => [h, values[i]]));
    }),
  };
}

linux("scripts pass the shell syntax check", async () => {
  for (const script of [collect, render]) {
    const result = await new Promise<number>((done) =>
      execFile("sh", ["-n", script], (error) =>
        done(error ? Number(error.code ?? 1) : 0),
      ),
    );
    expect(result).toBe(0);
  }
});

linux(
  "writes one row of numbers, states and meta values",
  async () => {
    const { metrics, systemctlLog, env } = await collectSetup();
    expect((await run(collect, env)).code).toBe(0);
    expect((await run(collect, env)).code).toBe(0);
    const {
      rows: [first, second],
      text,
    } = await rows(metrics, "metrics-");
    expect(Object.keys(first)).toHaveLength(77);
    expect(first).toMatchObject({
      seq: "1",
      release: "20261123-000000-abc1234",
      backend_state: "active",
      backend_restarts: "2",
      backend_main_pid: String(process.pid),
      nginx_state: "active",
      kiosk_state: "active",
      chromium_procs: "1",
      temp_millic: "45000",
      fan_state: "2",
      throttled: "0x0",
      db_bytes: "4096",
      wal_bytes: "100",
      shm_bytes: "ERR",
      journal_bytes: String(24 * 1048576),
      wlan_operstate: "up",
      default_route: "1",
      ntp_synchronized: "yes",
      time_result: "OK",
      availability: "available",
      states_result: "OK",
      schedule_last_result: "success",
      schedule_source: "externalApi",
      rain_forecast_source: "ERR",
    });
    expect(first.ts_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number(first.backend_rss_kb)).toBeGreaterThan(0);
    expect(Number(first.backend_pss_kb)).toBeGreaterThan(0);
    expect(Number(first.backend_fds)).toBeGreaterThan(0);
    expect(Number(first.script_ms)).toBeGreaterThanOrEqual(0);
    // PSS and the journal size are taken about every 10 minutes.
    expect(second).toMatchObject({
      seq: "2",
      backend_pss_kb: "",
      chromium_pss_kb: "",
      journal_bytes: "",
    });
    expect(text).not.toContain("SECRET");
    const show = "show -p ActiveState -p NRestarts -p ControlGroup";
    expect(
      (await readFile(systemctlLog, "utf8")).trimEnd().split("\n").slice(0, 4),
    ).toEqual([
      `${show} home-digital-signage-backend.service`,
      "show -p MainPID --value home-digital-signage-backend.service",
      `${show} nginx.service`,
      `--user -M signage@ ${show} home-digital-signage-kiosk.service`,
    ]);
  },
  20_000,
);

linux(
  "falls back to the Chromium processes when the Kiosk unit cannot be read",
  async () => {
    const { metrics, kioskMode, env } = await collectSetup();
    await writeFile(kioskMode, "fail");
    expect((await run(collect, env)).code).toBe(0);
    const {
      rows: [row],
    } = await rows(metrics, "metrics-");
    expect(row).toMatchObject({
      kiosk_state: "ERR",
      kiosk_restarts: "ERR",
      chromium_procs: "1",
    });
  },
  20_000,
);

linux(
  "still writes a row when the API does not answer",
  async () => {
    const { metrics, env } = await collectSetup();
    const result = await run(collect, {
      ...env,
      HDS_API_BASE: "http://127.0.0.1:9",
    });
    expect(result.code).toBe(0);
    const {
      rows: [row],
    } = await rows(metrics, "metrics-");
    expect(row.time_result).toBe("CONN_ERR");
    expect(row.schedule_last_attempt_at).toBe("ERR");
  },
  20_000,
);

linux(
  "does nothing while another run holds the lock",
  async () => {
    const { metrics, env } = await collectSetup();
    const holder = spawn("flock", [join(metrics, ".lock"), "sleep", "3"]);
    await new Promise((done) => setTimeout(done, 500));
    expect((await run(collect, env)).code).toBe(0);
    holder.kill();
    expect((await readdir(metrics)).some((f) => f.startsWith("metrics-"))).toBe(
      false,
    );
  },
  20_000,
);

linux(
  "reports a failed write and writes again on the next run",
  async () => {
    const { metrics, env } = await collectSetup();
    expect((await run(collect, env)).code).toBe(0);
    const { file } = await rows(metrics, "metrics-");
    // A directory in place of the CSV makes the write fail even as root
    // (a read-only file does not stop root).
    await rename(file, `${file}.saved`);
    await mkdir(file);
    const failed = await run(collect, env);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("cannot write the CSV row");
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
    expect((await run(collect, env)).code).toBe(0);
    const { rows: all } = await rows(metrics, "metrics-");
    // seq 2 is the failed run: a gap in seq shows the missing row.
    expect(all.map((r) => r.seq)).toEqual(["1", "3"]);
  },
  20_000,
);

linux(
  "keeps measuring when a value of one process cannot be read",
  async () => {
    const { metrics, env } = await collectSetup();
    const proc = join(metrics, "..", "proc");
    // utime and stime are fields 14 and 15 of /proc/PID/stat.
    const stat = (pid: number, state: string, utime: number, stime: number) =>
      `${pid} (chromium) ${state} 1 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0\n`;
    const processes: Array<{
      pid: number;
      state: string;
      rss?: number;
      pss?: number;
    }> = [
      { pid: 101, state: "S", rss: 1000, pss: 500 },
      { pid: 102, state: "S", rss: 2000 }, // no smaps_rollup: PSS is ERR
      { pid: 103, state: "S", pss: 700 }, // no VmRSS: RSS is ERR
      { pid: 104, state: "Z", rss: 9000, pss: 9000 }, // zombie: not counted
    ];
    for (const p of processes) {
      const dir = join(proc, String(p.pid));
      await mkdir(join(dir, "fd"), { recursive: true });
      await writeFile(join(dir, "fd", "0"), "");
      await writeFile(join(dir, "stat"), stat(p.pid, p.state, 7, 3));
      await writeFile(
        join(dir, "status"),
        p.rss === undefined ? "Name:\tchromium\n" : `VmRSS:\t${p.rss} kB\n`,
      );
      if (p.pss !== undefined)
        await writeFile(join(dir, "smaps_rollup"), `Pss: ${p.pss} kB\n`);
    }
    // 105 has exited (no /proc/105): not counted.
    await writeFile(
      join(env.HDS_SYSFS, "fs/cgroup/kiosk/cgroup.procs"),
      "101\n102\n103\n104\n105\n",
    );
    expect((await run(collect, { ...env, HDS_PROC: proc })).code).toBe(0);
    const {
      rows: [row],
    } = await rows(metrics, "metrics-");
    expect(row).toMatchObject({
      chromium_procs: "3",
      chromium_rss_kb: "ERR",
      chromium_pss_kb: "ERR",
      chromium_cpu_ticks: "30",
    });
    // The other values of the row are still measured.
    expect(row.time_result).toBe("OK");
    expect(row.db_bytes).toBe("4096");
  },
  20_000,
);

linux(
  "counts the Chromium main process that moved into its own scope",
  async () => {
    const { metrics, env } = await collectSetup();
    const proc = join(metrics, "..", "proc");
    const stat = (pid: number) =>
      `${pid} (chromium) S 1 1 1 0 -1 0 0 0 0 0 7 3 0 0\n`;
    for (const [pid, rss, pss] of [
      [201, 1000, 100], // a child left in the Kiosk unit
      [202, 3000, 300], // the main process in its own scope
    ]) {
      const dir = join(proc, String(pid));
      await mkdir(join(dir, "fd"), { recursive: true });
      await writeFile(join(dir, "stat"), stat(pid));
      await writeFile(join(dir, "status"), `VmRSS:\t${rss} kB\n`);
      await writeFile(join(dir, "smaps_rollup"), `Pss: ${pss} kB\n`);
    }
    const cgroup = join(env.HDS_SYSFS, "fs/cgroup");
    await writeFile(join(cgroup, "kiosk/cgroup.procs"), "201\n");
    // The Kiosk unit is /kiosk in the fake tree, so its scope is next to it.
    await mkdir(join(cgroup, "app-org.chromium.Chromium-202.scope"));
    await writeFile(
      join(cgroup, "app-org.chromium.Chromium-202.scope/cgroup.procs"),
      "202\n",
    );
    expect((await run(collect, { ...env, HDS_PROC: proc })).code).toBe(0);
    const {
      rows: [row],
    } = await rows(metrics, "metrics-");
    expect(row).toMatchObject({
      kiosk_state: "active",
      chromium_procs: "2",
      chromium_rss_kb: "4000",
      chromium_pss_kb: "400",
      chromium_cpu_ticks: "20",
    });
  },
  20_000,
);

linux("fails without the metrics directory", async () => {
  const result = await run(collect, {
    PATH: process.env.PATH,
    HDS_METRICS_DIR: "/nonexistent/hds-metrics",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("metrics directory is missing");
});

async function renderSetup(withGrim = true) {
  const root = await mkdtemp(join(tmpdir(), "hds-render-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const runtime = join(root, "run");
  const screen = join(root, "screen");
  for (const d of [bin, state, runtime]) await mkdir(d);
  await writeFile(screen, "frame-1");
  if (withGrim)
    await tool(bin, "grim", [
      `[ "$(cat '${screen}')" != fail ] || exit 1`,
      `cp '${screen}' "$1"`,
    ]);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HDS_RENDER_DIR: state,
    XDG_RUNTIME_DIR: runtime,
    WAYLAND_DISPLAY: "wayland-0",
  };
  return { state, runtime, screen, env };
}

linux(
  "records CHANGED, SAME and CAPTURE_FAIL and keeps no image",
  async () => {
    const { state, runtime, screen, env } = await renderSetup();
    expect((await run(render, env)).code).toBe(0); // frame-1
    expect((await run(render, env)).code).toBe(0); // frame-1 again
    await writeFile(screen, "fail");
    expect((await run(render, env)).code).toBe(0);
    await writeFile(screen, "frame-1");
    expect((await run(render, env)).code).toBe(0); // same as the last success
    await writeFile(screen, "frame-2");
    expect((await run(render, env)).code).toBe(0);
    const { rows: all } = await rows(state, "render-");
    expect(all.map((r) => [r.result, r.reason])).toEqual([
      ["CHANGED", ""],
      ["SAME", ""],
      ["CAPTURE_FAIL", "grim_failed"],
      ["SAME", ""],
      ["CHANGED", ""],
    ]);
    expect(all[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(all[2].sha256).toBe("");
    expect(await readdir(runtime)).toEqual([]);
  },
  20_000,
);

linux(
  "records CAPTURE_FAIL without a display or grim",
  async () => {
    const noDisplay = await renderSetup();
    const env: NodeJS.ProcessEnv = { ...noDisplay.env };
    delete env.WAYLAND_DISPLAY;
    expect((await run(render, env)).code).toBe(0);
    const noGrim = await renderSetup(false);
    expect((await run(render, noGrim.env)).code).toBe(0);
    const [a] = (await rows(noDisplay.state, "render-")).rows;
    const [b] = (await rows(noGrim.state, "render-")).rows;
    expect([a.result, a.reason]).toEqual(["CAPTURE_FAIL", "no_display"]);
    expect([b.result, b.reason]).toEqual(["CAPTURE_FAIL", "no_grim"]);
  },
  20_000,
);

test("units run the scripts of the current release", async () => {
  const units = {
    "deploy/systemd/home-digital-signage-metrics.service":
      "scripts/collect-metrics.sh",
    "deploy/systemd/user/home-digital-signage-render-check.service":
      "scripts/check-render.sh",
  };
  for (const [unit, script] of Object.entries(units)) {
    const text = await readFile(resolve(unit), "utf8");
    expect(text).toContain("Type=oneshot");
    expect(text).toContain(
      `ExecStart=/bin/sh /opt/home-digital-signage/current/${script}`,
    );
    await readFile(resolve(script)); // exists
  }
  const timer = await readFile(
    resolve("deploy/systemd/home-digital-signage-metrics.timer"),
    "utf8",
  );
  expect(timer).toContain("OnUnitActiveSec=60s");
  const renderTimer = await readFile(
    resolve("deploy/systemd/user/home-digital-signage-render-check.timer"),
    "utf8",
  );
  expect(renderTimer).toContain("OnUnitActiveSec=5min");
});
