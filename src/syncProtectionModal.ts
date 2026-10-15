import { Modal, Setting, type App } from "obsidian";
import type { ProtectionRequest } from "./syncProtection";
export class SyncProtectionModal extends Modal {
  private settled = false;
  private resolve?: (approved: boolean) => void;
  constructor(
    app: App,
    private readonly request: ProtectionRequest
  ) {
    super(app);
  }
  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "确认本次大量变更" });
    this.contentEl.createEl("p", {
      text: `本次计划修改 ${this.request.modifiedCount} 项、删除 ${this.request.deletedCount} 项，已暂停以保护文件。`,
    });
    this.contentEl.createEl("p", {
      text: "确认只适用于本次计划，不会关闭删除保护。请先检查以下变更。",
    });
    if (this.request.deletedPaths.length) {
      const details = this.contentEl.createEl("details");
      details.createEl("summary", {
        text: `查看待删除文件目录（${this.request.deletedCount} 项）`,
      });
      const list = details.createEl("ul");
      let visible = 0;
      const append = () => {
        for (const path of this.request.deletedPaths.slice(
          visible,
          visible + 50
        ))
          list.createEl("li", { text: path });
        visible += 50;
        more.hidden = visible >= this.request.deletedPaths.length;
      };
      const more = details.createEl("button", { text: "加载更多文件" });
      more.onclick = append;
      append();
    }
    new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText("返回检查").onClick(() => this.close());
        button.buttonEl.focus();
      })
      .addButton((button) =>
        button
          .setButtonText("确认本次变更")
          .setWarning()
          .onClick(() => {
            this.settled = true;
            this.resolve?.(true);
            this.close();
          })
      );
  }
  onClose() {
    if (!this.settled) this.resolve?.(false);
    this.contentEl.empty();
  }
}
