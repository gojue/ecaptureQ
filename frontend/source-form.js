// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// A readable rendering of collector-supplied argv, never a shell evaluator.
// Quotes preserve argument boundaries, including empty arguments.
export function formatCollectorCommand(argv) {
  if (!Array.isArray(argv) || !argv.every(value => typeof value === 'string')) return '';
  return argv.map(value => /^[\w./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)).join(' ');
}
