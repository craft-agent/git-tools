import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ServerOptions } from "./server"
import { call, cleanups, connect, runCleanups, settings, settle, tool, type Call, type ClientSetup } from "./testing"

afterEach(runCleanups)

describe("working directory", () => {
  const roots = { roots: { listChanged: true } }
  const MISSING_URI = pathToFileURL("/no/such/dir").href

  function dir() {
    const made = realpathSync(mkdtempSync(join(tmpdir(), "roots-dir-")))
    cleanups.push(() => rmSync(made, { recursive: true, force: true }))
    return made
  }

  async function setup(client: ClientSetup, options?: ServerOptions) {
    const calls: Call[] = []
    const connected = await connect([tool("demo_thing_read", "alpha", "read", calls)], settings(), client, options)
    const cwd = async () => {
      await call(connected.client, "demo_thing_read")
      return calls.at(-1)!.ctx.cwd
    }
    return { ...connected, calls, cwd }
  }

  test("a root that is a local directory is the working directory", async () => {
    const root = dir()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [root] } })
    expect(await cwd()).toBe(root)
  })

  test("the first usable root wins", async () => {
    const first = dir()
    const second = dir()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [first, second] } })
    expect(await cwd()).toBe(first)
  })

  test("the root itself is used, however deep it is", async () => {
    const top = dir()
    const nested = join(top, "src")
    mkdirSync(nested)
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [nested] } })
    expect(await cwd()).toBe(nested)
  })

  test("a root that is missing or is a file is skipped for the first directory", async () => {
    const root = dir()
    const file = join(root, "file.txt")
    writeFileSync(file, "text")
    const found = dir()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [join(root, "missing"), file, found] } })
    expect(await cwd()).toBe(found)
  })

  test("a root on another host is skipped, and the search goes on", async () => {
    const found = dir()
    const { cwd } = await setup(
      { capabilities: roots, roots: { dirs: ["file://remote-host/x", found] } },
      { cwd: () => "/fallback" },
    )
    expect(await cwd()).toBe(found)
  })

  test("a file URI naming a missing directory is skipped, and the search goes on", async () => {
    const found = dir()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [MISSING_URI, found] } })
    expect(await cwd()).toBe(found)
  })

  test("a root inside the install directory is skipped", async () => {
    const own = dir()
    const nested = join(own, "src")
    mkdirSync(nested)
    const found = dir()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [nested, own, found] } }, { ownDir: own })
    expect(await cwd()).toBe(found)
  })

  test("with only roots inside the install directory the fallback directory is used", async () => {
    const own = dir()
    const { cwd } = await setup(
      { capabilities: roots, roots: { dirs: [own] } },
      { cwd: () => "/fallback", ownDir: own },
    )
    expect(await cwd()).toBe("/fallback")
  })

  test("without an install directory a root is used wherever it is", async () => {
    const own = dir()
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [own] } })
    expect(await cwd()).toBe(own)
  })

  test("the install directory reaches the tool's context", async () => {
    const { calls, cwd } = await setup({}, { ownDir: "/opt/install" })
    await cwd()
    expect(calls.at(-1)!.ctx.ownDir).toBe("/opt/install")
  })

  test("only bad roots fall back to the fallback directory", async () => {
    const { cwd } = await setup(
      { capabilities: roots, roots: { dirs: ["file://remote-host/x", MISSING_URI] } },
      { cwd: () => "/fallback" },
    )
    expect(await cwd()).toBe("/fallback")
  })

  test("a client that lists no roots gets the fallback directory", async () => {
    const { cwd } = await setup({ capabilities: roots, roots: { dirs: [] } }, { cwd: () => "/fallback" })
    expect(await cwd()).toBe("/fallback")
  })

  test("a client that advertises no roots gets options.cwd()", async () => {
    const { cwd, seen } = await setup({}, { cwd: () => "/from/options" })
    expect(await cwd()).toBe("/from/options")
    expect(seen.rootsRequests).toBe(0)
  })

  test("without options.cwd the process directory is the fallback", async () => {
    const { cwd } = await setup({})
    expect(await cwd()).toBe(process.cwd())
  })

  test("the answer is cached until the client reports its roots changed", async () => {
    const first = dir()
    const second = dir()
    const client = { capabilities: roots, roots: { dirs: [first] } }
    const { client: mcpClient, cwd, seen } = await setup(client)

    expect(await cwd()).toBe(first)
    expect(await cwd()).toBe(first)
    expect(seen.rootsRequests).toBe(1)

    client.roots.dirs = [second]
    expect(await cwd()).toBe(first)
    expect(seen.rootsRequests).toBe(1)

    await mcpClient.sendRootsListChanged()
    await settle()
    expect(await cwd()).toBe(second)
    expect(seen.rootsRequests).toBe(2)
  })
})
