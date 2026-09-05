import { assert } from "chai";
import { classifyWriteNoteDestination } from "../src/agent/writeNoteDestination";

describe("write note destination classifier", function () {
  it("treats Zotero library note requests as Zotero note workflows", function () {
    assert.equal(
      classifyWriteNoteDestination(
        "save a standalone note into my Zotero library",
        "Obsidian",
      ),
      "zotero",
    );
    assert.equal(
      classifyWriteNoteDestination("create a reading note for this paper"),
      "zotero",
    );
    assert.equal(
      classifyWriteNoteDestination(
        'Create a collection called "Replay". Write a short standalone note into it. Then find papers in my library and file those into "Replay".',
      ),
      "zotero",
    );
  });

  it("treats explicit external destinations as file note workflows", function () {
    assert.equal(
      classifyWriteNoteDestination("write this figure note to my Obsidian"),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination("save this as a markdown file"),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination(
        "write this to Research Vault",
        "Research Vault",
      ),
      "file",
    );
  });

  it("preserves explicit mixed Zotero-note and file-export requests", function () {
    assert.equal(
      classifyWriteNoteDestination(
        "create a Zotero note and also export it to my Obsidian vault",
      ),
      "both",
    );
  });

  it("does not turn ordinary paper requests into note destination rules", function () {
    assert.equal(classifyWriteNoteDestination("summarize this paper"), "none");
  });

  it("recognizes multilingual file destinations", function () {
    const fileRequests = [
      "写一篇阅读笔记保存为md文件",
      "ノートをファイルに保存してください",
      "노트를 파일로 저장해줘",
      "guardar la nota en un archivo",
      "speichere die Notiz als Datei",
      "сохранить заметку в файл",
    ];
    for (const text of fileRequests) {
      assert.equal(classifyWriteNoteDestination(text), "file", text);
    }
  });

  /**
   * These two moved here from the file list above when issue #374 was fixed.
   * Both name a *folder* (文件夹 / dossier) with no filesystem cue, and in a
   * Zotero plugin that is a collection. The old reading sent them to disk.
   */
  it("routes multilingual folder phrasings to Zotero, not to disk", function () {
    for (const text of [
      "把阅读笔记保存到文件夹",
      "enregistre la note dans un dossier",
    ]) {
      assert.equal(classifyWriteNoteDestination(text), "zotero", text);
    }
  });

  it("recognizes non-ASCII notes directory nicknames", function () {
    assert.equal(
      classifyWriteNoteDestination("把笔记写到 知识库 里", "知识库"),
      "file",
    );
  });

  it("keeps multilingual non-file requests out of the file route", function () {
    assert.equal(
      classifyWriteNoteDestination("总结这篇论文的主要发现"),
      "none",
    );
    assert.equal(classifyWriteNoteDestination("この論文を要約して"), "none");
  });

  it("does not treat a source PDF 文件 as a file destination", function () {
    // 文件 names the source PDF here — these are Zotero-note requests.
    assert.equal(
      classifyWriteNoteDestination("阅读这个PDF文件并保存一份笔记到Zotero"),
      "zotero",
    );
    assert.equal(
      classifyWriteNoteDestination("请根据这份PDF文件保存一条Zotero笔记"),
      "zotero",
    );
    assert.notEqual(
      classifyWriteNoteDestination("帮我写一份关于这个PDF文件的总结笔记"),
      "file",
    );
  });

  it("keeps plain-English requests off the multilingual file route", function () {
    assert.equal(
      classifyWriteNoteDestination(
        "I exported the data to my local machine. Now write a Zotero note about this paper.",
      ),
      "zotero",
    );
    assert.equal(classifyWriteNoteDestination("Décris ce fichier"), "none");
  });

  /**
   * Issue #374. Zotero's own UI calls collections "folders", and this
   * plugin's tool descriptions say "collections (folders)" — so a bare
   * "folder" is a Zotero collection, not a filesystem path. Routing it to
   * `file` sent the note to disk, and with no notes directory configured it
   * went nowhere at all.
   *
   * A filesystem destination now needs an explicit cue: a path, an extension,
   * "file"/"disk", the configured nickname, or Obsidian/vault.
   */
  it("treats a bare folder as a Zotero collection, not a filesystem path", function () {
    const collectionRequests = [
      "save the answer as a note into a specific folder",
      "save the answer as a note into the folder Neuroscience",
      "\u0421\u043e\u0445\u0440\u0430\u043d\u0438 \u043e\u0442\u0432\u0435\u0442 \u043a\u0430\u043a \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0432 \u043f\u0430\u043f\u043a\u0443 Machine Learning",
      "put the note in the Zotero folder Reviews",
    ];
    for (const text of collectionRequests) {
      assert.equal(classifyWriteNoteDestination(text), "zotero", text);
    }
  });

  it("still routes a folder to disk when a filesystem cue is present", function () {
    assert.equal(
      classifyWriteNoteDestination("save the note to my Obsidian folder"),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination(
        "save the note as an md file in that folder",
      ),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination("save the note into ~/notes/reading"),
      "file",
    );
    assert.equal(
      classifyWriteNoteDestination(
        "write the note to my Research Vault folder",
        "Research Vault",
      ),
      "file",
    );
  });

  /**
   * Ordering regression guard. An earlier revision checked the Zotero signal
   * first, which sounds right until you notice that signal leads with a bare
   * \bzotero\b — a mention, not a destination. In a Zotero plugin users say
   * "this Zotero paper" constantly, so explicit file requests were being
   * routed to Zotero notes, taking the runtime's file_io enforcement with
   * them. Every case below pairs a real filesystem cue with the word Zotero.
   */
  it("keeps an explicit file destination even when Zotero is mentioned", function () {
    const fileRequests = [
      "save the note to ~/vaults/papers/x.md instead of Zotero",
      "write reading notes to my Obsidian vault for this Zotero paper",
      "export this Zotero paper's note as a markdown file",
      "save a note about this Zotero item to disk",
    ];
    for (const text of fileRequests) {
      assert.equal(classifyWriteNoteDestination(text), "file", text);
    }
  });

  it("still honours Zotero when it is named as the destination", function () {
    const zoteroRequests = [
      "put this in Zotero, not Obsidian",
      "save the answer as a Zotero note",
      "write this into Zotero",
    ];
    for (const text of zoteroRequests) {
      assert.equal(classifyWriteNoteDestination(text), "zotero", text);
    }
  });

  it("respects the configured nickname over a Zotero mention", function () {
    assert.equal(
      classifyWriteNoteDestination(
        "write notes to MyNotes for this Zotero paper",
        "MyNotes",
      ),
      "file",
    );
  });
});
