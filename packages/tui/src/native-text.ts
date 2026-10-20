export const NATIVE_TEXT = {
  permissionsBadge: 'native permissions',
  permissionsExplanation:
    'Native built-in tools use Claude Code permissions. Harness tool restrictions apply only to AIDCrew MCP tools; use /native to manage native permissions.',
  commandDescription: 'Open this agent’s native terminal. Ctrl+] returns to the crew.',
  unavailable:
    'Send this native agent an instruction first, then use /native to open its terminal.',
  unsupported: 'Native terminal attachment is not available in this interface.',
  attached: 'Native terminal · Ctrl+] returns to the crew',
  browserHint: 'Open the Native tab for this agent in the browser.',
} as const
