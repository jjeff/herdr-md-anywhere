// Markdown anywhere: a side panel (beside Files and Changes) that lists the
// Markdown files the focused terminal has mentioned, newest first, and shows
// one formatted. Works on any machine Herdr is connected to: the terminal's
// output comes from `hc read` and the file from that machine through
// herdr-core, so nothing needs to be mounted. Local files can be edited;
// other machines' files are read-only (writeTextFile has no `on`).
// doc.js and blocks.js are copies of markdown-panel's (from herdr-kanso).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, focused, terminals, hc, exec, watchFolder, theme } from "herdr";
import { MarkdownDoc, tildePath } from "./doc.js";
import { mentions } from "./mentions.js";

const ICONS = "mods/md-anywhere/icons";
const HISTORY = 2000;
const REMOTE_READ_MS = 3000;
const FOLDER_MAX = 40;
const folderOf = (path) => path.replace(/\/[^/]*$/, "") || "/";
const nameOf = (path) => path.split("/").pop();

// Runs on the terminal's machine, in one trip. First: the mentioned paths that
// exist there, made absolute (relative to the terminal's folder, ~ to that
// machine's home), in the same order. Then a SPLIT line, then the folder's own
// Markdown: what git tracks, else a shallow look (no node_modules or hidden folders).
const SPLIT = "::md-anywhere-folder::";
const RESOLVE = `cd "$1" 2>/dev/null && inside=1; shift
for p; do
  case $p in "~/"*) p="$HOME/\${p#??}";; esac
  [ -f "$p" ] || continue
  d=$(cd "$(dirname "$p")" && pwd -P) && printf '%s/%s\\n' "$d" "$(basename "$p")"
done
echo "${SPLIT}"
[ -n "$inside" ] || exit 0
here=$(pwd -P)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -- '*.md' '*.markdown' '*.mdx'
else
  find . -maxdepth 3 \\( -name node_modules -o -path '*/.*' \\) -prune -o -type f \\( -iname '*.md' -o -iname '*.markdown' -o -iname '*.mdx' \\) -print | sed 's#^\\./##'
fi | head -2000 | sed "s#^#$here/#"`;

// The folder's Markdown, nearest first, without what the terminal mentioned.
const nearest = (paths, skip) => paths.filter((p) => !skip.has(p))
  .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, FOLDER_MAX);

