import type { WorkApprovalMode } from '../../../shared/tool-contracts'

export const WORK_APPROVAL_MODES: readonly WorkApprovalMode[] = ['ask', 'auto', 'full']

export const WORK_APPROVAL_MODE_COPY: Record<WorkApprovalMode, { label: string; shortLabel: string; description: string }> = {
  ask: {
    label: 'Ask for approval',
    shortLabel: 'Ask',
    description: 'Read-only actions run automatically. OmniCode asks before changes or external actions.'
  },
  auto: {
    label: 'Approve for me',
    shortLabel: 'Approve for me',
    description: 'Routine, low-risk reversible actions run automatically. Sensitive and high-impact actions still ask.'
  },
  full: {
    label: 'Full access',
    shortLabel: 'Full access',
    description: 'Normal actions run automatically. Critical, financial, security, and irreversible actions always ask.'
  }
}
