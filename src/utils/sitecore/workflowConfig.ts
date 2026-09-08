// utils/sitecore/workflowConfig.ts

function readName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || fallback;
}

const approveCommand = readName(
  process.env.NEXT_PUBLIC_WORKFLOW_COMMAND_APPROVE,
  "approve",
);
const reviewCommand = readName(
  process.env.NEXT_PUBLIC_WORKFLOW_COMMAND_REVIEW,
  "review",
);

/** Workflow display-name config from NEXT_PUBLIC_* env vars. */
export const workflowConfig = {
  approveCommand,
  reviewCommand,
  /** Non-admins: Review first, then Approve when Sitecore allows it. */
  preferredCommands: [reviewCommand, approveCommand],
  /** Admins: Approve shortcut first when Sitecore grants it. */
  adminPreferredCommands: [approveCommand, reviewCommand],
  /** Never auto-run these command name prefixes. */
  blockedCommands: ["reject", "__"],
  finalStateNames: (
    process.env.NEXT_PUBLIC_WORKFLOW_FINAL_STATE_NAMES ?? "approved"
  )
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
  defaultComment:
    process.env.NEXT_PUBLIC_WORKFLOW_DEFAULT_COMMENT?.trim() || "Approved",
};

export function commandName(command: { displayName: string }): string {
  return command.displayName.trim().toLowerCase();
}

export function isApproveCommand(command: { displayName: string }): boolean {
  return commandName(command) === workflowConfig.approveCommand;
}

export function isReviewCommand(command: { displayName: string }): boolean {
  const name = commandName(command);
  return (
    name === workflowConfig.reviewCommand ||
    name.includes(workflowConfig.reviewCommand)
  );
}
