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
  [/(?:^|[^\w])(?:npm\s+(?:i|install|ci)|pnpm\s+(?:i|install|add)|yarn\s+(?:install|add)|bun\s+(?:install|add)|cargo\s+(?:add|update)|go\s+(?:get|mod\s+download))(?:\s|$)/iu, 'dependency changes must use the dedicated always-confirmed dependency tool.'],
  [/(?:^|\s)(?:>|>>|tee\s+)\s*\/(?:System|Library|etc|usr|bin|sbin)\b/iu, 'writes to system locations are blocked.'],
  [/(?:^|[^\w])security\s+(?:find|dump)-/iu, 'macOS Keychain reads are blocked for the AI agent.'],
  [/(?:^|[^\w])(?:sh|bash|zsh)\s+-[^\s]*c\b/iu, 'nested shell commands must be reviewed and run manually.'],
  [/(?:^|[^\w])(?:osascript|automator|screencapture|tccutil)(?:\s|$)/iu, 'unstructured computer control and privacy-permission changes are blocked.'],
  [/(?:^|[^\w])(?:env|printenv|set|export)(?:\s|$)/iu, 'bulk environment and credential discovery is blocked.'],
  [/(?:^|[^\w])(?:node\s+(?:-[^\s]*e|--eval)|python3?\s+-c|ruby\s+-e|perl\s+-e|eval\s|source\s)/iu, 'inline or sourced executable code is blocked; use a reviewed workspace file.'],
  [/(?:^|[^\w])(?:curl|wget|nc|netcat|ssh|scp|sftp|rsync)(?:\s|$)/iu, 'arbitrary network and remote-shell commands are blocked; use a structured tool.'],
  [/(?:^|[^\w])(?:gh\s+auth\s+token|git\s+credential|git\s+config\s+--global|npm\s+config\s+get)(?:\s|$)/iu, 'credential discovery and global configuration changes are blocked.'],
  [/(?:\$\{?|\$\()[^\r\n]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu, 'commands cannot expand credential-like environment variables.'],
  [/(?:^|[\s'"=])(?:~\/)?\.(?:ssh|aws|gnupg|config\/gh|docker)(?:\/|\s|$)/iu, 'private credential and account configuration paths are blocked.'],
  [/(?:^|[\s'"=])\/(?:System|Library|private|etc|usr|bin|sbin)(?:\/|\s|$)/iu, 'system and private operating-system paths are blocked.']
]

export interface ValidatedAgentCommand {
  command: string
  reason: string
}

const DEPENDENCY_PREFIX = /^(?:npm\s+(?:i|install|ci)|pnpm\s+(?:i|install|add)|yarn\s+(?:install|add)|bun\s+(?:install|add)|cargo\s+(?:add|update)|go\s+(?:get|mod\s+download))(?:\s|$)/u
const SAFE_DEPENDENCY_TOKEN = /^[A-Za-z0-9@_./:+^~=-]+$/u

export function validateDependencyCommand(command: unknown, reason: unknown): ValidatedAgentCommand {
  if (typeof command !== 'string' || typeof reason !== 'string') throw new Error('The dependency command or reason is invalid.')
  const normalizedCommand = command.trim()
  const normalizedReason = reason.trim()
  if (!normalizedCommand || normalizedCommand.length > MAX_AGENT_COMMAND_LENGTH || /[\0\r\n;&|<>`$()'"\\]/u.test(normalizedCommand)) {
    throw new Error('The dependency command contains unsupported shell syntax.')
  }
  if (!DEPENDENCY_PREFIX.test(normalizedCommand) || normalizedCommand.split(/\s+/u).some((token) => !SAFE_DEPENDENCY_TOKEN.test(token))) {
    throw new Error('Only an allowlisted project dependency command can use this tool.')
  }
  if (!normalizedReason || normalizedReason.length > MAX_AGENT_REASON_LENGTH || normalizedReason.includes('\0')) throw new Error('The dependency command reason is invalid or too long.')
  return { command: normalizedCommand, reason: normalizedReason }
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
