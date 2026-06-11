import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { loadRuntimeEnv } = require('../src/env.js');

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('runtime env loading', () => {
  it('lets the app .env override inherited blank production vars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-env-'));
    try {
      const envPath = path.join(dir, '.env');
      fs.writeFileSync(envPath, [
        'FEISHU_TENANT_KEY=tenant-real',
        'JWT_SECRET=secret-real',
        '',
      ].join('\n'));

      process.env.FEISHU_TENANT_KEY = '';
      process.env.JWT_SECRET = '';

      const result = loadRuntimeEnv({ path: envPath });

      expect(result.error).toBeUndefined();
      expect(process.env.FEISHU_TENANT_KEY).toBe('tenant-real');
      expect(process.env.JWT_SECRET).toBe('secret-real');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
