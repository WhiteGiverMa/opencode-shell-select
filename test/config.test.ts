import { describe, expect, test } from "bun:test"
import {
  defaultCacheTtlMs,
  defaultInstructionKey,
  normalizeShellID,
  parseConfig,
} from "../src/config.js"

describe("parseConfig", () => {
  test("provides defaults for missing and non-object options", () => {
    for (const input of [undefined, null, false, "invalid", 42]) {
      const config = parseConfig(input)
      expect(config).toEqual({
        enabled: true,
        shells: undefined,
        cacheTtlMs: defaultCacheTtlMs,
        instructionKey: defaultInstructionKey,
        probeOnRequest: true,
      })
    }
  })

  test("accepts valid scalar options", () => {
    expect(
      parseConfig({
        enabled: false,
        cacheTtlMs: 12.9,
        instructionKey: "team.shell_profiles-2",
        probeOnRequest: false,
      }),
    ).toEqual({
      enabled: false,
      shells: undefined,
      cacheTtlMs: 12,
      instructionKey: "team.shell_profiles-2",
      probeOnRequest: false,
    })
  })

  test("recovers each field independently without re-enabling a disabled plugin", () => {
    const config = parseConfig({
      enabled: false,
      cacheTtlMs: -1,
      instructionKey: "Invalid/Key",
      probeOnRequest: false,
      shells: ["sh"],
    })
    expect(config.enabled).toBe(false)
    expect(config.cacheTtlMs).toBe(defaultCacheTtlMs)
    expect(config.instructionKey).toBe(defaultInstructionKey)
    expect(config.probeOnRequest).toBe(false)
    expect(config.shells).toEqual({ mode: "only", names: ["sh"] })
  })

  test("validates instruction keys against OpenCode's native key grammar", () => {
    for (const key of ["a", "0", "shell.select", "team_key-2", "a".repeat(128)]) {
      expect(parseConfig({ instructionKey: key }).instructionKey).toBe(key)
    }
    for (const key of ["", ".leading", "-leading", "_leading", "Upper", "white space", "a/b", null, 7]) {
      expect(parseConfig({ instructionKey: key }).instructionKey).toBe(defaultInstructionKey)
    }
  })

  test("accepts zero TTL and rejects non-finite, negative, and wrongly typed values", () => {
    expect(parseConfig({ cacheTtlMs: 0 }).cacheTtlMs).toBe(0)
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1000", null, true]) {
      expect(parseConfig({ cacheTtlMs: value }).cacheTtlMs).toBe(defaultCacheTtlMs)
    }
  })

  test("normalizes, filters, and deduplicates an allow-list", () => {
    expect(
      parseConfig({ shells: [" BASH ", "bash", "zsh", 4, null, "bad/id", "", ".hidden"] }).shells,
    ).toEqual({ mode: "only", names: ["bash", "zsh"] })
    expect(parseConfig({ shells: [] }).shells).toEqual({ mode: "only", names: [] })
    expect(normalizeShellID("  PoWeRsHeLl ")).toBe("powershell")
  })

  test("parses merge profiles from paths and rich objects", () => {
    const config = parseConfig({
      shells: {
        " Custom ": {
          path: " /opt/custom/bin/sh ",
          description: " Custom shell ",
          enabled: true,
        },
        local: "/bin/sh",
        off: { enabled: false },
        "bad/id": "/bin/ignored",
        malformed: 42,
      },
    })
    expect(config.shells?.mode).toBe("merge")
    if (config.shells?.mode !== "merge") throw new Error("expected merge profiles")
    expect([...config.shells.profiles.keys()]).toEqual(["custom", "local", "off", "malformed"])
    expect(config.shells.profiles.get("custom")).toEqual({
      path: "/opt/custom/bin/sh",
      description: "Custom shell",
      enabled: true,
    })
    expect(config.shells.profiles.get("local")).toEqual({ path: "/bin/sh" })
    expect(config.shells.profiles.get("off")).toEqual({ enabled: false })
    expect(config.shells.profiles.get("malformed")).toEqual({})
    expect(config.shells.profiles.has("bad/id")).toBe(false)
  })

  test("keeps valid profile fields when sibling fields are invalid", () => {
    const config = parseConfig({
      shells: { bash: { path: "bad\0path", description: "", enabled: false } },
    })
    if (config.shells?.mode !== "merge") throw new Error("expected merge profiles")
    expect(config.shells.profiles.get("bash")).toEqual({ enabled: false })
  })

  test("ignores invalid shells containers", () => {
    for (const shells of [false, 4, "bash", null]) expect(parseConfig({ shells }).shells).toBeUndefined()
  })
})
