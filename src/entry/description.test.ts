import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { MAX_VALUE_LENGTH, type CallDescription, type ToolContext, type ToolSpec } from "../core"
import { approvalPrompt, permissionDescription } from "./description"
import { visible } from "./visible"

const CTX: ToolContext = { cwd: "/work", ownDir: "/own" }
const input = z.object({ name: z.string().default("x") })

type Describer = NonNullable<ToolSpec<typeof input>["describe"]>

function specWith(describer?: Describer) {
  return { input, describe: describer } as Pick<ToolSpec, "input" | "describe">
}

const answering = (answer: unknown) => specWith((async () => answer) as unknown as Describer)

describe("visible", () => {
  test.each([
    ["\t", "<U+0009>"],
    ["\n", "<U+000A>"],
    ["\r", "<U+000D>"],
    ["\u007f", "<U+007F>"],
    ["\u0085", "<U+0085>"],
    ["\u202e", "<U+202E>"],
    ["\u2066", "<U+2066>"],
    ["\u200b", "<U+200B>"],
    ["\u200d", "<U+200D>"],
    ["\ufeff", "<U+FEFF>"],
    ["\u00ad", "<U+00AD>"],
    ["\u2028", "<U+2028>"],
    ["\u2029", "<U+2029>"],
    ["\u{e0041}", "<U+E0041>"],
    ["\u3164", "<U+3164>"],
    ["\u115f", "<U+115F>"],
    ["\u1160", "<U+1160>"],
    ["\uffa0", "<U+FFA0>"],
    ["\u034f", "<U+034F>"],
    ["\u17b4", "<U+17B4>"],
    ["\u180b", "<U+180B>"],
    ["\ufe0f", "<U+FE0F>"],
    ["\ufff0", "<U+FFF0>"],
    ["\u{1bca0}", "<U+1BCA0>"],
    ["\u{1d173}", "<U+1D173>"],
    ["\u{e0100}", "<U+E0100>"],
    ["\ud800", "<U+D800>"],
  ])("marks %j as %s", (character, mark) => {
    expect(visible(`a${character}b`)).toBe(`a${mark}b`)
  })

  test("keeps ordinary spaces, visible text, emoji and combining marks", () => {
    for (const text of ["a b", "\u00a0", "\u3000", "日本語", "😀", "e\u0301"]) expect(visible(text)).toBe(text)
  })

  test("pads the hex to four digits and no further", () => {
    expect(visible("\u0001")).toBe("<U+0001>")
    expect(visible("\u{e0001}")).toBe("<U+E0001>")
    expect(visible("\u{e0041}x")).toBe("<U+E0041>x")
  })

  test("marks a lone surrogate once and keeps a pair", () => {
    expect(visible("\ud800\ud800")).toBe("<U+D800><U+D800>")
    expect(visible("\udc00😀")).toBe("<U+DC00>😀")
  })

  test("keeps \\n, turns \\r\\n into \\n and marks a lone \\r with keepNewlines", () => {
    expect(visible("a\nb\r\nc\rd\t", { keepNewlines: true })).toBe("a\nb\nc<U+000D>d<U+0009>")
    expect(visible("a\r\nb")).toBe("a<U+000D><U+000A>b")
  })

  test("is stable", () => {
    const text = "a\u202e\r\nb\ud800\u200d\u{e0041}\n"
    for (const options of [{}, { keepNewlines: true }]) {
      expect(visible(visible(text, options), options)).toBe(visible(text, options))
    }
  })
})

