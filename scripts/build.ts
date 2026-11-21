export {}

const server = await Bun.build({
  entrypoints: ["./src/server.ts"],
  outdir: "./dist",
  target: "node",
  external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"],
})

if (!server.success) throw new AggregateError(server.logs, "Server build failed")
console.log("built: dist/server.js")
