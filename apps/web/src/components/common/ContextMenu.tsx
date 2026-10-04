import { useEffect } from "react";
import { useUiStore } from "../../stores/uiStore";

/** One global context menu, positioned at the cursor (read02 §28–29). */
export function ContextMenu() {
  const menu = useUiStore((s) => s.menu);
  const close = useUiStore((s) => s.closeMenu);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("blur", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("blur", onPointerDown);
    };
  }, [menu, close]);

  if (!menu) return null;

  const width = 200;
  const height = menu.items.reduce((sum, item) => sum + (item.separator ? 9 : 28), 12);
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - height - 4));

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded border border-desk-line bg-desk-panel2 py-1 shadow-2xl"
      style={{ left, top, width }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {menu.items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="my-1 border-t border-desk-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              close();
            }}
            className={[
              "block w-full px-3 py-1.5 text-left text-xs",
              item.danger ? "text-desk-ember" : "text-desk-ink/90",
              item.disabled ? "opacity-40" : "hover:bg-desk-panel hover:text-desk-ink",
            ].join(" ")}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
