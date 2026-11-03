// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Paweł Wilk

import { createInterface } from "node:readline/promises";

export interface Prompter {
  ask(question: string): Promise<string>;
  /** Typed characters are not shown (for the OAuth client secret). */
  askHidden(question: string): Promise<string>;
}

export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelled";
  }
}

/** The input ended (EOF, e.g. Ctrl-D or a closed pipe) before an answer was typed. */
export class PromptEnded extends Error {
  constructor() {
    super("No answer.");
    this.name = "PromptEnded";
  }
}

export const terminalPrompter = (
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter => ({
  ask: async (question) => {
    const rl = createInterface({ input, output, terminal: true });
    try {
      // On EOF readline closes and never settles the question: end it here instead of
      // letting the process exit quietly with status 0.
      return await new Promise<string>((resolve, reject) => {
        const onClose = () => reject(new PromptEnded());
        rl.once("close", onClose);
        rl.question(question).then((answer) => {
          rl.off("close", onClose);
          resolve(answer.trim());
        }, reject);
      });
    } finally {
      rl.close();
    }
  },
  askHidden: (question) =>
    new Promise((resolve, reject) => {
      output.write(question);
      let value = "";
      const wasRaw = input.isRaw;
      const done = (err?: Error) => {
        input.off("data", onData);
        input.setRawMode(wasRaw);
        input.pause();
        output.write("\n");
        if (err) reject(err);
        else resolve(value.trim());
      };
      const onData = (chunk: string | Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return done();
          if (ch === "\u0003" || ch === "\u0004") return done(new PromptCancelled());
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    }),
});
