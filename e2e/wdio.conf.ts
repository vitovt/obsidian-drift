/// <reference types="wdio-electron-service" />

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ObsidianApp from "./test/pageobjects/ObsidianApp";

const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), "drift-e2e-profile-"));
const debug = process.env.DEBUG;
const ONE_DAY = 24 * 60 * 60 * 1000;

export const config: WebdriverIO.Config = {
    runner: 'local',
    tsConfigPath: './tsconfig.json',
    specs: [
        './test/specs/**/*.ts'
    ],
    exclude: [],
    maxInstances: 1,
    capabilities: [{
        browserName: 'electron',
        browserVersion: process.env.OBSIDIAN_ELECTRON_VERSION || '37.10.2',
        'wdio:electronServiceOptions': {
            appBinaryPath: process.env.OBSIDIAN_BINARY || (process.platform === 'darwin' ? '/Applications/Obsidian.app/Contents/MacOS/Obsidian' : '/opt/Obsidian/obsidian'),
            appArgs: [`--user-data-dir=${testProfile}`, '--no-sandbox', '--disable-gpu']
        }
    }],
    logLevel: 'warn',
    bail: 0,
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    services: ['electron'],
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {
        ui: 'bdd',
        timeout: debug ? ONE_DAY : 60000,
    },
    onPrepare: () => {
        // Clean up leftover vault dirs from previous runs
        for (const entry of fs.readdirSync('.')) {
            if (entry.startsWith('.e2e_test_vault_')) {
                fs.rmSync(entry, { force: true, recursive: true });
            }
        }
    },
    onComplete: () => { fs.rmSync(testProfile, {recursive: true, force: true}); },
    beforeSuite: async () => {
        await ObsidianApp.removeE2eTestVaultIfExists();
        await ObsidianApp.createAndOpenFreshVault();
        await ObsidianApp.activateTargetPluginForTesting();
    },
    afterTest: async (_test, _context, {passed}) => {
        if (!passed) await browser.saveScreenshot("/tmp/drift-e2e-failure.png");
    },
    afterSuite: async () => {
        await ObsidianApp.removeE2eTestVaultIfExists();
    },
}
