import { execFileSync } from "node:child_process";
import { copyFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Rust panic locations in dependencies can otherwise publish the builder's home directory.
const cargoHome = realpathSync(process.env.CARGO_HOME || join(homedir(), ".cargo"));
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f")
  ?? (process.env.RUSTFLAGS || "").split(/\s+/).filter(Boolean);
flags.push(`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${process.cwd()}=/project`);
const target = "wasm32-unknown-unknown";
execFileSync("cargo", ["build", "--locked", "-p", "petvoice-engine", "-p", "petvoice-speech", "--release", "--target", target], {
  stdio: "inherit",
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
});
const output = resolve(process.env.CARGO_TARGET_DIR || "target", target, "release");
copyFileSync(join(output, "petvoice_engine.wasm"), "src/engine/petvoice.wasm");
copyFileSync(join(output, "petvoice_speech.wasm"), "src/engine/petvoice_speech.wasm");
