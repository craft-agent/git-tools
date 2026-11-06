import { describe, expect, test } from "bun:test"
import { SetupError } from "./errors.mjs"
import { removeMarkedBlocks } from "./markers.mjs"

const DOCUMENT = `# Title

<!-- starter -->

## Using this starter

<!-- /starter -->

Kept.

<!-- example -->

### Notes

<!-- /example -->

## Last
`

describe("removeMarkedBlocks", () => {
  test("removes the starter blocks and the example blocks with their content", () => {
    const { text, count } = removeMarkedBlocks(DOCUMENT, { keepExample: false }, "README.md")
    expect(text).toBe("# Title\n\nKept.\n\n## Last\n")
    expect(count).toBe(2)
  })

  test("with keepExample drops only the example markers", () => {
    const { text } = removeMarkedBlocks(DOCUMENT, { keepExample: true }, "README.md")
    expect(text).toBe("# Title\n\nKept.\n\n### Notes\n\n## Last\n")
  })

  test("a block at the end leaves one final newline", () => {
    const { text } = removeMarkedBlocks("Text\n\n<!-- starter -->\n\nGone\n\n<!-- /starter -->\n", {}, "x.md")
    expect(text).toBe("Text\n")
  })

  test("a file without markers is returned as it is, blank lines included", () => {
    const plain = "A\n\n\n\nB\n"
    expect(removeMarkedBlocks(plain, { keepExample: false }, "x.md")).toEqual({ text: plain, count: 0 })
  })

  test.each([
    ["an unclosed block", "<!-- starter -->\nx\n"],
    ["a closing marker alone", "x\n<!-- /example -->\n"],
    ["a closing marker of the other kind", "<!-- starter -->\n<!-- /example -->\n"],
    ["a nested block", "<!-- starter -->\n<!-- example -->\n<!-- /example -->\n<!-- /starter -->\n"],
  ])("refuses %s", (_, text) => {
    expect(() => removeMarkedBlocks(text, { keepExample: true }, "docs/x.md")).toThrow(SetupError)
    expect(() => removeMarkedBlocks(text, { keepExample: true }, "docs/x.md")).toThrow("docs/x.md:")
  })
})
