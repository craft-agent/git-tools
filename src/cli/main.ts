import { packageRoot } from "../entry/package-root"
import { PROJECT } from "../project"
import { ALL_TOOLS } from "../tools"
import { EXIT_FAILED, runCli } from "./cli"

const CANCEL_SIGNALS = ["SIGTERM", "SIGINT"] as const

/** Standard input read to its end; a terminal has nothing to read, so it counts as empty. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const controller = new AbortController()
  for (const signal of CANCEL_SIGNALS) process.once(signal, () => controller.abort())

  process.exitCode = await runCli(process.argv.slice(2), {
    specs: ALL_TOOLS,
    env: process.env,
    ownDir: packageRoot(import.meta.url),
    readStdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`${PROJECT.cli}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = EXIT_FAILED
})
