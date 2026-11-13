import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { invoke, type ToolContext } from "../tool"
import { isExemptFromGrants } from "./guard"
import type { Grant } from "./model"
import { addGrant, readGrants } from "./store"
import { grantTools } from "./tools"

const KEY = Buffer.alloc(32, 7)
const GRANT: Grant = {
  id: "grant_0123456789ab",
  tool: "demo_note_create",
  targets: ["/work/a"],
  bounds: {},
  rate: 10,
  created_at: "2026-05-01T00:00:00Z",
  expires_at: "2026-07-01T00:00:00Z",
  reason: "daily notes",
}
const [, , revoke] = grantTools([], "demo")
let dir: string
let ctx: ToolContext

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grant-tools-revoke-"))
  ctx = { cwd: dir, grants: { unattended: true, dir, key: KEY } }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("revoke removes a grant while unattended, without a covering grant or key", async () => {
  await addGrant(ctx.grants!, GRANT)
  expect(isExemptFromGrants(revoke!)).toBe(true)
  expect(await invoke(revoke!, { id: GRANT.id }, { ...ctx, grants: { ...ctx.grants!, key: undefined } })).toEqual({
    id: GRANT.id,
    revoked: true,
  })
  expect(await readGrants(ctx.grants!)).toEqual({ grants: [], failed: [] })
})

test("a missing grant names the real read tool", async () => {
  await expect(invoke(revoke!, { id: GRANT.id }, ctx)).rejects.toMatchObject({
    code: "not_found",
    message: `No grant ${GRANT.id}; demo_grant_read lists the grants.`,
  })
})

test("revoke works on a grant whose MAC fails", async () => {
  await addGrant(ctx.grants!, GRANT)
  const path = join(dir, "grants.json")
  await writeFile(path, (await readFile(path, "utf8")).replace('"rate": 10', '"rate": 100'))
  expect((await readGrants(ctx.grants!)).failed).toEqual([GRANT.id])
  expect(await invoke(revoke!, { id: GRANT.id }, ctx)).toEqual({ id: GRANT.id, revoked: true })
  expect(await readGrants(ctx.grants!)).toEqual({ grants: [], failed: [] })
})

test("the prompt names only the grant", async () => {
  const args = { id: GRANT.id }
  expect(await revoke!.targets!(args, ctx)).toEqual([GRANT.id])
  expect(await revoke!.describe!(args, ctx)).toEqual({
    headline: { text: "About to revoke {id}", values: args },
    facts: [],
  })
})

test("revoke requires setup and a well-formed id", async () => {
  await expect(invoke(revoke!, { id: GRANT.id }, { cwd: dir })).rejects.toMatchObject({
    code: "forbidden",
    details: { reason: "not_set_up" },
  })
  await expect(invoke(revoke!, { id: "*" }, ctx)).rejects.toMatchObject({ code: "invalid_argument" })
})
