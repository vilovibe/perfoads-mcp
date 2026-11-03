#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

// Entry point for `perfoads-mcp`. Needs the built dist/ (pnpm build).
import { doctorHint, main, prepareProcess } from "../dist/main.js";

prepareProcess();

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // Never print a stack trace: it could hold paths or values from the request.
    process.stderr.write(`perfoads-mcp: unexpected error. Run \`${doctorHint()}\`.\n`);
    process.exitCode = 1;
  },
);
