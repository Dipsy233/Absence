import type { ReactNode, Ref } from "react";

interface PanelProps {
  title: string;
  aside?: ReactNode;
  className?: string;
  bodyClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export function Panel({ title, aside, className, bodyClassName, bodyRef, children }: PanelProps) {
  return (
    <section className={["panel", className].filter(Boolean).join(" ")}>
      <header className="panel-header">
        <span>{title}</span>
        {aside ? <span className="font-mono text-[10px] normal-case tracking-normal">{aside}</span> : null}
      </header>
      <div ref={bodyRef} className={["panel-body", bodyClassName].filter(Boolean).join(" ")}>
        {children}
      </div>
    </section>
  );
}
