// utils/sitecore/workflow.ts

import type { ClientSDK } from "@sitecore-marketplace-sdk/client";
import {
  DATABASE,
  normalizeGuid,
  runGraphQL,
  type GraphQLBody,
} from "@/src/utils/sitecore/graphql";
import {
  filterCommandsBySecurity,
  type WorkflowActor,
} from "@/src/utils/sitecore/permissions";

/**
 * A single language version can need several transitions to reach the final state
 * (for example In Translations -> Review -> In Review -> Approve -> Approved).
 */
const MAX_TRANSITIONS = 6;

/**
 * Commands are matched by display name, in this order, until one succeeds.
 * Administrators prefer the direct Approve shortcut when Sitecore grants it.
 */
const PREFERRED_COMMANDS = ["review", "submit", "approve"];
const ADMIN_PREFERRED_COMMANDS = ["approve", "review", "submit"];

/** Commands that must never be executed automatically. */
const BLOCKED_COMMANDS = ["reject", "__"];

/**
 * Instances expose the "is this the last state" flag under different names, so the
 * first one the schema accepts is detected once and reused.
 */
const FINAL_FIELD_CANDIDATES = ["final", "finalState", "isFinal"];

/** Used only when the schema exposes no final-state flag at all. */
const FINAL_STATE_NAMES = ["approved"];

export interface WorkflowCommand {
  commandId: string;
  displayName: string;
}

export interface LanguageWorkflow {
  language: string;
  hasVersion: boolean;
  version?: number;
  workflowId?: string;
  stateId?: string;
  stateName?: string;
  isFinal: boolean;
  error?: string;
}

export interface ApproveResult {
  language: string;
  status: "approved" | "already-approved" | "skipped" | "failed";
  steps: string[];
  finalStateName?: string;
  error?: string;
}

export function getSitecoreContextId(appContext: unknown): string | undefined {
  const resourceAccess = (appContext as { resourceAccess?: Array<{ context?: { live?: string } }> })
    ?.resourceAccess;
  return resourceAccess?.[0]?.context?.live;
}

function isSafeLanguage(language: string): boolean {
  return /^[A-Za-z0-9-]{2,10}$/.test(language);
}

/** Languages added to the XM Cloud environment, used as the candidate list for a page. */
export async function listEnvironmentLanguages(
  client: ClientSDK,
  sitecoreContextId: string
): Promise<string[]> {
  const response = (await client.query("xmc.xmapp.listLanguages", {
    params: { query: { sitecoreContextId } },
  })) as { data?: unknown };

  const payload = (response?.data as { data?: unknown })?.data ?? response?.data;
  const languages = Array.isArray(payload) ? payload : [];

  return languages
    .map((language) => {
      const entry = language as { name?: string | null; regionalIsoCode?: string | null };
      return entry?.name ?? entry?.regionalIsoCode ?? "";
    })
    .filter((name): name is string => Boolean(name));
}

interface ItemWorkflowNode {
  version?: number;
  language?: { name?: string };
  workflow?: {
    workflow?: { workflowId?: string };
    workflowState?: { stateId?: string; displayName?: string } & Record<string, unknown>;
  } | null;
}

/** `undefined` while undetected, `null` once every candidate has been rejected. */
let finalField: string | null | undefined;

function isUnknownFieldError(body: GraphQLBody<unknown>): boolean {
  return (
    !body.data &&
    !!body.errors?.some((error) => error.message?.includes("does not exist on the type"))
  );
}

function buildItemQuery(languages: string[], aliases: string[], stateFinalField: string | null) {
  const selections = languages
    .map(
      (language, index) => `
        ${aliases[index]}: item(where: { database: "${DATABASE}", itemId: $itemId, language: "${language}" }) {
          version
          language { name }
          workflow {
            workflow { workflowId }
            workflowState { stateId displayName${stateFinalField ? ` ${stateFinalField}` : ""} }
          }
        }`
    )
    .join("\n");

  return `query PageWorkflow($itemId: ID!) {${selections}\n}`;
}

/**
 * Reads the workflow state of every language version of a page in a single request.
 * Languages without a version in the item are reported with `hasVersion: false`.
 */
