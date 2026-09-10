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
import styles from "./page.module.css";

const DEFAULT_COMMENTS = workflowConfig.defaultComment;

const COPY = {
  title: "Workflow Assistant",
  commentLabel: "Workflow comment",
  refresh: "Refresh",
  sectionLanguageVersions: "Language versions",
  loadingPageContext: "Loading page context…",
  readingWorkflowStates: "Reading workflow states…",
  approving: "Approving…",
  running: "Running…",
  noWorkflow: "No workflow",
  noSitecoreContextId:
    "No Sitecore context ID found. Enable XM Cloud API access for this app in Developer Studio, then reinstall it.",
  noLanguageVersions: "This page has no language versions in workflow.",
  noCommandsAvailable: "No commands available from this state.",
  couldNotReadWorkflowStates: "Could not read the workflow states.",
  unexpectedError: "Unexpected error.",
  alreadyInFinalState: "Already in the final state",
  selectAll: "Select all",
  selectLanguage: (language: string) => `Select ${language} for approval`,
  approveEnabledTitle: "Runs Approve on the selected language versions",
  approveDisabledTitle:
    "Select at least one language version with an Approve command",
  connectError: (message: string) =>
    `Could not connect to Sitecore: ${message}`,
  pageSubtitle: (name?: string, language?: string) =>
    `${name ?? ""} · current language ${language ?? ""}`.trim(),
  approveVersions: (count: number) => `Approve ${count} version(s)`,
  versionLabel: (version: number) => `version ${version}`,
  runCommandTitle: (displayName: string, language: string) =>
    `Run "${displayName}" on ${language}`,
  ranSteps: (steps: string[]) => `Ran: ${steps.join(" → ")}`,
  failed: (error?: string) => `Failed: ${error}`,
} as const;

