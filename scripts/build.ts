export {}

const build = await Bun.build({
  entrypoints: ["./src/server.ts", "./src/tui.ts"],
  outdir: "./dist",
  target: "node",
  external: ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*", "solid-js", "solid-js/*"],
})

if (!build.success) throw new AggregateError(build.logs, "Plugin build failed")
console.log("built: dist/server.js, dist/tui.js")
