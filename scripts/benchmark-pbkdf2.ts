import { runPbkdf2Benchmark } from "./pbkdf2-benchmark.js"

const result = await runPbkdf2Benchmark(`Bun ${Bun.version}`)
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
