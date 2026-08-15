#!/usr/bin/env node
// Extracts a simulator scenario (last_poll + control register dump) from a
// Home Assistant diagnostics export for the aecc-battery-local integration.
// Never commit the diagnostics file itself: it is a full dump of a user's
// Home Assistant install, not just the battery data.
//
// Usage: node extract-from-diagnostics.mjs <diagnostics.json> <scenario.json>

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';

// Every StorageSN in Storage_list is replaced by a fixed fake pattern, never
// left blank and never passed through, so a captured serial can never reach
// a committed fixture even if the diagnostics export itself was not scrubbed.
function redactStorageList(list) {
  if (!Array.isArray(list)) return list;
  return list.map((unit, i) => {
    if (!unit || typeof unit !== 'object' || unit.StorageSN === undefined) {
      return unit;
    }
    return {
      ...unit,
      StorageSN: `SIMSN${String(i + 1).padStart(10, '0')}`,
    };
  });
}

export function extractScenario(diagnostics) {
  const data = diagnostics?.data ?? {};
  const lastPoll = data.last_poll ?? {};
  const registers = data.control_registers?.registers ?? {};
  return {
    last_poll: {
      ...lastPoll,
      ...(lastPoll.Storage_list !== undefined
        ? { Storage_list: redactStorageList(lastPoll.Storage_list) }
        : {}),
    },
    registers: { ...registers },
  };
}

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error(
      'usage: node extract-from-diagnostics.mjs <diagnostics.json> <scenario.json>'
    );
    process.exitCode = 1;
    return;
  }
  const diagnostics = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const scenario = extractScenario(diagnostics);
  writeFileSync(outputPath, JSON.stringify(scenario, null, 2) + '\n', 'utf-8');
}

main();
