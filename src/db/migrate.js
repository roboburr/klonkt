#!/usr/bin/env node
import 'dotenv/config';
import db, { initializeDatabase } from '../config/database.js';

console.log('🔧 Running migrations...');
initializeDatabase();

const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
`).all();

console.log('\n📊 Tables:');
tables.forEach(t => console.log('  ✓', t.name));
console.log('\n✅ Done.');
db.close();
