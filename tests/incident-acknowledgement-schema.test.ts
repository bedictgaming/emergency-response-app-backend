import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../prisma/migrations/20261005093000_alert_attention/migration.sql', import.meta.url),
  'utf8',
);
const model = schema.match(/model IncidentAcknowledgement\s*\{([\s\S]*?)\n\}/)?.[1];

describe('incident acknowledgement relation policies', () => {
  it.each([
    ['user', 'User', 'userId', 'id'],
    ['incident', 'Incident', 'incidentId', 'incidentId'],
  ])('keeps %s ON UPDATE NO ACTION and ON DELETE CASCADE', (field, target, localId, targetId) => {
    expect(model).toBeDefined();
    const relation = model!.split(/\r?\n/).find(line => new RegExp(`^\\s*${field}\\s+${target}\\s+@relation`).test(line));
    expect(relation).toContain(`fields: [${localId}]`);
    expect(relation).toContain(`references: [${targetId}]`);
    expect(relation).toContain('onUpdate: NoAction');
    expect(relation).toContain('onDelete: Cascade');
  });

  it('preserves the historical migration default rather than rewriting its foreign keys', () => {
    const foreignKeys = migration.split(/\r?\n/).filter(line => line.includes('FOREIGN KEY'));
    expect(foreignKeys).toHaveLength(2);
    expect(foreignKeys[0]).toContain('FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE');
    expect(foreignKeys[1]).toContain('FOREIGN KEY ("incident_id") REFERENCES "incidents"("incident_id") ON DELETE CASCADE');
    // Omitted ON UPDATE in PostgreSQL means NO ACTION, not Prisma's default Cascade.
    expect(foreignKeys.every(line => !/\bON UPDATE\b/i.test(line))).toBe(true);
  });
});
