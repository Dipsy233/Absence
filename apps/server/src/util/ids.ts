/** Short, collision-resistant ids for sessions, messages, etc. */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36).slice(-4);
  return `${prefix}_${rand}${time}`;
}
