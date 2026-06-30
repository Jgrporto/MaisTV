process.argv.push('--dry-run');
await import('./backfill-chat-from-legacy.mjs');