describe("permissionDescription", () => {
  test("is undefined for a tool without a describer", async () => {
    expect(await permissionDescription(specWith(), {}, CTX)).toBeUndefined()
  })

  test("gives the description with its characters marked, as a fresh object", async () => {
    const given: CallDescription = {
      facts: [{ label: "Na\u202eme", value: "a\u200bb" }],
      text: { label: "Bo\u202ady", body: "line\r\nnext\rend" },
    }
    const result = await permissionDescription(answering(given), {}, CTX)
    expect(result).toEqual({
      facts: [{ label: "Na<U+202E>me", value: "a<U+200B>b" }],
      text: { label: "Bo<U+202A>dy", body: "line\nnext<U+000D>end" },
    })
    expect(result).not.toBe(given)
  })

  test("has no headline or text key when the description has none", async () => {
    const result = await permissionDescription(answering({ facts: [{ label: "A", value: "b" }] }), {}, CTX)
    expect(result).toEqual({ facts: [{ label: "A", value: "b" }] })
    expect(result && "headline" in result).toBe(false)
    expect(result && "text" in result).toBe(false)
  })

  test("renders the headline with each value quoted", async () => {
    const headline = { text: "Move {from} to {to}, then {from}", values: { from: "a", to: "b" } }
    const result = await permissionDescription(answering({ headline, facts: [] }), {}, CTX)
    expect(result).toEqual({ headline: 'Move "a" to "b", then "a"', facts: [] })
  })

  test("escapes a backslash and a quote in a headline value", async () => {
    const headline = { text: "Open {path}", values: { path: 'C:\\dir\\"x"' } }
    const result = await permissionDescription(answering({ headline, facts: [] }), {}, CTX)
    expect(result?.headline).toBe('Open "C:\\\\dir\\\\\\"x\\""')
  })

  test("marks hidden characters in a headline value and in the template", async () => {
    const headline = { text: "Re\u202ename {name}", values: { name: "a\u202eb\nc" } }
    const result = await permissionDescription(answering({ headline, facts: [] }), {}, CTX)
    expect(result?.headline).toBe('Re<U+202E>name "a<U+202E>b<U+000A>c"')
  })

  test("does not take a placeholder written inside a value for another one", async () => {
    const headline = { text: "Create {a} and {b}", values: { a: "{b}", b: "x" } }
    const result = await permissionDescription(answering({ headline, facts: [] }), {}, CTX)
    expect(result?.headline).toBe('Create "{b}" and "x"')
  })

  test("shows the title in place of a bad headline", async () => {
    const headline = { text: "Create {name}" }
    const result = await permissionDescription(answering({ headline, facts: [{ label: "A", value: "b" }] }), {}, CTX)
    expect(result).toEqual({ facts: [{ label: "A", value: "b" }] })
  })

  test("fills a value template with its values as written, unquoted and without grouping", async () => {
    const facts = [
      { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 42 } } },
      { label: "Big", value: { text: "{bytes} bytes", values: { bytes: 1234567 } } },
      { label: "Name", value: { text: "{from} to {to}", values: { from: 'a"b\\c', to: "{from}" } } },
      { label: "Plain", value: { text: "no values" } },
    ]
    const result = await permissionDescription(answering({ facts }), {}, CTX)
    expect(result?.facts).toEqual([
      { label: "Size", value: "42 bytes" },
      { label: "Big", value: "1234567 bytes" },
      { label: "Name", value: 'a"b\\c to {from}' },
      { label: "Plain", value: "no values" },
    ])
  })

  test("marks hidden characters in a value template and in its string values", async () => {
    const value = { text: "Si\u202eze {name}", values: { name: "a\u200bb" } }
    const result = await permissionDescription(answering({ facts: [{ label: "Size", value }] }), {}, CTX)
    expect(result?.facts[0]?.value).toBe("Si<U+202E>ze a<U+200B>b")
  })

  test("cuts a filled value template to the value budget", async () => {
    const value = { text: "{name} bytes", values: { name: "a".repeat(MAX_VALUE_LENGTH) } }
    const result = await permissionDescription(answering({ facts: [{ label: "Size", value }] }), {}, CTX)
    expect(result?.facts[0]?.value).toBe(`${"a".repeat(MAX_VALUE_LENGTH - 1)}…`)
  })

  test("gives a bad value template no description", async () => {
    const value = { text: "{bytes} bytes" }
    expect(await permissionDescription(answering({ facts: [{ label: "Size", value }] }), {}, CTX)).toBeUndefined()
  })

  test("gives the describer a signal and the rest of the context", async () => {
    let seen: ToolContext | undefined
    const spec = specWith((_args, ctx) => {
      seen = ctx
      return { facts: [{ label: "A", value: "b" }] }
    })
    await permissionDescription(spec, {}, CTX)
    expect(seen?.cwd).toBe("/work")
    expect(seen?.ownDir).toBe("/own")
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
    expect(seen?.signal?.aborted).toBe(false)
  })

  test("is undefined when the describer never settles", async () => {
    const spec = specWith(() => new Promise<CallDescription>(() => {}))
    expect(await permissionDescription(spec, {}, CTX, 20)).toBeUndefined()
  })

  test("is undefined when the describer rejects with the abort on our timeout", async () => {
    let seen: AbortSignal | undefined
    const spec = specWith(
      (_args, ctx) =>
        new Promise<CallDescription>((_resolve, reject) => {
          seen = ctx.signal
          ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason))
        }),
    )
    expect(await permissionDescription(spec, {}, CTX, 20)).toBeUndefined()
    expect(seen?.aborted).toBe(true)
  })

  test("rethrows the cancellation when the caller aborts while describing", async () => {
    const controller = new AbortController()
    const reason = new Error("stop")
    const spec = specWith(() => new Promise<CallDescription>(() => {}))
    const pending = permissionDescription(spec, {}, { ...CTX, signal: controller.signal })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test("passes the caller's abort on to the describer's signal", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const spec = specWith((_args, ctx) => {
      seen = ctx.signal
      return new Promise<CallDescription>(() => {})
    })
    const pending = permissionDescription(spec, {}, { ...CTX, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(seen?.aborted).toBe(true)
  })

  test("rethrows when the caller's signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      permissionDescription(
        answering({ facts: [{ label: "A", value: "b" }] }),
        {},
        { ...CTX, signal: controller.signal },
      ),
    ).rejects.toBe(controller.signal.reason)
  })

  test("stops listening to the caller's signal once done", async () => {
    const controller = new AbortController()
    const added: unknown[] = []
    const removed: unknown[] = []
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      added.push(listener)
      add(type, listener, options as AddEventListenerOptions)
    }) as typeof add
    controller.signal.removeEventListener = ((type: string, listener: EventListener) => {
      removed.push(listener)
      remove(type, listener)
    }) as typeof remove
    const spec = answering({ facts: [{ label: "A", value: "b" }] })
    await permissionDescription(spec, {}, { ...CTX, signal: controller.signal })
    expect(added).toHaveLength(1)
    expect(removed).toEqual(added)
  })
})

