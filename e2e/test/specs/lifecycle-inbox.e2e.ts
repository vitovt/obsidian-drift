import ObsidianApp from "../pageobjects/ObsidianApp";

describe("Lifecycle review inbox", () => {
  it("ignores a copied file initially, then reviews edits and preserves drafts through rename decisions", async () => {
    await ObsidianApp.setReviewSettings({trackFileRenames: true, trackFileDeletions: true});
    const original = Array.from({length: 80}, (_, i) => `Observation ${i}: evidence_${i} supports this project decision.`).join("\n");
    await ObsidianApp.modifyFileExternally("copied.md", original);
    await browser.waitUntil(async () => browser.execute(() => {
      // @ts-expect-error Obsidian global
      return app.plugins.plugins.drift.baselines.has("copied.md");
    }));
    expect((await ObsidianApp.getDiffSections()).length).toBe(0);

    await ObsidianApp.modifyFileExternally("copied.md", original + "\nExternal update");
    await ObsidianApp.waitForDiffTab();
    await ObsidianApp.focusDiffTab();
    await browser.execute(() => {
      // @ts-expect-error Obsidian global
      const view = app.workspace.getLeavesOfType("external-diff-view")[0].view;
      const editor = view.sections.get("copied.md").mergeView.b;
      editor.dispatch({changes: {from: editor.state.doc.length, insert: "\nMy review draft"}});
    });
    await ObsidianApp.renameFileExternally("copied.md", "moved.md");
    await browser.waitUntil(async () => browser.execute(() => {
      // @ts-expect-error Obsidian global
      return !!app.plugins.plugins.drift.pendingDiffs.get("copied.md")?.renameCandidates?.length;
    }));
    await browser.saveScreenshot("/tmp/drift-before-rename.png");
    await $("button=Review match…").click();
    await $(".diff-rename-modal").$("button=Confirm rename").waitForEnabled();
    await browser.saveScreenshot("/tmp/drift-rename-preview.png");
    await $(".diff-rename-modal").$("button=Confirm rename").click();
    await browser.waitUntil(async () => (await $("button=Undo association").isExisting()));
    expect((await ObsidianApp.getMergeViewContent())?.b).toContain("My review draft");
    expect(await ObsidianApp.readFileFromVault("moved.md")).not.toContain("My review draft");
    await $("button=Undo association").click();
    await browser.waitUntil(async () => (await $("button=Look for matches again").isExisting()));
    expect((await ObsidianApp.getMergeViewContent())?.b).toContain("My review draft");
  });
});
