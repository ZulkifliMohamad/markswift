// markswift driver: the program the make.fun harness runs.
//
// It reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each markdown string alone with parse() from parse.js, and writes
// $MAKEFUN_OUTPUT_DIR/html.json (default /output): a JSON array of the HTML
// strings, one per case and in the cases' order.
//
// Runs as `node main.ts` on Node 22, which strips TypeScript types
// natively (erasable syntax only). Only Node built-in modules are used.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

function main(): void {
  const cases = JSON.parse(
    readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'),
  ) as Case[];
  const html: string[] = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    html[k] = parse(cases[k].markdown);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
}

main();
