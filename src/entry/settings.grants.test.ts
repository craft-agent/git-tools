import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  forwardedVariables,
  grantKeyVariable,
  parseSettings,
  parseTargetSettings,
  parseToolSettings,
  settingsFromOptions,
} from "./settings"
import { DEFAULT_GRANTS, failure, profile } from "./settings.testing"

type Env = Record<string, string | undefined>

const KEY = "k".repeat(32)
const parse = (argv: string[], env: Env = {}) => parseSettings(argv, env, profile).grants
const parseTool = (argv: string[], env: Env = {}) => parseToolSettings(argv, env, profile).grants
const parseTarget = (argv: string[], env: Env = {}) => parseTargetSettings(argv, env, profile).grants
const fromOptions = (options: Record<string, unknown>, env: Env = {}) =>
  settingsFromOptions(options, env, profile).grants

/** Every way a package's entry points read the grant settings: the same input must give the same context. */
const readers: [string, (flags: string[], env: Env) => ReturnType<typeof parse>][] = [
  ["parseSettings", parse],
  ["parseToolSettings", parseTool],
  ["parseTargetSettings", parseTarget],
]

describe.each(readers)("the grant settings of %s", (_name, read) => {
  test("default to attended, the state directory and no key", () => {
    expect(read([], {})).toEqual(DEFAULT_GRANTS)
  })

  test("read the flags", () => {
    expect(read(["--unattended", "--grants-dir", "/srv/grants"], {})).toEqual({
      unattended: true,
      dir: "/srv/grants",
      key: undefined,
    })
    expect(read(["--grants-dir=/srv/./grants/../g"], {}).dir).toBe("/srv/g")
  })

  test("read the variables, and a flag wins over its variable", () => {
    const env = { DEMO_UNATTENDED: "true", DEMO_GRANTS_DIR: "/env/grants" }
    expect(read([], env)).toMatchObject({ unattended: true, dir: "/env/grants" })
    expect(read(["--grants-dir", "/flag/grants"], env)).toMatchObject({ unattended: true, dir: "/flag/grants" })
    expect(read(["--unattended"], { DEMO_UNATTENDED: "false" }).unattended).toBe(true)
    expect(read([], { DEMO_UNATTENDED: "0" }).unattended).toBe(false)
  })

  test("expand ~ with HOME when absolute, else with the account's home", () => {
    expect(read(["--grants-dir=~/g"], { HOME: "/home/me" }).dir).toBe("/home/me/g")
    expect(read(["--grants-dir=~/g"], { HOME: "relative" }).dir).toBe(join(homedir(), "g"))
  })

  test("take the default directory under XDG_STATE_HOME when it is absolute, else under the home", () => {
    expect(read([], { XDG_STATE_HOME: "/var/state" }).dir).toBe("/var/state/demo-tools/grants")
    expect(read([], { XDG_STATE_HOME: "state", HOME: "/home/me" }).dir).toBe("/home/me/.local/state/demo-tools/grants")
    expect(read([], { HOME: "/home/me" }).dir).toBe("/home/me/.local/state/demo-tools/grants")
    expect(read([], { XDG_STATE_HOME: "", HOME: "/home/me" }).dir).toBe("/home/me/.local/state/demo-tools/grants")
  })

  test("count a blank directory as unset", () => {
    expect(read(["--grants-dir= "], { DEMO_GRANTS_DIR: "/env" })).toMatchObject({ dir: DEFAULT_GRANTS.dir })
    expect(read([], { DEMO_GRANTS_DIR: " " }).dir).toBe(DEFAULT_GRANTS.dir)
  })

  test("refuse a relative directory, naming where it came from", () => {
    expect(failure(() => read(["--grants-dir=rel/g"], {})).message).toBe("--grants-dir must be an absolute path.")
    expect(failure(() => read([], { DEMO_GRANTS_DIR: "rel" })).message).toBe(
      "DEMO_GRANTS_DIR must be an absolute path.",
    )
  })

  test("refuse a value of --unattended and a bad variable, naming them", () => {
    expect(failure(() => read(["--unattended=1"], {})).message).toContain("--unattended")
    expect(failure(() => read([], { DEMO_UNATTENDED: "yes" })).message).toContain("DEMO_UNATTENDED")
  })

  test("read the key from its variable alone", () => {
    expect(read([], { DEMO_GRANT_KEY: KEY }).key).toEqual(Buffer.from(KEY, "utf8"))
    expect(read([], { DEMO_GRANT_KEY: ` ${KEY} ` }).key).toEqual(Buffer.from(` ${KEY} `, "utf8"))
    expect(failure(() => read(["--grant-key", KEY], {})).message).toContain("--grant-key")
  })

  test("count a missing or blank key as no key", () => {
    for (const value of [undefined, "", " ", " ".repeat(40)])
      expect(read([], { DEMO_GRANT_KEY: value }).key).toBeUndefined()
  })

  test("refuse a key under 32 characters, naming the variable and never the key", () => {
    const short = "s3cret-".repeat(4).slice(0, 31)
    const message = failure(() => read([], { DEMO_GRANT_KEY: short })).message
    expect(message).toBe("DEMO_GRANT_KEY must be at least 32 characters.")
    expect(message).not.toContain(short)
    expect(read([], { DEMO_GRANT_KEY: "k".repeat(32) }).key).toBeDefined()
  })
})