const statusClassName: Record<ApproveResult["status"], string> = {
  approved: styles.statusApproved,
  "already-approved": styles.statusAlreadyApproved,
  skipped: styles.statusSkipped,
  failed: styles.statusFailed,
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
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(
    () => new Set(),
  );

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
      const workflowActor = await resolveWorkflowActor(
        client,
        sitecoreContextId,
      );
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
        await getCommandsByLanguage(
          client,
          sitecoreContextId,
          states,
          workflowActor,
        ),
      );
    } catch (err) {
      setPanelError(
        err instanceof Error ? err.message : COPY.couldNotReadWorkflowStates,
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
  const approvableKeys = approvable.map((language) => language.language).join(",");

  useEffect(() => {
    setSelectedLanguages(
      new Set(approvableKeys.length > 0 ? approvableKeys.split(",") : []),
    );
  }, [approvableKeys]);

  const selectedApprovable = approvable.filter((language) =>
    selectedLanguages.has(language.language),
  );
  const allApprovableSelected =
    approvable.length > 0 && selectedApprovable.length === approvable.length;
  const someApprovableSelected =
    selectedApprovable.length > 0 && !allApprovableSelected;
  const canAct = Boolean(actor && canEvaluateSecurity(actor));
  const canApprove = canAct && selectedApprovable.length > 0;

  const toggleLanguage = (language: string, checked: boolean) => {
    setSelectedLanguages((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(language);
      } else {
        next.delete(language);
      }
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedLanguages(
      checked
        ? new Set(approvable.map((language) => language.language))
        : new Set(),
    );
  };

  const approveSelected = async () => {
    if (!client || !sitecoreContextId || !pageId || !canApprove) {
      return;
    }

    setIsApproving(true);
    setPanelError(undefined);
    setResults([]);

    const collected: ApproveResult[] = [];
    const workflowActor =
      actor ?? (await resolveWorkflowActor(client, sitecoreContextId));
    for (const language of selectedApprovable) {
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
          error: err instanceof Error ? err.message : COPY.unexpectedError,
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
      <div className={styles.panel}>{COPY.connectError(error.message)}</div>
    );
  }

  if (!isInitialized || !pagesContext) {
    return <div className={styles.panel}>{COPY.loadingPageContext}</div>;
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>{COPY.title}</h2>
      <p className={styles.subtitle}>
        {COPY.pageSubtitle(
          pagesContext.pageInfo?.name,
          pagesContext.pageInfo?.language,
        )}
      </p>
      {!sitecoreContextId && (
        <p className={styles.error}>{COPY.noSitecoreContextId}</p>
      )}

      {panelError && <p className={styles.error}>{panelError}</p>}

      <label className={styles.label}>
        {COPY.commentLabel}
        <input
          className={styles.input}
          value={comments}
          onChange={(event) => setComments(event.target.value)}
        />
      </label>

      <div className={styles.actions}>
        <button
          className={styles.button}
          onClick={approveSelected}
          title={
            canApprove ? COPY.approveEnabledTitle : COPY.approveDisabledTitle
          }
          disabled={isApproving || isReading || !canApprove}
        >
          {isApproving
            ? COPY.approving
            : COPY.approveVersions(selectedApprovable.length)}
        </button>
        <button
          className={styles.secondaryButton}
          onClick={loadWorkflowStates}
          disabled={isReading}
        >
          {COPY.refresh}
        </button>
      </div>

      <h3 className={styles.sectionTitle}>{COPY.sectionLanguageVersions}</h3>
      {isReading && (
        <p className={styles.muted}>{COPY.readingWorkflowStates}</p>
      )}
      {!isReading && versions.length === 0 && (
        <p className={styles.muted}>{COPY.noLanguageVersions}</p>
      )}
      {approvable.length > 0 && (
        <label className={styles.selectAll}>
          <input
            type="checkbox"
            checked={allApprovableSelected}
            ref={(element) => {
              if (element) {
                element.indeterminate = someApprovableSelected;
              }
            }}
            onChange={(event) => toggleSelectAll(event.target.checked)}
            disabled={isApproving || isReading}
          />
          {COPY.selectAll}
        </label>
      )}

      <ul className={styles.list}>
        {versions.map((language) => {
          const result = results.find(
            (entry) => entry.language === language.language,
          );
          const available = commands[language.language] ?? [];
          const isApprovable = approvable.some(
            (entry) => entry.language === language.language,
          );
          return (
            <li key={language.language} className={styles.listItem}>
              <div className={styles.row}>
                <label className={styles.languageLabel}>
                  {isApprovable && (
                    <input
                      type="checkbox"
                      checked={selectedLanguages.has(language.language)}
                      onChange={(event) =>
                        toggleLanguage(language.language, event.target.checked)
                      }
                      disabled={isApproving || isReading}
                      aria-label={COPY.selectLanguage(language.language)}
                    />
                  )}
                  <strong>{language.language}</strong>
                </label>
                <span
                  className={
                    language.isFinal ? styles.stateFinal : styles.statePending
                  }
                >
                  {language.stateName ?? COPY.noWorkflow}
                </span>
              </div>
              <div className={styles.muted}>
                {COPY.versionLabel(language.version ?? 0)}
              </div>
              {available.length > 0 ? (
                <div className={styles.commands}>
                  {available.map((command) => {
                    const isRunning =
                      runningCommand ===
                      `${language.language}:${command.commandId}`;
                    return (
                      <button
                        key={command.commandId}
                        className={styles.commandButton}
                        title={COPY.runCommandTitle(
                          command.displayName,
                          language.language,
                        )}
                        onClick={() => executeSingleCommand(language, command)}
                        disabled={
                          isApproving || isReading || Boolean(runningCommand)
                        }
                      >
                        {isRunning ? COPY.running : command.displayName}
                      </button>
                    );
                  })}
                </div>
              ) : (
                !language.isFinal && (
                  <div className={styles.muted}>{COPY.noCommandsAvailable}</div>
                )
              )}
              {result && (
                <div
                  className={`${styles.muted} ${statusClassName[result.status]}`}
                >
                  {result.status === "approved" && COPY.ranSteps(result.steps)}
                  {result.status === "already-approved" &&
                    COPY.alreadyInFinalState}
                  {result.status === "skipped" && result.error}
                  {result.status === "failed" && COPY.failed(result.error)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default PagesContextPanel;
