const MAX_AGENT_COMMAND_LENGTH = 2_000
const MAX_AGENT_REASON_LENGTH = 1_000

const BLOCKED_AGENT_COMMANDS: Array<[RegExp, string]> = [
  [/(?:^|[^\w])sudo(?:\s|$)/iu, 'sudo commands must be run manually in a terminal.'],
  [/(?:^|[;&|]\s*)rm\b[^\n]*(?:\s-[^\s]*r|\s--recursive|\s-[^\s]*f|\s--force)/iu, 'recursive or forced deletion is never launched by the AI agent.'],
  [/(?:^|[^\w])(?:diskutil|mkfs(?:\.[a-z0-9]+)?|dd|csrutil|shutdown|reboot|launchctl)(?:\s|$)/iu, 'system and disk administration commands are blocked.'],
  [/(?:^|[^\w])defaults\s+write\b/iu, 'macOS settings changes are blocked.'],
  [/(?:^|[^\w])(?:chmod|chown)\b[^\n]*\s-R\b/iu, 'recursive permission changes are blocked.'],
  [/(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/iu, 'download-and-execute pipelines are blocked.'],
  [/(?:^|[^\w])(?:brew\s+install|mas\s+install|npm\s+(?:i|install)\s+(?:-g|--global)|pip3?\s+install\b)/iu, 'system-level or global installation commands must be run manually.'],
  [/(?:^|\s)(?:>|>>|tee\s+)\s*\/(?:System|Library|etc|usr|bin|sbin)\b/iu, 'writes to system locations are blocked.'],
  [/(?:^|[^\w])security\s+(?:find|dump)-/iu, 'macOS Keychain reads are blocked for the AI agent.'],
  [/(?:^|[^\w])(?:sh|bash|zsh)\s+-[^\s]*c\b/iu, 'nested shell commands must be reviewed and run manually.']
]

export interface ValidatedAgentCommand {
  command: string
  reason: string
}

export function validateAgentCommand(command: unknown, reason: unknown): ValidatedAgentCommand {
  if (typeof command !== 'string') throw new Error('The AI agent command is invalid.')
  const normalizedCommand = command.trim()
  if (!normalizedCommand || normalizedCommand.length > MAX_AGENT_COMMAND_LENGTH || normalizedCommand.includes('\0')) {
    throw new Error('The AI agent command is empty, invalid, or too long.')
  }
  const blocked = BLOCKED_AGENT_COMMANDS.find(([pattern]) => pattern.test(normalizedCommand))
  if (blocked) throw new Error(`Command blocked: ${blocked[1]}`)

  if (typeof reason !== 'string') throw new Error('The AI agent command reason is invalid.')
  const normalizedReason = reason.trim()
  if (!normalizedReason || normalizedReason.length > MAX_AGENT_REASON_LENGTH || normalizedReason.includes('\0')) {
    throw new Error('The AI agent command reason is empty, invalid, or too long.')
  }
  return { command: normalizedCommand, reason: normalizedReason }
}
