import { tokenize } from "./CommandIntent";

/**
 * What a docker command *predicts*: the containers it will lay, read from the
 * command text the agent submitted.
 *
 * The daemon reports no client, so Absence has exactly two signals for
 * crediting a container event to a command: the command window, and the
 * command's own words. The words are the strong one — `docker run -d --name
 * web nginx` predicts a container named `web` with image `nginx`, and a
 * `start` event that matches is *its* work while one that matches nothing is
 * not, however close it arrived. The window stays as the fallback for commands
 * whose shape this parser does not recognize.
 *
 * This is not a docker grammar: it pulls the few facts that separate "this
 * command's container" from "a container that happened meanwhile" — the
 * `--name`, the image, and compose's project label.
 */

export interface ContainerPrediction {
  /** Container names the command names explicitly (`--name`, `start web`). */
  names: Set<string>;
  /** Image references the command runs (tag optional on either side). */
  images: Set<string>;
  /** compose project name (`-p blog` or the compose file's directory). */
  project?: string;
  /** compose services listed on the command line, if any. */
  services: Set<string>;
  /**
   * True when the docker invocation was recognized. False means the words
   * could not be read (a script, a wrapper, an unknown shape) and the caller
   * must fall back to the window alone.
   */
  parsed: boolean;
}

/** Subcommands that lay a new container. */
const RUN_SUBCOMMANDS = new Set(["run", "create"]);
/** Subcommands that (re)start containers already known by name. */
const START_SUBCOMMANDS = new Set(["start", "restart", "unpause", "restore"]);
/** Subcommands that touch existing containers without starting new ones. */
const NONSTART_SUBCOMMANDS = new Set([
  "stop", "rm", "rmi", "kill", "pause", "exec", "logs", "inspect", "stats",
  "ps", "images", "pull", "push", "build", "tag", "cp", "diff", "export",
  "history", "import", "info", "login", "logout", "save", "search", "version",
  "rename", "update", "wait", "attach", "commit", "top", "port",
]);

/** Long flags of `run`/`create` that consume the next token as their value. */
const RUN_VALUE_FLAGS = new Set([
  "--name", "--publish", "--env", "--volume", "--workdir", "--user", "--hostname",
  "--label", "--network", "--net", "--restart", "--memory", "-m", "--memory-swap",
  "--cpus", "--cpu-shares", "--entrypoint", "--health-cmd", "--health-interval",
  "--health-retries", "--health-timeout", "--health-start-period", "--dns",
  "--dns-search", "--dns-option", "--add-host", "--cap-add", "--cap-drop",
  "--device", "--env-file", "--label-file", "--log-driver", "--log-opt", "--mount",
  "--network-alias", "--platform", "--pull", "--runtime", "--security-opt",
  "--shm-size", "--stop-signal", "--stop-timeout", "--sysctl", "--tmpfs",
  "--ulimit", "--volumes-from", "--isolation", "--kernel-memory", "--group-add",
  "--cidfile", "--domainname", "--expose", "--link", "--memory-reservation",
  "--gpus", "--device-cgroup-rules", "--device-read-bps", "--device-write-bps",
]);

/** Short flags of `run`/`create` that consume the next token. */
const SHORT_VALUE_FLAGS = new Set(["p", "e", "v", "w", "h", "u", "l", "m"]);

/** The CLI the prediction reads; everything before it is a wrapper (wsl, sudo). */
const DRIVERS = new Set(["docker", "docker.exe", "docker-compose", "docker-compose.exe", "podman", "podman.exe", "nerdctl"]);

/** `nginx:alpine@sha256:…` → `nginx:alpine`; `localhost:5000/web` keeps its port. */
export function imageRepo(ref: string): string {
  const withoutDigest = ref.split("@")[0] ?? ref;
  const lastColon = withoutDigest.lastIndexOf(":");
  if (lastColon > withoutDigest.lastIndexOf("/")) {
    return withoutDigest.slice(0, lastColon);
  }
  return withoutDigest;
}

/** Does a daemon-reported image reference match one predicted from a command? */
function imageMatches(predicted: string, reported: string): boolean {
  return predicted === reported || imageRepo(predicted) === imageRepo(reported);
}

