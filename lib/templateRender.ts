import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';

const TEMPLATE_DIR = join(fileURLToPath(import.meta.url), '../../templates');

export function renderTemplate(templateName: string, vars: Record<string, string>): string {
  const template = readFileSync(join(TEMPLATE_DIR, templateName), 'utf8');
  return template.replace(/\{\{([a-z0-9_]+)\}\}/gi, (_m, key: string) => {
    const value = vars?.[key];
    if (value == null) {
      logger.warn(`[template] missing variable '{{${key}}}' in ${templateName} — rendered as empty string`);
    }
    return value ?? '';
  });
}
