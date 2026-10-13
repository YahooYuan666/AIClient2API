import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import logger from '../src/utils/logger.js';
import { initializeAdminPassword, validateCredentials } from '../src/ui-modules/auth.js';

describe('admin password initialization', () => {
    let tempDir;
    let pwdFilePath;
    let warnSpy;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient2api-auth-'));
        pwdFilePath = path.join(tempDir, 'configs', 'pwd');
        warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
        warnSpy.mockRestore();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('generates, stores, and logs a random initial password once', async () => {
        const storedPassword = await initializeAdminPassword(pwdFilePath);
        const passwordLog = warnSpy.mock.calls
            .map(args => args.join(' '))
            .find(message => message.startsWith('[Auth] Initial admin password: '));
        const initialPassword = passwordLog?.replace('[Auth] Initial admin password: ', '');

        expect(initialPassword).toHaveLength(32);
        expect(storedPassword).toMatch(/^pbkdf2:[a-f0-9]{32}:[a-f0-9]{128}$/);
        expect(await fs.readFile(pwdFilePath, 'utf8')).toBe(storedPassword);
        expect(await validateCredentials(initialPassword, pwdFilePath)).toBe(true);
        expect(await validateCredentials('wrong-password', pwdFilePath)).toBe(false);

        warnSpy.mockClear();
        expect(await initializeAdminPassword(pwdFilePath)).toBe(storedPassword);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('replaces an empty password file instead of using a shared default', async () => {
        await fs.mkdir(path.dirname(pwdFilePath), { recursive: true });
        await fs.writeFile(pwdFilePath, '   ');

        const storedPassword = await initializeAdminPassword(pwdFilePath);

        expect(storedPassword).toMatch(/^pbkdf2:/);
        expect(storedPassword).not.toContain('admin123');
    });
});
