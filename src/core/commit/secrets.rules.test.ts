import { describe, expect, test } from "bun:test"
import { PREFIXED, randomish, rulesOf } from "../../testing/secret-fixtures"

describe("scanDiff known prefixes", () => {
  for (const [rule, value] of Object.entries(PREFIXED)) {
    test(`${rule} fires`, () => {
      expect(rulesOf("src/app.ts", `const v = "${value}"`)).toEqual([rule])
    })
  }

  test("the legacy OpenAI key format fires", () => {
    const legacy = ["sk", "-"].join("") + randomish(20) + ["T3Blbk", "FJ"].join("") + randomish(20)
    expect(rulesOf("src/app.ts", `const v = "${legacy}"`)).toEqual(["openai-api-key"])
  })

  test("the other GitHub token prefixes fire as github-token", () => {
    for (const kind of ["u", "s", "r"]) {
      expect(rulesOf("a.ts", `v = ${["gh", `${kind}_`].join("")}${randomish(36)}`)).toEqual(["github-token"])
    }
  })

  test("the AWS documentation key ending in EXAMPLE does not fire", () => {
    const example = ["AK", "IA"].join("") + "IOSFODNN7" + "EXAMPLE"
    expect(rulesOf("src/app.ts", `const v = "${example}"`)).toEqual([])
  })

  test("prefix rules apply in lockfiles", () => {
    expect(rulesOf("yarn.lock", PREFIXED["github-pat"]!)).toEqual(["github-pat"])
  })

  test("a wrong length does not fire", () => {
    expect(rulesOf("a.ts", `v = ${["gh", "p_"].join("")}${randomish(20)}`)).toEqual([])
  })
})

