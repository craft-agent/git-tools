/** A rule that fired on one line, with the value it matched already redacted. */
export type RuleMatch = { rule: string; redacted: string }

/** Rule id of a value assigned to a secret-looking name. */
export const GENERIC_SECRET_RULE = "generic-secret"
/** Rule id of a high-entropy value in an env-like file. */
export const ENV_VALUE_RULE = "env-value"

const INLINE_ALLOW = "gitleaks:allow"

const GENERIC_ENTROPY_MIN = 3.5
const ENV_ENTROPY_MIN = 3.0
const VALUE_LENGTH_MIN = 10
const VALUE_LENGTH_MAX = 150
const ENV_VALUE_LENGTH_MIN = 16
/** At most this many characters of a value are shown, on each side, when it is redacted. */
const REDACT_EDGE = 3
/** A value this short or shorter is not shown at all. */
const REDACT_HIDE_MAX = 8

type PrefixRule = { rule: string; pattern: RegExp; ignore?: RegExp }

/** Credentials with a known prefix; they apply in every file. Modelled on gitleaks' default config. */
const PREFIX_RULES: PrefixRule[] = [
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, ignore: /EXAMPLE$/ },
  { rule: "github-pat", pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
  { rule: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { rule: "github-token", pattern: /\bgh[ousr]_[A-Za-z0-9]{36}\b/g },
  { rule: "gitlab-pat", pattern: /\bglpat-[A-Za-z0-9_-]{20}(?![A-Za-z0-9_-])/g },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "slack-webhook", pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  {
    rule: "openai-api-key",
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
  },
  { rule: "anthropic-api-key", pattern: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g },
  { rule: "stripe-secret-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { rule: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: "pypi-token", pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g },
  { rule: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
]

const TYPE_NAME = String.raw`[A-Za-z_][\w.<>\[\]?]*`
/** A TypeScript or Python annotation between a name and its operator: `: string`, `: str | None`, `: Optional[str]`. */
const TYPE_ANNOTATION = String.raw`(?:\s*:\s*${TYPE_NAME}(?:\s*\|\s*${TYPE_NAME})*)?`
/**
 * `name = value`, `name: value`, `name := value`, `name => value`, `"name": "value"`,
 * `name: type = value`; the value may be quoted.
 */
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?<![\w$])(?<name>[A-Za-z_][\w.-]*)["'\`]?${TYPE_ANNOTATION}\s*(?::=|=>|[:=])\s*["'\`]?(?<value>[^\s"'\`,;)]{10,})`,
  "g",
)
const ENV_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?<value>.*?)\s*$/
const QUOTED_PATTERN = /^(["'`])(?<inner>.*)\1$/
const TRAILING_COMMENT_PATTERN = /\s+#.*$/

/** The name segments (split on `_ - .` and camelCase boundaries, lowercased) that mark a name as secret-looking. */
const SECRET_NAME_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "pass",
  "credential",
  "credentials",
  "creds",
  "auth",
  "accesskey",
  "secretkey",
  "privatekey",
  "authtoken",
  "accesstoken",
  "clientsecret",
])

const ENV_FILE_PATTERN = /(^|\/)\.env(\.[A-Za-z0-9_-]+|rc)?$/
const ENV_TEMPLATE_PATTERN = /(^|\/)\.env\.(example|sample|template|dist)$/

/** Files whose bulk is hashes or generated output; only the prefix rules apply to them. */
const HEURISTIC_SKIPPED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "packages.lock.json",
  "gradle.lockfile",
])
const HEURISTIC_SKIPPED_PATH_PATTERN = /\.(?:min\.js|min\.css|map|svg)$|(^|\/)(?:node_modules|vendor)\//