describe("the grant settings of a plugin's options", () => {
  test("default as the command line does", () => {
    expect(fromOptions({})).toEqual(DEFAULT_GRANTS)
  })

  test("read unattended and grants_dir, and an option wins over its variable", () => {
    expect(fromOptions({ unattended: true, grants_dir: " ~/g " }, { HOME: "/home/me" })).toEqual({
      unattended: true,
      dir: "/home/me/g",
      key: undefined,
    })
    const env = { DEMO_UNATTENDED: "true", DEMO_GRANTS_DIR: "/env/grants" }
    expect(fromOptions({}, env)).toMatchObject({ unattended: true, dir: "/env/grants" })
    expect(fromOptions({ unattended: false, grants_dir: "/opt/grants" }, env)).toMatchObject({
      unattended: false,
      dir: "/opt/grants",
    })
    expect(fromOptions({ unattended: false }, { DEMO_UNATTENDED: "yes" }).unattended).toBe(false)
  })

  test("count a blank directory as unset", () => {
    expect(fromOptions({ grants_dir: " " }, { DEMO_GRANTS_DIR: "/env" }).dir).toBe(DEFAULT_GRANTS.dir)
  })

  test("refuse a wrong type or a relative directory, naming the option", () => {
    expect(failure(() => fromOptions({ unattended: "true" })).message).toBe(
      'Option "unattended" must be true or false.',
    )
    expect(failure(() => fromOptions({ grants_dir: 1 })).message).toBe('Option "grants_dir" must be an absolute path.')
    expect(failure(() => fromOptions({ grants_dir: "rel" })).message).toBe(
      'Option "grants_dir" must be an absolute path.',
    )
    expect(failure(() => fromOptions({}, { DEMO_GRANTS_DIR: "rel" })).message).toContain("DEMO_GRANTS_DIR")
  })

  test("read the key from its variable alone, and refuse a short one without quoting it", () => {
    expect(fromOptions({}, { DEMO_GRANT_KEY: KEY }).key).toEqual(Buffer.from(KEY, "utf8"))
    expect(failure(() => fromOptions({ grant_key: KEY })).message).toContain('"grant_key"')
    const message = failure(() => fromOptions({}, { DEMO_GRANT_KEY: "short" })).message
    expect(message).toBe("DEMO_GRANT_KEY must be at least 32 characters.")
  })
})

describe("grantKeyVariable", () => {
  test("is the profile's prefix and GRANT_KEY, and forwarded", () => {
    expect(grantKeyVariable(profile)).toBe("DEMO_GRANT_KEY")
    expect(forwardedVariables(profile, [])).toContain("DEMO_GRANT_KEY")
  })
})
