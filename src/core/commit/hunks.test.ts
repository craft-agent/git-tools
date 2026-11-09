import { describe, expect, test } from "bun:test"
import { buildPatch, diffDigest, parseHunks } from "./hunks"

const TWO_FILES = `diff --git a/src/one.txt b/src/one.txt
index 1111111..2222222 100644
--- a/src/one.txt
+++ b/src/one.txt
@@ -1,3 +1,3 @@
 keep
-old
+new
 keep
@@ -20,3 +20,4 @@ function name
 keep
+extra
 keep
 keep
diff --git a/two.txt b/two.txt
index 3333333..4444444 100644
--- a/two.txt
+++ b/two.txt
@@ -5 +5 @@
-before
+after
`

describe("parseHunks", () => {
  test("numbers the hunks of several files in diff order and counts their lines", () => {
    const hunks = parseHunks(TWO_FILES)
    expect(hunks.map(({ id, file, header, added, removed }) => ({ id, file, header, added, removed }))).toEqual([
      { id: 1, file: "src/one.txt", header: "@@ -1,3 +1,3 @@", added: 1, removed: 1 },
      { id: 2, file: "src/one.txt", header: "@@ -20,3 +20,4 @@ function name", added: 1, removed: 0 },
      { id: 3, file: "two.txt", header: "@@ -5 +5 @@", added: 1, removed: 1 },
    ])
    expect(hunks[0]!.preamble).toBe(hunks[1]!.preamble)
    expect(hunks[0]!.preamble).not.toBe(hunks[2]!.preamble)
  })

  test("drops the empty line the diff's trailing newline leaves in the last hunk", () => {
    const hunks = parseHunks(TWO_FILES)
    expect(hunks[2]!.body).toBe("@@ -5 +5 @@\n-before\n+after")
  })

  test("reads a binary file as one hunk", () => {
    const hunks = parseHunks(
      "diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nBinary files a/img.png and b/img.png differ\n" +
        "diff --git a/t.txt b/t.txt\n--- a/t.txt\n+++ b/t.txt\n@@ -1 +1 @@\n-a\n+b\n",
    )
    expect(hunks.map(({ id, file, header, binary }) => ({ id, file, header, binary }))).toEqual([
      { id: 1, file: "img.png", header: "(binary)", binary: true },
      { id: 2, file: "t.txt", header: "@@ -1 +1 @@", binary: false },
    ])
  })

  test("keeps spaces in a path and decodes a quoted one", () => {
    const hunks = parseHunks(
      "diff --git a/dir/my file.txt b/dir/my file.txt\n--- a/dir/my file.txt\t\n+++ b/dir/my file.txt\t\n@@ -1 +1 @@\n-a\n+b\n" +
        'diff --git "a/x\\ty\\303\\251.txt" "b/x\\ty\\303\\251.txt"\n--- "a/x\\ty\\303\\251.txt"\n+++ "b/x\\ty\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n' +
        'diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"\n--- "a/say \\"hi\\".txt"\n+++ "b/say \\"hi\\".txt"\n@@ -1 +1 @@\n-a\n+b\n',
    )
    expect(hunks.map((hunk) => hunk.file)).toEqual(["dir/my file.txt", "x\tyé.txt", 'say "hi".txt'])
  })

  test("reads a new file and a deleted file", () => {
    const hunks = parseHunks(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n" +
        "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
    )
    expect(hunks.map(({ file, added, removed }) => ({ file, added, removed }))).toEqual([
      { file: "new.txt", added: 2, removed: 0 },
      { file: "gone.txt", added: 0, removed: 2 },
    ])
  })

  test("leaves out a mode-only change and an empty diff", () => {
    expect(parseHunks("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n")).toEqual([])
    expect(parseHunks("")).toEqual([])
  })
})

describe("buildPatch", () => {
  test("writes a file's header once and re-anchors a hunk after an unselected one", () => {
    const hunks = parseHunks(TWO_FILES)
    const patch = buildPatch([hunks[1]!, hunks[2]!])
    expect(patch.match(/^diff --git /gm)).toHaveLength(2)
    expect(patch).toContain("@@ -20,3 +20,4 @@ function name")
    const both = buildPatch([hunks[0]!, hunks[1]!])
    expect(both).toContain("@@ -20,3 +20,4 @@ function name")
    expect(buildPatch([hunks[1]!])).not.toContain("@@ -1,3")
  })

  test("moves the new-side start back by the lines of an unselected hunk", () => {
    const diff =
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,4 @@\n a\n+x\n+y\n b\n@@ -10,2 +12,3 @@\n c\n+z\n d\n"
    const [first, second] = parseHunks(diff)
    expect(buildPatch([second!])).toContain("@@ -10,2 +10,3 @@")
    expect(buildPatch([first!, second!])).toContain("@@ -10,2 +12,3 @@")
  })

  test("anchors a zero-length side on the line before", () => {
    const diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,0 +4,1 @@\n+x\n@@ -9,2 +11,0 @@\n-a\n-b\n"
    const [, second] = parseHunks(diff)
    expect(buildPatch([second!])).toContain("@@ -9,2 +8,0 @@")
  })
})

describe("diffDigest", () => {
  test("is 16 hex characters, stable for one diff and different for another", () => {
    expect(diffDigest(TWO_FILES)).toMatch(/^[0-9a-f]{16}$/)
    expect(diffDigest(TWO_FILES)).toBe(diffDigest(TWO_FILES))
    expect(diffDigest(TWO_FILES)).not.toBe(diffDigest(TWO_FILES + " "))
  })
})
