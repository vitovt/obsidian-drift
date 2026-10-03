import ObsidianApp from "../pageobjects/ObsidianApp";

describe("External change detection", () => {
  it("should preserve a pending review when an ignored API write changes the same file", async () => {
    await ObsidianApp.setReviewSettings({trackApiChanges: false});
    await ObsidianApp.createNewNote("Line one");
    const filePath = await ObsidianApp.getActiveFilePath();

    // External change creates a pending diff
    await ObsidianApp.modifyFileExternally(filePath, "Line one - external");
    await ObsidianApp.waitForDiffTab();

    await ObsidianApp.modifyViaVaultApi(filePath, "Line one - external\nphone edit");
    await ObsidianApp.waitForDiffSectionCount(1);
    const pending = await browser.execute(() => {
      // @ts-expect-error Obsidian application global
      return [...app.plugins.plugins.drift.pendingDiffs.values()].map((diff: any) => ({original: diff.oldContent, conflicted: diff.conflicted}));
    });
    expect(pending[0]).toEqual({original: "Line one", conflicted: true});

    // …and the internal write survives on disk
    const content = await ObsidianApp.readFileFromVault(filePath);
    expect(content).toBe("Line one - external\nphone edit");
  });
});