// The terminal the panel follows, and its machine (null: this one). Same rule
// as the Files panel; a remote pane's terminal gets its machine/ prefix.
function target() {
  const f = focused();
  if (!f?.terminal) return null;
  const space = spaces().find((s) => s.active);
  const on = f.pane === null ? (f.terminal.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const address = on && !f.terminal.includes("/") ? `${on}/${f.terminal}` : f.terminal;
  return { address, on, cwd: f.cwd || space?.folder || "" };
}

export default class MarkdownAnywhere extends View {
  init(_props, cx) {
    this.at = null; this.files = null; this.folder = []; this.doc = null; this.error = null; this.scans = 0;
    this.handle = cx.focus_handle();
  }

  // Changes when the terminal's agent changes status or starts a turn.
  // ponytail: plain shells report no status, so they only refresh on ↻.
  heartbeat() {
    const a = this.at.address, short = a.split("/").pop();
    const t = terminals().find((t) => t.address === a || (t.address === short && !this.at.on));
    return t ? `${t.status}:${t.turn}` : null;
  }

  // Reads the terminal again and lists what it mentioned.
  // keep: leave the current list up while it's read again (same terminal).
  scan(cx, keep = false) {
    const at = this.at, n = ++this.scans;
    if (!keep) { this.files = null; this.folder = []; this.error = null; }
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", at.address, "--lines", String(HISTORY)]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "hc read failed");
        const found = mentions(r.stdout);
        let files = found, folder = [];
        // ponytail: sh-only; a Windows machine shows the paths unchecked and no folder list.
        const ok = await exec("sh", ["-c", RESOLVE, "sh", at.cwd, ...found], { on: at.on }).catch(() => null);
        if (ok?.code === 0) {
          const [mentioned, inFolder = ""] = ok.stdout.split(SPLIT + "\n");
          files = [...new Set(mentioned.split("\n").filter(Boolean))];
          folder = nearest(inFolder.split("\n").filter(Boolean), new Set(files));
        }
        if (n === this.scans) { this.files = files; this.folder = folder; this.error = null; }
      } catch (e) { if (n === this.scans) { this.files = []; this.error = String(e?.message ?? e); } }
      cx.notify();
    });
  }

  open(path, cx) {
    const before = this.doc, on = this.at?.on ?? null;
    cx.spawn(async (cx) => {
      if (before && !(await before.flush())) { cx.notify(); return; }
      before?.release();
      this.doc = new MarkdownDoc(path, on, (to) => this.open(to, cx), ICONS);
      this.doc.load(cx);
      if (on) this.poll(path, cx); else this.watch(path, cx); // watchFolder is local only
      cx.notify();
    });
  }

  watch(path, cx) {
    cx.spawn(async (cx) => {
      try { while (this.doc?.path === path) { await watchFolder(folderOf(path)); if (this.doc?.path === path) this.doc.load(cx); } } catch {}
    });
  }

  // Another machine's file, read again every few seconds while it's shown.
  poll(path, cx) {
    cx.timer.after(REMOTE_READ_MS, (cx) => {
      if (this.doc?.path !== path) return;
      if (!this.doc.editing) this.doc.load(cx);
      this.poll(path, cx);
    });
  }

  back(cx) {
    const doc = this.doc;
    if (!doc) return;
    cx.spawn(async (cx) => {
      if (!(await doc.flush())) { cx.notify(); return; }
      doc.release(); this.doc = null;
      cx.notify();
      this.scan(cx, true);
    });
  }

  render(cx) {
    // Follow the focused terminal; clicking into this panel keeps the last one.
    const now = target();
    if (now && now.address !== this.at?.address) {
      this.at = now; this.beat = this.heartbeat();
      if (!this.doc) this.scan(cx);
    } else if (this.at) {
      // The agent started or finished a turn: what it said may name new files.
      const beat = this.heartbeat();
      if (beat !== this.beat) { this.beat = beat; if (!this.doc) this.scan(cx, true); }
    }
    const t = theme(), doc = this.doc;
    const button = (id, icon, tip, action) => div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => action(cx))
      .child(svg(`${ICONS}/${icon}.svg`).size(14));
    const where = this.at ? (this.at.on ? `${this.at.on} · ${this.at.address}` : this.at.address) : "";
    return v_flex().id("md-anywhere").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => doc?.key(e, cx))
      .child(h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(doc), (el) => el.child(button("mda-back", "chevron-left", "Back to file list", (cx) => this.back(cx))))
        .child(v_flex().flex_1().min_w(0).pl(doc ? 0 : 4)
          .child(div().truncate().font_semibold().child(doc ? nameOf(doc.path) : "Markdown"))
          .child(div().truncate().text_size(11).text_color(t.dim).child(doc ? tildePath(folderOf(doc.path), doc.on) : where)))
        .children(doc ? doc.controls(t, "mda") : [])
        .when(!doc || !doc.editing, (el) => el.child(button("mda-refresh", "refresh", doc ? "Read again" : "Look again",
          (cx) => doc ? doc.load(cx) : this.at && this.scan(cx)))))
      .child(doc ? doc.body(t, "mda-doc") : this.listView(t));
  }

  listView(t) {
    const note = (text) => div().p(16).text_size(12.5).text_color(t.dim).child(text);
    if (!this.at) return note("Focus a terminal to see the Markdown files it mentioned.");
    if (this.files === null) return note("Looking for Markdown…");
    if (this.error) return note(`Cannot read this terminal: ${this.error}`);
    const heading = (text) => div().px(10).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child(text);
    const row = (key) => (f, i) => v_flex().id(`mda-${key}-${i}`).px(10).py(5).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(f, cx))
      .child(div().truncate().child(nameOf(f)))
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(tildePath(folderOf(f), null)));
    return v_flex().id("mda-files").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .child(heading("From this terminal"))
      .when(!this.files.length, (el) => el.child(div().px(10).py(4).text_size(12.5).text_color(t.dim).child("No Markdown mentioned yet.")))
      .children(this.files.map(row("t")))
      .when(this.folder.length > 0, (el) => el.child(heading("In this folder")).children(this.folder.map(row("f"))));
  }
}
