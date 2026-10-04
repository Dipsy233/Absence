/** Normalize OS path separators to forward slashes for display + matching. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
