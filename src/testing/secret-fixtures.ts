/**
 * Fixtures for the secret scanner's tests. No literal here may look like a
 * credential, since our own commit scan and the git host's push protection read
 * this source: every value is built from parts at runtime.
 */

import { scanDiff } from "../core/commit/secret-diff"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** A string of `length` characters from [A-Za-z0-9] with high entropy and no run. */
export function randomish(length: number): string {
  return Array.from({ length }, (_, i) => ALPHABET[(i * 7 + 3) % ALPHABET.length]).join("")
}

/** A `git diff --unified=0` that adds `lines` to `file` from line `start`. */
export function diffOf(file: string, lines: string[], start = 1): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start - 1},0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n")
}

/** The rule ids that fire on one added line of `file`. */
export function rulesOf(file: string, line: string): string[] {
  return scanDiff(diffOf(file, [line])).map((finding) => finding.rule)
}

/** One credential per known-prefix rule, keyed by rule id. */
export const PREFIXED: Record<string, string> = {
  "aws-access-key-id": ["AK", "IA"].join("") + "Q2W3E4R5T6Y7U8I9",
  "github-pat": ["gh", "p_"].join("") + randomish(36),
  "github-fine-grained-pat": ["github_", "pat_"].join("") + randomish(82),
  "github-token": ["gh", "o_"].join("") + randomish(36),
  "gitlab-pat": ["glpat", "-"].join("") + randomish(20),
  "slack-token": ["xox", "b-"].join("") + randomish(24),
  "slack-webhook": ["https://hooks.", "slack.com/services/"].join("") + "T00000000/B00000000/" + randomish(24),
  "google-api-key": ["AI", "za"].join("") + randomish(35),
  "openai-api-key": ["sk", "-proj-"].join("") + randomish(48),
  "anthropic-api-key": ["sk", "-ant-", "api03-"].join("") + randomish(90),
  "stripe-secret-key": ["sk", "_live_"].join("") + randomish(30),
  "npm-token": ["npm", "_"].join("") + randomish(36),
  "pypi-token": ["pypi", "-AgEIcHlwaS5vcmc"].join("") + randomish(60),
  "private-key": ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join(""),
}