describe("approvalPrompt", () => {
  test("without a description it is the title and a Target line per resource", () => {
    expect(approvalPrompt("Title", ["/a", "/b"], undefined)).toBe("Title\n\n--- Details ---\n\nTarget: /a\nTarget: /b")
  })

  test("without a description and with targets that cannot be told it is the title alone", () => {
    expect(approvalPrompt("Title", ["*"], undefined)).toBe("Title")
  })

  test("shows a * beside named resources as a target", () => {
    expect(approvalPrompt("Title", ["a", "*"], undefined)).toBe("Title\n\n--- Details ---\n\nTarget: a\nTarget: *")
  })

  test("takes the headline, then Details with targets and facts, then the text under its label", () => {
    const description = {
      headline: 'Create the note "todo"',
      facts: [
        { label: "Kind", value: "note" },
        { label: "Size", value: "42 bytes" },
      ],
      text: { label: "Note text", body: "# Todo\n\nbuy milk" },
    }
    expect(approvalPrompt("Title", ["/work/todo.md"], description)).toBe(
      [
        'Create the note "todo"',
        "",
        "--- Details ---",
        "",
        "Target: /work/todo.md",
        "Kind: note",
        "Size: 42 bytes",
        "",
        "--- Note text ---",
        "",
        "# Todo",
        "",
        "buy milk",
      ].join("\n"),
    )
  })

  test("uses the title when the description has no headline", () => {
    expect(approvalPrompt("Title", ["*"], { facts: [{ label: "Kind", value: "group" }] })).toBe(
      "Title\n\n--- Details ---\n\nKind: group",
    )
  })

  test("shows the facts under Details without Target lines when the targets cannot be told", () => {
    const description = {
      facts: [
        { label: "Kind", value: "group" },
        { label: "Size", value: "3 bytes" },
      ],
    }
    expect(approvalPrompt("Title", ["*"], description)).toBe("Title\n\n--- Details ---\n\nKind: group\nSize: 3 bytes")
  })

  test("leaves Details out for a text alone when the targets cannot be told", () => {
    const description = { facts: [], text: { label: "Body", body: "hello" } }
    expect(approvalPrompt("Title", ["*"], description)).toBe("Title\n\n--- Body ---\n\nhello")
  })

  test("leaves Details out with no resources and no facts", () => {
    expect(approvalPrompt("Title", [], undefined)).toBe("Title")
  })

  test("shows a headline alone", () => {
    expect(approvalPrompt("Title", ["*"], { headline: "Create it", facts: [] })).toBe("Create it")
  })

  test("marks hidden characters in the resources", () => {
    expect(approvalPrompt("Title", ["a\u202eb\nc"], undefined)).toBe(
      "Title\n\n--- Details ---\n\nTarget: a<U+202E>b<U+000A>c",
    )
  })
})
