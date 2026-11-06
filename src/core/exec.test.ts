import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exec } from "./exec"

const ENV = { PATH: process.env.PATH ?? "" }

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("exec", () => {
  test("collects stdout, stderr and the exit code", async () => {
    const result = await exec(
      ["node", "-e", 'process.stdout.write("out é");process.stderr.write("err");process.exit(3)'],
      {
        env: ENV,
      },
    )
    expect(result).toEqual({ code: 3, stdout: "out é", stderr: "err" })
  })

  test("passes the given environment exactly", async () => {
    process.env.EXEC_TEST_LEAK = "leaked"
    try {
      const result = await exec(
        ["node", "-e", "process.stdout.write(JSON.stringify(process.env.EXEC_TEST_LEAK ?? null))"],
        {
          env: { ...ENV, ONLY: "this" },
        },
      )
      expect(result.stdout).toBe("null")
    } finally {
      delete process.env.EXEC_TEST_LEAK
    }
  })

  test("writes stdin and closes it", async () => {
    const result = await exec(["node", "-e", "process.stdin.pipe(process.stdout)"], { env: ENV, stdin: "hello" })
    expect(result.stdout).toBe("hello")
  })

  test("rejects with ENOENT for a program that does not exist", async () => {
    const error = await exec(["definitely-not-a-program"], { env: ENV }).catch((e: unknown) => e)
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
  })

  test("an abort kills the child and rejects with an AbortError", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = exec(["node", "-e", "setTimeout(() => {}, 10000)"], { env: ENV, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const error = await pending.catch((e: unknown) => e)
    expect((error as Error).name).toBe("AbortError")
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("an already aborted signal rejects without running the program", async () => {
    const error = await exec(["node", "-e", "1"], { env: ENV, signal: AbortSignal.abort() }).catch((e: unknown) => e)
    expect((error as Error).name).toBe("AbortError")
  })

  test("a timeout stops the child with SIGTERM and reports the signal and the timeout", async () => {
    const result = await exec(["node", "-e", "setTimeout(() => {}, 10000)"], { env: ENV, timeoutMs: 100 })
    expect(result.signal).toBe("SIGTERM")
    expect(result.code).toBe(-1)
    expect(result.timedOut).toBe(true)
  })

  test("a child that survives SIGTERM is sent SIGKILL after the grace period", async () => {
    const started = Date.now()
    const script = 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 10000)'
    // The limit leaves node time to start and install its SIGTERM handler.
    const result = await exec(["node", "-e", script], { env: ENV, timeoutMs: 1000 })
    expect(result.signal).toBe("SIGKILL")
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
    expect(Date.now() - started).toBeLessThan(7000)
  })

  test("a child that finishes in time is not reported as timed out", async () => {
    const result = await exec(["node", "-e", "1"], { env: ENV, timeoutMs: 5000 })
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  test("an abort sends SIGKILL to a child that ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-kill-"))
    const pidFile = join(dir, "pid")
    try {
      const script = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 10000)`
      const controller = new AbortController()
      const pending = exec(["node", "-e", script], { env: ENV, signal: controller.signal })
      while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) await new Promise((r) => setTimeout(r, 20))
      controller.abort()
      await pending.catch(() => {})
      const pid = Number(readFileSync(pidFile, "utf8"))
      const deadline = Date.now() + 6000
      while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(isAlive(pid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("settles when the child exits even if a grandchild keeps its output open", async () => {
    const script = `
      const { spawn } = require("child_process")
      spawn("node", ["-e", "setTimeout(() => {}, 3000)"], { stdio: "inherit" }).unref()
      process.stdout.write("hi")
    `
    const started = Date.now()
    const result = await exec(["node", "-e", script], { env: ENV })
    expect(result).toEqual({ code: 0, stdout: "hi", stderr: "" })
    expect(Date.now() - started).toBeLessThan(2500)
  })
})
