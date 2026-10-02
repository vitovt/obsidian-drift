import ObsidianApp from "../pageobjects/ObsidianApp";

describe("Replacement saves and offline reconciliation", () => {
  it("reviews replacement contents and retains an edited draft across offline changes", async () => {
    await ObsidianApp.createNoteViaApi("note.md", "Original text");
    await ObsidianApp.modifyViaVaultApi("note.md", "API edit");
    await ObsidianApp.waitForDiffTab();
    expect((await ObsidianApp.getMergeViewContent())?.a).toBe("Original text");
    await ObsidianApp.clickAccept(0);
    await ObsidianApp.replaceFileExternally("note.md", "Replacement contents");
    await ObsidianApp.waitForDiffTab();
    await ObsidianApp.focusDiffTab();
    await browser.waitUntil(async () => (await ObsidianApp.getMergeViewContent())?.b === "Replacement contents");
    expect((await ObsidianApp.getMergeViewContent())?.a).toBe("API edit");
    await browser.execute(() => {
      // @ts-expect-error Obsidian global
      const view = app.workspace.getLeavesOfType("external-diff-view")[0].view;
      const editor = view.sections.get("note.md").mergeView.b;
      editor.dispatch({changes: {from: 0, to: editor.state.doc.length, insert: "Saved review draft"}});
    });
    await browser.execute(async () => {
      // @ts-expect-error Obsidian global
      const plugin = app.plugins.plugins.drift;
      // @ts-expect-error Obsidian global
      await app.plugins.disablePlugin("drift");
      await plugin.saveQueue;
    });
    await ObsidianApp.modifyFileExternally("note.md", "Changed while closed");
    await browser.execute(async () => {
      // @ts-expect-error Obsidian global
      await app.plugins.enablePlugin("drift");
    });
    await browser.waitUntil(async () => browser.execute(() => {
      // @ts-expect-error Obsidian global
      return !!app.plugins.plugins.drift?.baselineReady;
    }));
    await ObsidianApp.openDiffViewer();
    await ObsidianApp.focusDiffTab();
    expect((await ObsidianApp.getMergeViewContent())?.b).toBe("Saved review draft");
    await $("button=Review latest changes").click();
    await browser.waitUntil(async () => (await ObsidianApp.getMergeViewContent())?.a === "Changed while closed");
    expect(await ObsidianApp.readFileFromVault("note.md")).toBe("Changed while closed");
    await ObsidianApp.clickAccept(0);
    await browser.waitUntil(async () => (await ObsidianApp.readFileFromVault("note.md")) === "Saved review draft");
  });
});