const IDENTIFIER_PATTERN = /^[A-Za-z_.-]+$/
const TEMPLATE_PATTERN = /\$\{|\{\{|<[^<>]+>|%[sd]/
const REFERENCE_PREFIXES = [
  "$",
  "process.env",
  "os.environ",
  "import.meta.env",
  "env.",
  "this.",
  "self.",
  "args.",
  "config.",
  "options.",
  "settings.",
]
const MEMBER_PATH_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_PATTERN = /^[0-9a-fA-F]+$/
const INTEGRITY_HASH_PATTERN = /^(sha\d+|blake2b|blake3|md5)-/i
/** A URL with no `user:pass@` before the first `/` after the scheme. */
const URL_WITHOUT_CREDENTIALS_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^@/]*(?:\/|$)/i
const PLACEHOLDER_WORDS = [
  "example",
  "sample",
  "dummy",
  "placeholder",
  "changeme",
  "redacted",
  "xxxx",
  "your_",
  "your-",
  "fake",
  "test-only",
]

/** The Shannon entropy of `value`, in bits per character. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  let entropy = 0
  for (const count of counts.values()) {
    const share = count / total
    entropy -= share * Math.log2(share)
  }
  return entropy
}

/** Hides a secret: its first and last characters and its length, or only the length when it is short. Never returns the raw value. */
export function redact(secret: string): string {
  const value = secret.trim()
  if (value.length <= REDACT_HIDE_MAX) return `*** [${value.length} chars]`
  return `${value.slice(0, REDACT_EDGE)}...${value.slice(-REDACT_EDGE)} [${value.length} chars]`
}

function isRun(value: string): boolean {
  if (value.length < 2) return false
  const step = value.charCodeAt(1) - value.charCodeAt(0)
  if (Math.abs(step) > 1) return false
  for (let i = 1; i < value.length; i++) {
    if (value.charCodeAt(i) - value.charCodeAt(i - 1) !== step) return false
  }
  return true
}

function isReference(value: string): boolean {
  if (value.includes("(") || value.includes("[")) return true
  const lower = value.toLowerCase()
  return REFERENCE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** Whether a value is a template, reference, identifier, hash, placeholder or run rather than a literal secret. */
export function isNonSecretValue(value: string): boolean {
  const lower = value.toLowerCase()
  return (
    IDENTIFIER_PATTERN.test(value) ||
    TEMPLATE_PATTERN.test(value) ||
    isReference(value) ||
    MEMBER_PATH_PATTERN.test(value) ||
    UUID_PATTERN.test(value) ||
    HEX_PATTERN.test(value) ||
    INTEGRITY_HASH_PATTERN.test(value) ||
    URL_WITHOUT_CREDENTIALS_PATTERN.test(value) ||
    PLACEHOLDER_WORDS.some((word) => lower.includes(word)) ||
    isRun(value)
  )
}

/** Whether a name has a segment that marks it as secret-looking (`apiKey`, `AUTH_TOKEN`, not `monkey`). */
export function isSecretName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .some((word) => SECRET_NAME_WORDS.has(word.toLowerCase()))
}

/** Whether the heuristic rules (generic and env values) skip this file: lockfiles, minified or generated files and vendored code. */
export function isHeuristicSkipped(file: string): boolean {
  return HEURISTIC_SKIPPED_FILES.has(file.slice(file.lastIndexOf("/") + 1)) || HEURISTIC_SKIPPED_PATH_PATTERN.test(file)
}

function isEnvFile(file: string): boolean {
  return ENV_FILE_PATTERN.test(file) && !ENV_TEMPLATE_PATTERN.test(file)
}

function prefixMatches(content: string): RuleMatch[] {
  const matches: RuleMatch[] = []
  for (const { rule, pattern, ignore } of PREFIX_RULES) {
    for (const match of content.matchAll(pattern)) {
      if (ignore?.test(match[0])) continue
      matches.push({ rule, redacted: redact(match[0]) })
    }
  }
  return matches
}

function genericMatches(content: string): RuleMatch[] {
  const matches: RuleMatch[] = []
  for (const { groups } of content.matchAll(ASSIGNMENT_PATTERN)) {
    const { name, value } = groups as { name: string; value: string }
    if (value.length > VALUE_LENGTH_MAX || !isSecretName(name)) continue
    if (isNonSecretValue(value) || shannonEntropy(value) < GENERIC_ENTROPY_MIN) continue
    matches.push({ rule: GENERIC_SECRET_RULE, redacted: redact(value) })
  }
  return matches
}

function envMatch(content: string): RuleMatch | undefined {
  const raw = ENV_ASSIGNMENT_PATTERN.exec(content)?.groups?.value
  if (!raw) return undefined
  const quoted = QUOTED_PATTERN.exec(raw)?.groups?.inner
  const value = quoted ?? raw.replace(TRAILING_COMMENT_PATTERN, "")
  if (value.length < ENV_VALUE_LENGTH_MIN || value.length > VALUE_LENGTH_MAX || /\s/.test(value)) return undefined
  if (isNonSecretValue(value) || shannonEntropy(value) < ENV_ENTROPY_MIN) return undefined
  return { rule: ENV_VALUE_RULE, redacted: redact(value) }
}

/**
 * Runs the builtin rules over one added line of `file`: known credential
 * prefixes everywhere, and, outside lockfiles and generated files, values
 * assigned to secret-looking names plus (in env-like files) other
 * high-entropy values. A line carrying `gitleaks:allow` is skipped.
 */
export function scanLine(file: string, content: string): RuleMatch[] {
  if (content.includes(INLINE_ALLOW)) return []
  const matches = prefixMatches(content)
  if (isHeuristicSkipped(file)) return matches
  const generic = genericMatches(content)
  matches.push(...generic)
  if (generic.length === 0 && isEnvFile(file)) {
    const env = envMatch(content)
    if (env) matches.push(env)
  }
  return matches
}