describe("scanDiff generic-secret", () => {
  const random = randomish(32)

  test("fires on assignments to secret-looking names", () => {
    expect(rulesOf("src/a.py", `api_key = "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.json", `  "clientSecret": "${random}",`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.sh", `AUTH_TOKEN=${random}`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.ts", `const db_password = '${random}'`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.go", `apiKey := "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.php", `'token' => '${random}',`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.ts", `apiKey: \`${random}\``)).toEqual(["generic-secret"])
  })

  test("needs a whole word of the name, not a substring", () => {
    expect(rulesOf("src/a.ts", `const monkey = "${random}"`)).toEqual([])
    expect(rulesOf("src/a.ts", `const keyboard = "${random}"`)).toEqual([])
    expect(rulesOf("src/a.ts", `const author = "${random}"`)).toEqual([])
    expect(rulesOf("src/a.ts", `const tokenizer = "${random}"`)).toEqual([])
  })

  test("ignores code, references and templates", () => {
    const quiet = [
      "const token = listToken(diff)",
      "apiKey: process.env.API_KEY",
      'password: "${PASSWORD}"',
      "token: args.token",
      "password = $DB_PASSWORD",
      "secret = os.environ['SECRET_VALUE_FROM_HOST']",
      'authToken: "<your auth token here>"',
      "const passwordResetTemplate = loadTemplateFile",
    ]
    for (const line of quiet) expect(rulesOf("src/a.ts", line)).toEqual([])
  })

  test("ignores UUIDs, hex digests, integrity hashes and placeholders", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000"
    const sha = "0123456789abcdef".repeat(2) + "01234567"
    const integrity = "sha512-" + randomish(40)
    for (const value of [uuid, sha, integrity, "example-secret-value-123", "your_api_key_goes_here1"]) {
      expect(rulesOf("src/a.ts", `secret = "${value}"`)).toEqual([])
    }
  })

  test("ignores repeated and sequential runs", () => {
    for (const value of ["a".repeat(20), "0123456789", "abcdefghijklmnop", "zyxwvutsrqpo"]) {
      expect(rulesOf("src/a.ts", `password = "${value}"`)).toEqual([])
    }
  })

  test("ignores a value with low entropy", () => {
    expect(rulesOf("src/a.ts", `api_key = "${"pq".repeat(6)}9"`)).toEqual([])
  })

  test("ignores values shorter than 10 or longer than 150 characters", () => {
    expect(rulesOf("src/a.ts", `api_key = "${randomish(9)}"`)).toEqual([])
    expect(rulesOf("src/a.ts", `api_key = "${randomish(151)}"`)).toEqual([])
    expect(rulesOf("src/a.ts", `api_key = "${randomish(150)}"`)).toEqual(["generic-secret"])
  })

  test("skips lockfiles, minified files and vendored code", () => {
    const line = `api_key = "${random}"`
    for (const file of ["yarn.lock", "sub/package-lock.json", "dist/app.min.js", "a.map", "logo.svg"]) {
      expect(rulesOf(file, line)).toEqual([])
    }
    expect(rulesOf("node_modules/x/index.js", line)).toEqual([])
    expect(rulesOf("vendor/x/index.go", line)).toEqual([])
  })

  test("a URL without credentials is not a secret, one with user:pass@ is", () => {
    const plain = `https://api.${randomish(12)}.io/v2/${randomish(20)}`
    expect(rulesOf("src/a.ts", `api_key = "${plain}"`)).toEqual([])
    expect(rulesOf("src/a.ts", `api_key = "https://${randomish(12)}.io"`)).toEqual([])
    expect(rulesOf(".env", `API_URL=${plain}`)).toEqual([])
    const withCredentials = `postgres://admin:${randomish(20)}@db.internal/app`
    expect(rulesOf("src/a.ts", `secret = "${withCredentials}"`)).toEqual(["generic-secret"])
    expect(rulesOf(".env", `DATABASE_URL=${withCredentials}`)).toEqual(["env-value"])
  })

  test("a type annotation between the name and the operator is not the value", () => {
    expect(rulesOf("src/a.ts", `const password: string = "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.py", `api_key: str = "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.py", `api_key: Optional[str] = "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.py", `api_key: str | None = "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.ts", `let secret: SecretStringType = '${random}'`)).toEqual(["generic-secret"])
  })

  test("annotated names whose value is code or a placeholder stay quiet", () => {
    expect(rulesOf("src/a.ts", "const password: string = process.env.DB_PASSWORD")).toEqual([])
    expect(rulesOf("src/a.py", 'api_key: str = os.environ["API_KEY"]')).toEqual([])
    expect(rulesOf("src/a.ts", "password: SecretStringType")).toEqual([])
  })

  test("plain and quoted-key assignments still work", () => {
    expect(rulesOf("src/a.json", `"clientSecret": "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.yml", `password: "${random}"`)).toEqual(["generic-secret"])
    expect(rulesOf("src/a.yml", `password: ${random}`)).toEqual(["generic-secret"])
  })
})

describe("scanDiff without bare entropy", () => {
  test("a long path, base64 fixture or identifier in source is not a finding", () => {
    const base64 = Buffer.from(randomish(60)).toString("base64")
    const lines = [
      'const file = "src/components/very/long/directory/structure/for/the/feature/index.test.tsx"',
      `const fixture = "${base64}"`,
      "const someVeryLongCamelCaseIdentifierNameThatKeepsGoing = anotherVeryLongCamelCaseIdentifierNameHere",
      `import x from "../../../some/deeply/nested/module/${randomish(30)}"`,
    ]
    for (const line of lines) expect(rulesOf("src/a.ts", line)).toEqual([])
  })
})

describe("scanDiff env-value", () => {
  const value = randomish(24)

  test("fires in .env and .env.local files", () => {
    for (const file of [".env", ".env.local", "apps/web/.env.production", ".envrc"]) {
      expect(rulesOf(file, `SESSION_SIGNING=${value}`)).toEqual(["env-value"])
    }
    expect(rulesOf(".env", `export SESSION_SIGNING="${value}"`)).toEqual(["env-value"])
  })

  test("does not fire in template env files or other files", () => {
    for (const file of [".env.example", ".env.sample", ".env.template", ".env.dist", "src/env.ts", "a.env.txt"]) {
      expect(rulesOf(file, `SESSION_SIGNING=${value}`)).toEqual([])
    }
  })

  test("does not fire for short, plain, low-entropy or hex values", () => {
    for (const line of [
      `SESSION_SIGNING=${randomish(12)}`,
      "NODE_ENV=production",
      "DATABASE_HOST=localhost.localdomain.internal",
      `COMMIT=${"0123456789abcdef".repeat(2)}`,
      `LOG_FORMAT=${"pq".repeat(10)}9`,
      `GREETING=${randomish(8)} ${randomish(12)}`,
    ]) {
      expect(rulesOf(".env", line)).toEqual([])
    }
  })

  test("reports one generic-secret, not also an env-value, for a secret-looking name", () => {
    expect(rulesOf(".env", `AUTH_TOKEN=${value}`)).toEqual(["generic-secret"])
  })

  test("a comment line is not an assignment", () => {
    expect(rulesOf(".env", `# note SESSION_SIGNING=${value}`)).toEqual([])
  })
})
