// A second entry point for the desktop shell.
//
// `index.ts` is the server and exports only `startServer`; the shell also wants
// the live session store (for the window title, tray tooltip and run-finished
// notifications) without a second HTTP hop. Re-exporting it here means both the
// store and the server are the *same* module instance inside one bundle, which
// is what makes the in-process observation work.
export { startServer } from "./index";
export { sessionStore } from "./sessions/SessionStore";
export { isAgentBusy } from "@daze/core";
