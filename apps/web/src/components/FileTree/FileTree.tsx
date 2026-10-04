import { useEffect, useMemo, useState } from "react";
import type { FileTreeNode } from "@daze/core";
import { useDazeStore } from "../../stores/useDazeStore";
import { useUiStore } from "../../stores/useUiStore";
import { Panel } from "../Panel";
import { absoluteProjectPath, basename } from "../../lib/format";

const FILE_ACTIONS = new Set(["file_read", "file_write", "file_edit", "file_change"]);

export function FileTree() {
  const tree = useDazeStore((s) => s.tree);
  const session = useDazeStore((s) => s.session);
  const files = useDazeStore((s) => s.files);
  const currentAction = useDazeStore((s) => s.currentAction);
  const selectedPath = useUiStore((s) => s.selectedPath);
  const selectFile = useUiStore((s) => s.selectFile);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const activeAbs = useMemo(() => {
    if (!session) return undefined;
    if (selectedPath) return absoluteProjectPath(session.projectPath, selectedPath);
    const action = currentAction;
    if (action && FILE_ACTIONS.has(action.type)) {
      const path = (action.payload as { path?: string }).path;
      if (path) return absoluteProjectPath(session.projectPath, path);
    }
    return undefined;
  }, [session, selectedPath, currentAction]);

  const seen = useMemo(() => {
    if (!session) return new Set<string>();
    return new Set(files.map((f) => absoluteProjectPath(session.projectPath, f.path)));
  }, [files, session]);

  // Expand the top level, and always reveal the active file.
  useEffect(() => {
    if (!tree) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const child of tree.children ?? []) {
        if (child.type === "directory") next.add(child.path);
      }
      if (activeAbs) {
        const parts = activeAbs.split("/");
        for (let i = 1; i < parts.length; i++) {
          next.add(parts.slice(0, i).join("/"));
        }
      }
      return next;
    });
  }, [tree, activeAbs]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!tree) {
    return (
      <Panel title="Files" className="min-h-0 flex-1">
        <p className="text-xs text-desk-dim">Loading project…</p>
      </Panel>
    );
  }

  return (
    <Panel title="Files" aside={`${seen.size} seen`} className="min-h-0 flex-1">
      <ul className="font-mono text-xs leading-relaxed">
        {(tree.children ?? []).map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            activeAbs={activeAbs}
            seen={seen}
            onToggle={toggle}
            onSelect={selectFile}
          />
        ))}
      </ul>
    </Panel>
  );
}

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  activeAbs?: string;
  seen: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function TreeRow({ node, depth, expanded, activeAbs, seen, onToggle, onSelect }: TreeRowProps) {
  const isOpen = expanded.has(node.path);
  const isActive = activeAbs === node.path;
  const isSeen = seen.has(node.path);
  const pad = { paddingLeft: `${depth * 12 + 4}px` };

  if (node.type === "directory") {
    return (
      <li>
        <button
          type="button"
          style={pad}
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1 rounded py-0.5 text-left text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink"
        >
          <span className="w-3 text-[10px]">{isOpen ? "▾" : "▸"}</span>
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen ? (
          <ul>
            {(node.children ?? []).map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                activeAbs={activeAbs}
                seen={seen}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        style={pad}
        onClick={() => onSelect(node.path)}
        className={[
          "flex w-full items-center gap-1 rounded py-0.5 text-left",
          isActive
            ? "bg-desk-amber/15 text-desk-amber"
            : "text-desk-ink/80 hover:bg-desk-panel2 hover:text-desk-ink",
        ].join(" ")}
        title={node.path}
      >
        <span className={`w-3 text-[10px] ${isSeen ? "text-desk-teal" : "text-transparent"}`}>•</span>
        <span className="truncate">{basename(node.name)}</span>
      </button>
    </li>
  );
}
