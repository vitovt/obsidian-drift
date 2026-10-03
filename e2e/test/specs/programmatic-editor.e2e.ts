import ObsidianApp from "../pageobjects/ObsidianApp";

describe("Programmatic editor reviews", () => {
  it("separates editor API conversions from manual edits and honors its toggle", async () => {
    await ObsidianApp.createNewNote("Starting text");
    const path = await ObsidianApp.getActiveFilePath();
    await ObsidianApp.setReviewSettings({trackInAppChanges: false, trackProgrammaticChanges: true, trackApiChanges: true});
    // Exercise real keyboard input as well as direct CodeMirror changes.
    await $(".workspace-leaf.mod-active .cm-content").click();
    await browser.keys(" typed manually");
    await browser.waitUntil(async () => (await ObsidianApp.readFileFromVault(path)).includes("typed manually"));
    expect((await ObsidianApp.getDiffSections()).length).toBe(0);
    const raw = "https://example.com/";
    const linked = "[Example](https://example.com/)";
    await browser.execute((text: string) => {
      // @ts-expect-error Obsidian global
      const view = app.workspace.getLeavesOfType("markdown").find((leaf: any) => leaf.view.file)?.view;
      const cm = view.editor.cm;
      cm.dispatch({changes: {from: 0, to: cm.state.doc.length, insert: text}});
    }, raw);
    expect((await ObsidianApp.getDiffSections()).length).toBe(0);
    await browser.execute((text: string) => {
      // @ts-expect-error Obsidian global
      const editor = app.workspace.getLeavesOfType("markdown").find((leaf: any) => leaf.view.file).view.editor;
      editor.replaceRange(text, {line: 0, ch: 0}, editor.offsetToPos(editor.getValue().length));
    }, linked);
    await ObsidianApp.waitForDiffTab();
    await ObsidianApp.focusDiffTab();
    await browser.waitUntil(async () => (await ObsidianApp.readFileFromVault(path)) === linked);
    expect((await ObsidianApp.getMergeViewContent())?.a).toBe(raw);
    expect((await ObsidianApp.getMergeViewContent())?.b).toBe(linked);
    // Another programmatic replacement must pass the pending-review guard.
    await browser.execute(() => {
      // @ts-expect-error Obsidian global
      const editor = app.workspace.getLeavesOfType("markdown").find((leaf: any) => leaf.view.file).view.editor;
      editor.transaction({changes: [{from: {line: 0, ch: 1}, to: {line: 0, ch: 8}, text: "Updated title"}]});
    });
    await browser.waitUntil(async () => (await ObsidianApp.getMergeViewContent())?.b === "[Updated title](https://example.com/)");
    expect((await ObsidianApp.getMergeViewContent())?.a).toBe(raw);
    await browser.waitUntil(async () => (await ObsidianApp.readFileFromVault(path)) === "[Updated title](https://example.com/)");
    await ObsidianApp.clickAccept(0);
    await ObsidianApp.setReviewSettings({trackProgrammaticChanges: false});
    await browser.execute(() => {
      // @ts-expect-error Obsidian global
      const editor = app.workspace.getLeavesOfType("markdown").find((leaf: any) => leaf.view.file).view.editor;
      editor.setValue("Ignored editor API edit");
    });
    await browser.waitUntil(async () => (await ObsidianApp.readFileFromVault(path)) === "Ignored editor API edit");
    expect((await ObsidianApp.getDiffSections()).length).toBe(0);
    await ObsidianApp.modifyViaVaultApi(path, "Tracked file API edit");
    await ObsidianApp.waitForDiffTab();
    await browser.waitUntil(async () => (await ObsidianApp.getMergeViewContent())?.b === "Tracked file API edit");
    expect((await ObsidianApp.getMergeViewContent())?.a).toBe("Ignored editor API edit");

  });
});