export function predictContainers(command: string, cwd: string): ContainerPrediction {
  const empty: ContainerPrediction = {
    names: new Set(),
    images: new Set(),
    services: new Set(),
    parsed: false,
  };
  const tokens = tokenize(command);
  const driverIndex = tokens.findIndex((token) => DRIVERS.has(token.toLowerCase()));
  if (driverIndex < 0) return empty;
  const sub = (tokens[driverIndex + 1] ?? "").toLowerCase();

  if (RUN_SUBCOMMANDS.has(sub)) {
    const prediction: ContainerPrediction = { names: new Set(), images: new Set(), services: new Set(), parsed: true };
    let image: string | undefined;
    for (let i = driverIndex + 2; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token === "--") continue;
      if (token.startsWith("--")) {
        const inline = token.includes("=");
        const base = inline ? token.slice(0, token.indexOf("=")) : token;
        const value = inline ? token.slice(token.indexOf("=") + 1) : tokens[++i];
        if (base === "--name" && value) prediction.names.add(value);
        continue;
      }
      if (token.startsWith("-") && token.length > 1) {
        const flags = token.slice(1);
        const consumesValue = [...flags].some((flag) => SHORT_VALUE_FLAGS.has(flag));
        if (consumesValue && !token.includes("=")) i++;
        continue;
      }
      image = token;
      break;
    }
    if (image) prediction.images.add(image);
    // A command whose image we failed to read predicts nothing usable; the
    // window fallback decides instead, as for an unrecognized shape.
    if (prediction.names.size === 0 && prediction.images.size === 0) return empty;
    return prediction;
  }

  if (START_SUBCOMMANDS.has(sub)) {
    const prediction: ContainerPrediction = { names: new Set(), images: new Set(), services: new Set(), parsed: true };
    for (let i = driverIndex + 2; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token.startsWith("-")) {
        if (token.includes("=")) continue;
        const flags = token.slice(1).replace(/^[a-z]/, "");
        if ([...flags].some((flag) => SHORT_VALUE_FLAGS.has(flag))) i++;
        continue;
      }
      prediction.names.add(token);
    }
    if (prediction.names.size === 0) return empty;
    return prediction;
  }

  if (sub === "compose") {
    const prediction: ContainerPrediction = { names: new Set(), images: new Set(), services: new Set(), parsed: true };
    let project: string | undefined;
    let sawUp = false;
    for (let i = driverIndex + 2; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token.startsWith("--")) {
        const inline = token.includes("=");
        const base = inline ? token.slice(0, token.indexOf("=")) : token;
        const value = inline ? token.slice(token.indexOf("=") + 1) : tokens[++i];
        if (base === "-p" || base === "--project-name") project = value;
        continue;
      }
      if (token === "-p") {
        project = tokens[++i];
        continue;
      }
      if (token.startsWith("-")) continue;
      if (token === "up") sawUp = true;
      else if (sawUp) prediction.services.add(token);
    }
    if (!sawUp) return { ...prediction, parsed: false };
    prediction.project = project ?? composeProjectFromCwd(command, cwd);
    if (!prediction.project && prediction.services.size === 0) return empty;
    return prediction;
  }

  if (NONSTART_SUBCOMMANDS.has(sub)) {
    // Recognized, and recognized as laying nothing: the window must not be
    // allowed to credit a start event to `docker ps` that happened to overlap.
    return { names: new Set(), images: new Set(), services: new Set(), parsed: true };
  }

  return empty;
}

/**
 * compose names its project after the compose file's directory. The command
 * may carry `-f`, may be a `cd x && docker compose up` — walk the tokens for a
 * path and fall back to the working directory's basename.
 */
function composeProjectFromCwd(command: string, cwd: string): string | undefined {
  const pathToken = tokenize(command).findLast(
    (token) => token.includes("/") || token.includes("\\"),
  );
  const base = pathToken ? directoryName(pathToken) : cwd;
  const project = base.split(/[\\/]/).filter(Boolean).pop();
  return project ? sanitize(project) : undefined;
}

function directoryName(path: string): string {
  const trimmed = path.replace(/[\\/][^\\/]*$/, "");
  return trimmed || path;
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "") || name;
}

/**
 * Does a daemon container event match what a command predicted?
 *
 * Names match exactly; compose matches on the daemon's own project label when
 * it carries one and on the `project-service-` name shape otherwise; images
 * match with the tag defaulted either way.
 */
export function eventMatchesPrediction(
  event: { name: string; image: string; project?: string },
  prediction: ContainerPrediction,
): boolean {
  if (prediction.names.has(event.name)) return true;
  if (prediction.project) {
    if (event.project && event.project === prediction.project) return true;
    if (event.name.startsWith(`${prediction.project}-`)) {
      if (prediction.services.size === 0) return true;
      for (const service of prediction.services) {
        if (event.name.startsWith(`${prediction.project}-${service}-`)) return true;
      }
    }
  }
  for (const image of prediction.images) {
    if (imageMatches(image, event.image)) return true;
  }
  return false;
}
