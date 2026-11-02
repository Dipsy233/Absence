#!/usr/bin/env node
/** Prints a deterministic block of bytes, for the long-output scenario. */
const args = process.argv.slice(2);
const at = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const bytes = Math.max(0, at("bytes", 200_000));
const chunk = Math.max(20, at("chunk", 200));
const line = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ | mock agent long output ";
let written = 0;
while (written < bytes) {
  const size = Math.min(chunk, bytes - written);
  process.stdout.write(line.repeat(Math.ceil(size / line.length)).slice(0, size));
  written += size;
}
process.stdout.write("\n");