export async function readWorkflowByLanguage(
  client: ClientSDK,
  sitecoreContextId: string,
  itemId: string,
  languages: string[]
): Promise<LanguageWorkflow[]> {
  const usable = languages.filter(isSafeLanguage);
  if (usable.length === 0) {
    return [];
  }

  const aliases = usable.map((language, index) => `lang${index}`);
  const variables = { itemId: normalizeGuid(itemId) };
  const candidates = finalField === undefined ? [...FINAL_FIELD_CANDIDATES, null] : [finalField];

  let resolved: GraphQLBody<Record<string, ItemWorkflowNode | null>> | undefined;

  for (const candidate of candidates) {
    const attempt = await runGraphQL<Record<string, ItemWorkflowNode | null>>(
      client,
      sitecoreContextId,
      buildItemQuery(usable, aliases, candidate),
      variables
    );

    if (isUnknownFieldError(attempt)) {
      continue;
    }

    finalField = candidate;
    resolved = attempt;
    break;
  }

  if (!resolved) {
    throw new Error("The Authoring API rejected the workflow query on this environment.");
  }

  const body = resolved;
  const stateFinalField = finalField;

  const errorByAlias = new Map<string, string>();
  body.errors?.forEach((error) => {
    const alias = error.path?.[0];
    if (alias) {
      errorByAlias.set(alias, error.message ?? "Unknown error");
    }
  });

  if (!body.data && body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }

  return usable.map((language, index) => {
    const alias = aliases[index];
    const node = body.data?.[alias] ?? null;
    const returnedLanguage = node?.language?.name;
    const version = node?.version ?? 0;
    // Sitecore falls back to another language when the requested one has no version.
    const hasVersion =
      !!node &&
      version > 0 &&
      (!returnedLanguage || returnedLanguage.toLowerCase() === language.toLowerCase());

    const state = node?.workflow?.workflowState;
    const stateName = state?.displayName;
    const isFinal = stateFinalField
      ? state?.[stateFinalField] === true
      : FINAL_STATE_NAMES.includes((stateName ?? "").trim().toLowerCase());

    return {
      language,
      hasVersion,
      version: hasVersion ? version : undefined,
      workflowId: node?.workflow?.workflow?.workflowId,
      stateId: state?.stateId,
      stateName,
      isFinal,
      error: errorByAlias.get(alias),
    };
  });
}

interface WorkflowCommandsResponse {
  workflow?: {
    commands?: { edges?: Array<{ node?: { commandId?: string; displayName?: string } }> };
  } | null;
}

/** Commands the current state exposes, without Sitecore's internal ones such as __OnSave. */
export async function getCommands(
  client: ClientSDK,
  sitecoreContextId: string,
  workflowId: string,
  stateId: string
): Promise<WorkflowCommand[]> {
  const body = await runGraphQL<WorkflowCommandsResponse>(
    client,
    sitecoreContextId,
    `query WorkflowCommands($workflowId: String!, $stateId: String!) {
      workflow(where: { workflowId: $workflowId }) {
        commands(query: { stateId: $stateId }, first: 50) {
          edges { node { commandId displayName } }
        }
      }
    }`,
    { workflowId: normalizeGuid(workflowId), stateId: normalizeGuid(stateId) }
  );

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }

  return (body.data?.workflow?.commands?.edges ?? [])
    .map((edge) => edge?.node)
    .filter((node): node is { commandId: string; displayName: string } =>
      Boolean(node?.commandId)
    )
    .map((node) => ({ commandId: node.commandId, displayName: node.displayName ?? "" }))
    .filter((command) => !command.displayName.trim().startsWith("__"));
}

/** Reads the commands available for each language version, keyed by language. */
export async function getCommandsByLanguage(
  client: ClientSDK,
  sitecoreContextId: string,
  languages: LanguageWorkflow[],
  actor: WorkflowActor
): Promise<Record<string, WorkflowCommand[]>> {
  const entries = await Promise.all(
    languages.map(async (language) => {
      if (!language.hasVersion || !language.workflowId || !language.stateId) {
        return [language.language, []] as const;
      }

      try {
        const commands = await getCommands(
          client,
          sitecoreContextId,
          language.workflowId,
          language.stateId
        );
        return [
          language.language,
          await filterCommandsBySecurity(client, sitecoreContextId, commands, actor),
        ] as const;
      } catch {
        return [language.language, []] as const;
      }
    })
  );

  return Object.fromEntries(entries);
}

/** Runs one specific command against one language version, chosen by the author. */
export async function runCommand(
  client: ClientSDK,
  sitecoreContextId: string,
  itemId: string,
  language: LanguageWorkflow,
  command: WorkflowCommand,
  comments: string,
  actor: WorkflowActor
): Promise<ApproveResult> {
  const permitted = await filterCommandsBySecurity(
    client,
    sitecoreContextId,
    [command],
    actor
  );

  if (permitted.length === 0) {
    return {
      language: language.language,
      status: "failed",
      steps: [],
      error: `You do not have permission to run "${command.displayName}" in Sitecore.`,
    };
  }

  try {
    const execution = await executeCommand(
      client,
      sitecoreContextId,
      { itemId, language: language.language, version: language.version ?? 1 },
      command.commandId,
      comments
    );

    if (!execution.successful) {
      return {
        language: language.language,
        status: "failed",
        steps: [],
        error: execution.message ?? `Command "${command.displayName}" was rejected by Sitecore.`,
      };
    }

    return {
      language: language.language,
      status: "approved",
      steps: [command.displayName || command.commandId],
    };
  } catch (error) {
    return {
      language: language.language,
      status: "failed",
      steps: [],
      error: error instanceof Error ? error.message : "Unexpected error.",
    };
  }
}

