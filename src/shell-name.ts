export function shellShortName(executable: string): string {
  const name = executable.trim().split(/[\\/]/u).pop() ?? executable.trim()
  return name.replace(/\.(?:exe|cmd|bat)$/iu, "").toLowerCase()
}
