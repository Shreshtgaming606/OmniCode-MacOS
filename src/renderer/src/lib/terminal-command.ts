export interface ShellCommandRequest {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function buildShellCommand(request: ShellCommandRequest): string | null {
  if (!request.cwd) throw new Error('The run request does not have a working directory.')
  if (!request.command) return null

  const environment = Object.entries(request.env ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`The environment variable name “${name}” is not valid.`)
    }
    return `${name}=${shellQuote(value)}`
  })
  const command = [...environment, shellQuote(request.command), ...request.args.map(shellQuote)].join(' ')
  return `${command}; __omnicode_exit_code=$?; printf '\\n\\033[90m[Process exited with code %d]\\033[0m\\n' "$__omnicode_exit_code"`
}