function orderCommands(
  commands: WorkflowCommand[],
  preferDirectApprove: boolean
): WorkflowCommand[] {
  const allowed = commands.filter((command) => {
    const name = command.displayName.trim().toLowerCase();
    return !BLOCKED_COMMANDS.some((blocked) => name.startsWith(blocked));
  });

  const preference = preferDirectApprove ? ADMIN_PREFERRED_COMMANDS : PREFERRED_COMMANDS;
  const ordered: WorkflowCommand[] = [];
  const add = (command: WorkflowCommand) => {
    if (!ordered.includes(command)) {
      ordered.push(command);
    }
  };

  for (const preferred of preference) {
    allowed
      .filter((command) => command.displayName.trim().toLowerCase() === preferred)
      .forEach(add);
  }

  for (const preferred of preference) {
    allowed
      .filter((command) => command.displayName.trim().toLowerCase().includes(preferred))
      .forEach(add);
  }

  return ordered;
}

interface ExecuteWorkflowCommandResponse {
  executeWorkflowCommand?: {
    successful?: boolean;
    completed?: boolean;
    nextStateId?: string;
    message?: string;
    error?: string;
  };
}

async function executeCommand(
  client: ClientSDK,
  sitecoreContextId: string,
  item: { itemId: string; language: string; version: number },
  commandId: string,
  comments: string
): Promise<{ successful: boolean; message?: string }> {
  const body = await runGraphQL<ExecuteWorkflowCommandResponse>(
    client,
    sitecoreContextId,
    `mutation ExecuteWorkflowCommand($item: ItemQueryInput!, $commandId: String!, $comments: String) {
      executeWorkflowCommand(input: { item: $item, commandId: $commandId, comments: $comments }) {
        successful
        completed
        nextStateId
        message
        error
      }
    }`,
    {
      item: {
        database: DATABASE,
        itemId: normalizeGuid(item.itemId),
        language: item.language,
        version: item.version,
      },
      commandId: normalizeGuid(commandId),
      comments,
    }
  );

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }

  const result = body.data?.executeWorkflowCommand;
  return {
    successful: result?.successful === true,
    message: result?.error || result?.message || undefined,
  };
}

/**
 * Moves one language version forward until it reaches the final workflow state,
 * executing whichever commands the current state exposes.
 */
export async function approveLanguage(
  client: ClientSDK,
  sitecoreContextId: string,
  itemId: string,
  info: LanguageWorkflow,
  comments: string,
  actor: WorkflowActor
): Promise<ApproveResult> {
  const steps: string[] = [];

  if (!info.hasVersion) {
    return { language: info.language, status: "skipped", steps, error: "No version in this language." };
  }

  if (info.isFinal) {
    return {
      language: info.language,
      status: "already-approved",
      steps,
      finalStateName: info.stateName,
    };
  }

  if (!info.workflowId || !info.stateId) {
    return {
      language: info.language,
      status: "failed",
      steps,
      error: "The version is not attached to a workflow.",
    };
  }

  let current: LanguageWorkflow = info;
  const visited = new Set<string>();

  for (let attempt = 0; attempt < MAX_TRANSITIONS; attempt++) {
    if (current.isFinal) {
      return {
        language: info.language,
        status: "approved",
        steps,
        finalStateName: current.stateName,
      };
    }

    if (!current.workflowId || !current.stateId) {
      return { language: info.language, status: "failed", steps, error: "Workflow state unavailable." };
    }

    if (visited.has(current.stateId)) {
      return {
        language: info.language,
        status: "failed",
        steps,
        error: `Workflow stopped looping in state "${current.stateName ?? current.stateId}".`,
      };
    }
    visited.add(current.stateId);

    const commands = await filterCommandsBySecurity(
      client,
      sitecoreContextId,
      await getCommands(client, sitecoreContextId, current.workflowId, current.stateId),
      actor
    );
    const candidates = orderCommands(commands, actor.isAdministrator);

    if (candidates.length === 0) {
      return {
        language: info.language,
        status: "failed",
        steps,
        error: `No command you are allowed to run from "${
          current.stateName ?? current.stateId
        }".`,
      };
    }

    // The author may not be allowed to run the preferred command, so fall through the
    // remaining ones (for example Approve when Review is denied from Draft).
    let executed: WorkflowCommand | undefined;
    let lastError: string | undefined;

    for (const candidate of candidates) {
      try {
        const execution = await executeCommand(
          client,
          sitecoreContextId,
          { itemId, language: info.language, version: current.version ?? 1 },
          candidate.commandId,
          comments
        );

        if (execution.successful) {
          executed = candidate;
          break;
        }

        lastError = execution.message ?? `Command "${candidate.displayName}" was rejected by Sitecore.`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : `Command "${candidate.displayName}" failed.`;
      }
    }

    if (!executed) {
      return { language: info.language, status: "failed", steps, error: lastError };
    }

    steps.push(executed.displayName || executed.commandId);

    const [refreshed] = await readWorkflowByLanguage(client, sitecoreContextId, itemId, [info.language]);
    if (!refreshed) {
      return { language: info.language, status: "failed", steps, error: "Could not re-read the workflow state." };
    }
    current = refreshed;
  }

  return {
    language: info.language,
    status: "failed",
    steps,
    error: `Still in "${current.stateName ?? "unknown state"}" after ${MAX_TRANSITIONS} transitions.`,
  };
}
