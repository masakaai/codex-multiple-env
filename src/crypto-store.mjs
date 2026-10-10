import { homedir } from "node:os";
import { join } from "node:path";

export function cxHome() {
  return process.env.CX_HOME || join(homedir(), ".config", "cx");
}
