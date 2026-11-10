#!/usr/bin/env node
/**
 * The fake `gh`: answers from rules.json next to this file and logs every call.
 * A plain Node script, so it runs wherever the tests do.
 */
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const joined = args.join(" ")
appendFileSync(join(dir, "calls.log"), `${JSON.stringify(args)}\n`)

const rules = JSON.parse(readFileSync(join(dir, "rules.json"), "utf8"))
const rule = rules.find((candidate) => new RegExp(candidate.match).test(joined))

if (rule) {
  if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs))
  process.stdout.write(rule.stdout ?? "")
  process.stderr.write(rule.stderr ?? "")
  process.exitCode = rule.code ?? 0
} else {
  process.stderr.write(`fake gh: no rule for ${joined}`)
  process.exitCode = 1
}
