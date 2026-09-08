// utils/sitecore/permissions.ts

import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import { DATABASE, normalizeGuid, runGraphQL } from "@/src/utils/sitecore/graphql";

interface SecurableCommand {
  commandId: string;
  displayName: string;
}

export interface WorkflowActor {
  /** Sitecore account the ACL checks run against, when it could be resolved. */
  userName?: string;
  isAdministrator: boolean;
}

/** True when the app can evaluate Sitecore security for this user. */
export function canEvaluateSecurity(actor: WorkflowActor): boolean {
  return Boolean(actor.userName);
}

function collectUserHints(hostUser: unknown, hostState: unknown): string[] {
  const user = hostUser as
    | { id?: string; name?: string; email?: string }
    | undefined;
  const stateUser = (
    hostState as { userInfo?: Record<string, unknown> } | undefined
  )?.userInfo;

  return [
    user?.email,
    user?.name,
    user?.id,
    stateUser?.email,
    stateUser?.preferred_username,
    stateUser?.name,
    stateUser?.sub,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function candidateUserNames(hints: string[]): string[] {
  const names = new Set<string>();
  for (const hint of hints) {
    if (hint.includes("\\")) {
      names.add(hint);
    } else {
      names.add(`sitecore\\${hint}`);
    }
  }
  return [...names];
}

interface SitecoreUserNode {
  name?: string;
  isAdministrator?: boolean;
}

/**
 * Marketplace GraphQL runs as a machine user with admin rights, so Sitecore never
 * applies the signed-in author's permissions on its own. Resolving the real
 * Sitecore account lets the app evaluate item security explicitly.
 */
export async function resolveWorkflowActor(
  client: ClientSDK,
  sitecoreContextId: string,
): Promise<WorkflowActor> {
  const [hostUser, hostState] = await Promise.all([
    client.query("host.user").catch(() => ({ data: undefined })),
    client.query("host.state").catch(() => ({ data: undefined })),
  ]);

  const hints = collectUserHints(hostUser.data, hostState.data);

  for (const userName of candidateUserNames(hints)) {
    try {
      const body = await runGraphQL<{ user?: SitecoreUserNode | null }>(
        client,
        sitecoreContextId,
        `query ResolveUser($userName: String!) {
          user(userName: $userName) { name isAdministrator }
        }`,
        { userName },
      );

      const resolved = body.data?.user;
      if (resolved?.name) {
        return {
          userName: resolved.name,
          isAdministrator: resolved.isAdministrator === true,
        };
      }
    } catch {
      // Unknown user or unsupported schema; try the next identity.
    }
  }

  return { isAdministrator: false };
}

/**
 * Keeps only the commands the signed-in user is allowed to see in Sitecore.
 * Workflow commands are items, so denying Read on a command (such as Approve
 * under Draft) is what hides it here too.
 */
export async function filterCommandsBySecurity<T extends SecurableCommand>(
  client: ClientSDK,
  sitecoreContextId: string,
  commands: T[],
  actor: WorkflowActor,
): Promise<T[]> {
  if (commands.length === 0) {
    return [];
  }

  if (actor.isAdministrator) {
    return commands;
  }

  // Without a Sitecore account there is nothing to evaluate, so deny everything
  // rather than fall back to the machine user's admin rights.
  if (!actor.userName) {
    return [];
  }

  const aliases = commands.map((_, index) => `cmd${index}`);
  const selections = commands
    .map(
      (command, index) => `
        ${aliases[index]}: item(where: { database: "${DATABASE}", itemId: "${normalizeGuid(
          command.commandId,
        )}" }) {
          access(username: $userName) { canRead }
        }`,
    )
    .join("\n");

  const body = await runGraphQL<
    Record<string, { access?: { canRead?: boolean } | null } | null>
  >(
    client,
    sitecoreContextId,
    `query CommandAccess($userName: String!) {${selections}\n}`,
    { userName: actor.userName },
  );

  // If the schema does not support the access check, deny the sensitive commands
  // instead of silently granting them.
  if (!body.data && body.errors?.length) {
    throw new Error(
      body.errors.map((error) => error.message).join("; ") ||
        "Could not evaluate Sitecore permissions.",
    );
  }

  return commands.filter((_, index) => {
    const node = body.data?.[aliases[index]];
    return node?.access?.canRead === true;
  });
}
