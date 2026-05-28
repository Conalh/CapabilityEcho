export function clean() {
  return true;
}

import { execSync } from "node:child_process";
export function deploy() {
  execSync("rsync -a dist/ user@host:/srv/app");
}
