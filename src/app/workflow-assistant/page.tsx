"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApplicationContext,
  PagesContext,
} from "@sitecore-marketplace-sdk/client";
import { useMarketplaceClient } from "@/src/utils/hooks/useMarketplaceClient";
import {
  canEvaluateSecurity,
  resolveWorkflowActor,
  type WorkflowActor,
} from "@/src/utils/sitecore/permissions";
import {
  approveLanguage,
  getCommandsByLanguage,
  getSitecoreContextId,
  listEnvironmentLanguages,
  readWorkflowByLanguage,
  runCommand,
  type ApproveResult,
  type LanguageWorkflow,
  type WorkflowCommand,
} from "@/src/utils/sitecore/workflow";
import {
  isApproveCommand,
  workflowConfig,
} from "@/src/utils/sitecore/workflowConfig";

const DEFAULT_COMMENTS = workflowConfig.defaultComment;

const statusColors: Record<ApproveResult["status"], string> = {
  approved: "#1a7f37",
  "already-approved": "#57606a",
  skipped: "#57606a",
  failed: "#b42318",
};

function PagesContextPanel() {
  const { client, error, isInitialized } = useMarketplaceClient();
  const [pagesContext, setPagesContext] = useState<PagesContext>();
  const [appContext, setAppContext] = useState<ApplicationContext>();
  const [languages, setLanguages] = useState<LanguageWorkflow[]>([]);
  const [commands, setCommands] = useState<Record<string, WorkflowCommand[]>>(
    {},
  );
  const [results, setResults] = useState<ApproveResult[]>([]);
  const [comments, setComments] = useState(DEFAULT_COMMENTS);
  const [isReading, setIsReading] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [runningCommand, setRunningCommand] = useState<string>();
  const [panelError, setPanelError] = useState<string>();
  const [actor, setActor] = useState<WorkflowActor>();

  const pageId = pagesContext?.pageInfo?.id;
  const sitecoreContextId = useMemo(
    () => getSitecoreContextId(appContext),
    [appContext],
  );

  useEffect(() => {
    if (error) {
      console.error("Error initializing Marketplace client:", error);
      return;
    }
    if (!isInitialized || !client) {
      return;
    }

    client
      .query("application.context")
      .then((res) => setAppContext(res.data))
      .catch((err) =>
        console.error("Error retrieving application.context:", err),
      );

    client
      .query("pages.context", {
        subscribe: true,
        onSuccess: (res) => setPagesContext(res),
      })
      .catch((err) => console.error("Error retrieving pages.context:", err));
  }, [client, error, isInitialized]);

  const loadWorkflowStates = useCallback(async () => {
    if (!client || !sitecoreContextId || !pageId) {
      return;
    }

    setIsReading(true);
    setPanelError(undefined);

    try {
      const workflowActor = await resolveWorkflowActor(client, sitecoreContextId);
      setActor(workflowActor);

      const environmentLanguages = await listEnvironmentLanguages(
        client,
        sitecoreContextId,
      );
      const currentLanguage = pagesContext?.pageInfo?.language;
      const candidates = Array.from(
        new Set([
          ...(currentLanguage ? [currentLanguage] : []),
          ...environmentLanguages,
        ]),
      );

      const states = await readWorkflowByLanguage(
        client,
        sitecoreContextId,
        pageId,
        candidates,
      );
      setLanguages(states);
      setCommands(
        await getCommandsByLanguage(client, sitecoreContextId, states, workflowActor),
      );
    } catch (err) {
      setPanelError(
        err instanceof Error
          ? err.message
          : "Could not read the workflow states.",
      );
      setLanguages([]);
      setCommands({});
    } finally {
      setIsReading(false);
    }
  }, [client, sitecoreContextId, pageId, pagesContext?.pageInfo?.language]);

  useEffect(() => {
    setResults([]);
    loadWorkflowStates();
  }, [loadWorkflowStates]);

  const versions = languages.filter((language) => language.hasVersion);
  const pending = versions.filter((language) => !language.isFinal);
  const approvable = pending.filter((language) =>
    (commands[language.language] ?? []).some(isApproveCommand),
  );
  const canAct = Boolean(actor && canEvaluateSecurity(actor));
  const canApprove = canAct && approvable.length > 0;

  const approveAll = async () => {
    if (!client || !sitecoreContextId || !pageId || !canApprove) {
      return;
    }

    setIsApproving(true);
    setPanelError(undefined);
    setResults([]);

    const collected: ApproveResult[] = [];
    const workflowActor = actor ?? (await resolveWorkflowActor(client, sitecoreContextId));
    for (const language of approvable) {
      try {
        collected.push(
          await approveLanguage(
            client,
            sitecoreContextId,
            pageId,
            language,
            comments,
            workflowActor,
          ),
        );
      } catch (err) {
        collected.push({
          language: language.language,
          status: "failed",
          steps: [],
          error: err instanceof Error ? err.message : "Unexpected error.",
        });
      }
      setResults([...collected]);
    }

    setIsApproving(false);
    await loadWorkflowStates();
    client.mutate("pages.reloadCanvas").catch(() => undefined);
  };

  const executeSingleCommand = async (
    language: LanguageWorkflow,
    command: WorkflowCommand,
  ) => {
    if (!client || !sitecoreContextId || !pageId) {
      return;
    }

    setRunningCommand(`${language.language}:${command.commandId}`);
    setPanelError(undefined);

    const result = await runCommand(
      client,
      sitecoreContextId,
      pageId,
      language,
      command,
      comments,
      actor ?? (await resolveWorkflowActor(client, sitecoreContextId)),
    );
    setResults((previous) => [
      ...previous.filter((entry) => entry.language !== language.language),
      result,
    ]);

    setRunningCommand(undefined);
    await loadWorkflowStates();
    client.mutate("pages.reloadCanvas").catch(() => undefined);
  };

  if (error) {
    return (
      <div style={styles.panel}>
        Could not connect to Sitecore: {error.message}
      </div>
    );
  }

  if (!isInitialized || !pagesContext) {
    return <div style={styles.panel}>Loading page context…</div>;
  }

  return (
    <div style={styles.panel}>
      <h2 style={styles.title}>Workflow Assistant</h2>
      <p style={styles.subtitle}>
        {pagesContext.pageInfo?.name} · current language{" "}
        {pagesContext.pageInfo?.language}
      </p>
      {!sitecoreContextId && (
        <p style={styles.error}>
          No Sitecore context ID found. Enable XM Cloud API access for this app
          in Developer Studio, then reinstall it.
        </p>
      )}

      {panelError && <p style={styles.error}>{panelError}</p>}

      <label style={styles.label}>
        Workflow comment
        <input
          style={styles.input}
          value={comments}
          onChange={(event) => setComments(event.target.value)}
        />
      </label>

      <div style={styles.actions}>
        <button
          style={{
            ...styles.button,
            ...(isApproving || !canApprove ? styles.buttonDisabled : {}),
          }}
          onClick={approveAll}
          title={
            canApprove
              ? "Runs Approve on every language version that allows it"
              : "No language versions have an Approve command you can run"
          }
          disabled={isApproving || isReading || !canApprove}
        >
          {isApproving
            ? "Approving…"
            : `Approve ${approvable.length} version(s)`}
        </button>
        <button
          style={styles.secondaryButton}
          onClick={loadWorkflowStates}
          disabled={isReading}
        >
          Refresh
        </button>
      </div>

      <h3 style={styles.sectionTitle}>Language versions</h3>
      {isReading && <p style={styles.muted}>Reading workflow states…</p>}
      {!isReading && versions.length === 0 && (
        <p style={styles.muted}>
          This page has no language versions in workflow.
        </p>
      )}

      <ul style={styles.list}>
        {versions.map((language) => {
          const result = results.find(
            (entry) => entry.language === language.language,
          );
          const available = commands[language.language] ?? [];
          return (
            <li key={language.language} style={styles.listItem}>
              <div style={styles.row}>
                <strong>{language.language}</strong>
                <span
                  style={{ color: language.isFinal ? "#1a7f37" : "#9a6700" }}
                >
                  {language.stateName ?? "No workflow"}
                </span>
              </div>
              <div style={styles.muted}>version {language.version}</div>
              {available.length > 0 ? (
                <div style={styles.commands}>
                  {available.map((command) => {
                    const isRunning =
                      runningCommand ===
                      `${language.language}:${command.commandId}`;
                    return (
                      <button
                        key={command.commandId}
                        style={styles.commandButton}
                        title={`Run "${command.displayName}" on ${language.language}`}
                        onClick={() => executeSingleCommand(language, command)}
                        disabled={
                          isApproving || isReading || Boolean(runningCommand)
                        }
                      >
                        {isRunning ? "Running…" : command.displayName}
                      </button>
                    );
                  })}
                </div>
              ) : (
                !language.isFinal && (
                  <div style={styles.muted}>
                    No commands available from this state.
                  </div>
                )
              )}
              {result && (
                <div
                  style={{
                    ...styles.muted,
                    color: statusColors[result.status],
                  }}
                >
                  {result.status === "approved" &&
                    `Ran: ${result.steps.join(" → ")}`}
                  {result.status === "already-approved" &&
                    "Already in the final state"}
                  {result.status === "skipped" && result.error}
                  {result.status === "failed" && `Failed: ${result.error}`}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    color: "#1f2328",
    padding: "16px",
  },
  title: { margin: "0 0 4px", fontSize: "16px" },
  subtitle: { margin: "0 0 16px", color: "#57606a" },
  sectionTitle: {
    margin: "20px 0 8px",
    fontSize: "13px",
    textTransform: "uppercase",
    color: "#57606a",
  },
  label: { display: "block", marginBottom: "12px", color: "#57606a" },
  input: {
    display: "block",
    width: "100%",
    marginTop: "4px",
    padding: "6px 8px",
    border: "1px solid #d0d7de",
    borderRadius: "6px",
    fontSize: "14px",
  },
  actions: { display: "flex", gap: "8px" },
  button: {
    flex: 1,
    padding: "8px 12px",
    border: "none",
    borderRadius: "6px",
    background: "#5548d9",
    color: "#fff",
    fontSize: "14px",
    cursor: "pointer",
  },
  buttonDisabled: { background: "#c8c6e8", cursor: "not-allowed" },
  secondaryButton: {
    padding: "8px 12px",
    border: "1px solid #d0d7de",
    borderRadius: "6px",
    background: "#fff",
    fontSize: "14px",
    cursor: "pointer",
  },
  commands: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" },
  commandButton: {
    padding: "3px 10px",
    border: "1px solid #d0d7de",
    borderRadius: "999px",
    background: "#f6f8fa",
    fontSize: "12px",
    cursor: "pointer",
  },
  list: { listStyle: "none", margin: 0, padding: 0 },
  listItem: { padding: "10px 0", borderTop: "1px solid #eaeef2" },
  row: { display: "flex", justifyContent: "space-between", gap: "8px" },
  muted: { color: "#57606a", fontSize: "12px", marginTop: "2px" },
  error: {
    background: "#fff1f0",
    border: "1px solid #ffcecb",
    borderRadius: "6px",
    padding: "8px",
    color: "#b42318",
  },
};

export default PagesContextPanel;
