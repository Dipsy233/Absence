import { useEffect, useState, type MouseEvent } from "react";
import type { FileTreeNode } from "@absence/core";
import { useChatStore } from "../../stores/chatStore";
import { useFileStore } from "../../stores/fileStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { basename, formatAgo, relativeTo } from "../../lib/format";
import { createStageItem, eventPath } from "../../lib/events";
import { fileContext } from "../../lib/context";
import { unifiedDiff } from "../../lib/diff";
import { languageFromPath } from "../../lib/language";
import { openUserFile } from "../../lib/openFile";
import { useT } from "../../lib/i18n";

/** Level 1: the project tree (read02 §7). */
export function FileTree() {
  const t = useT();
  const tree = useFileStore((s) => s.tree);
  const files = useFileStore((s) => s.files);
  const projectPath = useSessionStore((s) => s.session?.projectPath) ?? "";
  const currentAction = useSessionStore((s) => s.currentAction);
  const following = useStageStore((s) => s.following);
  const activeId = useStageStore((s) => s.activeItem?.id);
  const userFile = useStageStore((s) => s.userFile);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const openStage = useStageStore((s) => s.openStage);
  const openMenu = useUiStore((s) => s.openMenu);
  const setFilesView = useUiStore((s) => s.setFilesView);
  const addContext = useChatStore((s) => s.addContext);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const livePath = eventPath(currentAction);
  // The left tree is the user's view. Highlight the agent's live action while
  // following, or the file *this* slot opened — never an agent-slot file.
  const activePath = following
    ? livePath
    : userFile !== undefined && activeId === userFile.id
      ? userFile.source?.path
      : undefined;
  const activeAbs = activePath ? `${projectPath.replace(/\/$/, "")}/${activePath}` : undefined;

  useEffect(() => {
    if (!tree) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const child of tree.children ?? []) {
        if (child.type === "directory") next.add(child.path);
      }
      if (activeAbs) {
        const parts = activeAbs.split("/");
        for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, [tree, activeAbs]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const handleFileMenu = (event: MouseEvent, rel: string) => {
    event.preventDefault();
    const view = files[rel];
    const content = view?.content ?? "";
    const history = view?.history ?? [];

    openMenu(event.clientX, event.clientY, [
      { label: t("Inspect"), onSelect: () => setFilesView({ kind: "detail", path: rel }) },
      { label: t("Open in Stage"), onSelect: () => void openUserFile(rel) },
      { label: t("View History"), disabled: history.length === 0, onSelect: () => setFilesView({ kind: "history", path: rel }) },
      {
        label: t("View Diff"),
        disabled: history.length < 2,
        onSelect: () => {
          const previous = history[history.length - 2]!;
          const current = history[history.length - 1]!;
          openStage(
            createStageItem(
              "diff",
              rel,
              {
                kind: "diff",
                path: rel,
                before: previous.content,
                after: current.content,
                diff: unifiedDiff(previous.content, current.content, `v${previous.version}`, `v${current.version}`),
                language: languageFromPath(rel),
              },
              { path: rel },
            ),
          );
        },
      },
      { label: "", onSelect: () => {}, separator: true },
      { label: t("Add file to Chat"), onSelect: () => addContext(fileContext(rel, content)) },
      {
        label: t("Explain this"),
        onSelect: () => void sendPrompt(`${fileContext(rel, content).label}\n\`\`\`${languageFromPath(rel)}\n${content.slice(0, 2000)}\n\`\`\`\n\nExplain this file.`),
      },
    ]);
  };

  if (!tree) {
    return <p className="text-xs text-desk-dim">{t("Loading project…")}</p>;
  }

  return (
    <ul className="font-mono text-xs leading-relaxed">
      {(tree.children ?? []).map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          projectPath={projectPath}
          files={files}
          activePath={activePath}
          onToggle={toggle}
          onOpenStage={openUserFile}
          onContextMenu={handleFileMenu}
        />
      ))}
    </ul>
  );
}

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  projectPath: string;
  files: Record<string, { status: string; lastModifiedAt?: number }>;
  activePath?: string;
  onToggle: (path: string) => void;
  onOpenStage: (rel: string) => void;
  onContextMenu: (event: MouseEvent, rel: string) => void;
}

function TreeRow(props: TreeRowProps) {
  const t = useT();
  const { node, depth, expanded, projectPath, files, activePath, onToggle, onOpenStage, onContextMenu } = props;
  const pad = { paddingLeft: `${depth * 12 + 4}px` };

  if (node.type === "directory") {
    const open = expanded.has(node.path);
    return (
      <li>
        <button
          type="button"
          style={pad}
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1 rounded py-0.5 text-left text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink"
        >
          <span className="w-3 text-[10px]">{open ? "▾" : "▸"}</span>
          <span className="truncate">{node.name}</span>
        </button>
        {open ? (
          <ul>
            {(node.children ?? []).map((child) => (
              <TreeRow key={child.path} {...props} node={child} depth={depth + 1} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const rel = relativeTo(projectPath, node.path);
  const view = files[rel];
  const isActive = activePath === rel;

  return (
    <li>
      <button
        type="button"
        style={pad}
        onClick={() => onOpenStage(rel)}
        onContextMenu={(event) => onContextMenu(event, rel)}
        title={view ? `${rel} · ${formatAgo(view.lastModifiedAt)}` : t("{rel} · open in Stage", { rel })}
        className={[
          "flex w-full items-center gap-1 rounded py-0.5 text-left",
          isActive ? "bg-desk-amber/15 text-desk-amber" : "text-desk-ink/80 hover:bg-desk-panel2 hover:text-desk-ink",
        ].join(" ")}
      >
        <span className={`w-3 text-[10px] ${view ? "text-desk-teal" : "text-transparent"}`}>●</span>
        <span className="truncate">{basename(node.name)}</span>
      </button>
    </li>
  );
}
