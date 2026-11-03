/**
 * Compare the Jev coach with the Claude fallback over a folder of sample drafts.
 *
 *   npm run eval:coach -- samples            # writes eval-out/coach-<timestamp>.{csv,md}
 *   npm run eval:coach -- samples --out dir --only claude
 *
 * Each draft is Markdown with the anchor in front matter:
 *
 *   ---
 *   point: The one-sentence point of the piece.
 *   sections:
 *     - First section
 *     - Second section
 *   not_this: Topics saved for later.
 *   ---
 *   ## First section
 *   Paragraph...
 *
 * Every paragraph of 30+ words is checked by both providers. The report lists each
 * flag with its confidence and an empty "correct" column for the owner to label.
 * Needs ANTHROPIC_API_KEY (Claude) and TYPESAFE_API_KEY (Jev); a missing key skips that provider.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { markdownToDoc } from "../src/lib/doc/markdown";
import { blockText, wordCount } from "../src/lib/doc/model";
import { ClaudeCoach, JevCoach } from "../src/lib/coach/providers";
import { COACH_CONFIG, type Anchor, type CoachFlag, type CoachProvider, type DraftBlock } from "../src/lib/coach/types";

export function parseFrontMatter(src: string): { anchor: Anchor; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const anchor: Anchor = { point: "", sections: "", notThis: "" };
  if (!m) return { anchor, body: src };
  const lines = m[1].split(/\r?\n/);
  let listKey: string | null = null;
  const sections: string[] = [];
  for (const line of lines) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey === "sections") { sections.push(item[1].trim()); continue; }
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    listKey = v ? null : k;
    const val = v.replace(/^["']|["']$/g, "").trim();
    if (k === "point") anchor.point = val;
    else if (k === "not_this" || k === "notThis") anchor.notThis = val;
    else if (k === "sections" && val) sections.push(...val.split(/\s*[|;]\s*/));
  }
  anchor.sections = sections.join("\n");
  return { anchor, body: m[2] };
}

const csvCell = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
const mdCell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) || "samples";
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : "eval-out";
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  const providers: CoachProvider[] = [];
  if (process.env.TYPESAFE_API_KEY && only !== "claude") providers.push(new JevCoach());
  if (process.env.ANTHROPIC_API_KEY && only !== "jev") providers.push(new ClaudeCoach());
  if (!providers.length) { console.error("Set TYPESAFE_API_KEY and/or ANTHROPIC_API_KEY."); process.exit(1); }

  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  type Row = { file: string; pid: string; index: number; paragraph: string; provider: string; type: string; confidence: number | ""; note: string; other: string; section: string };
  const rows: Row[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const { anchor, body } = parseFrontMatter(readFileSync(join(dir, file), "utf8"));
    const doc = markdownToDoc(body);
    // Stable, readable pids for the report.
    doc.content.forEach((b, i) => { b.attrs.pid = `p${String(i + 1).padStart(3, "0")}x`; });
    const blocks: DraftBlock[] = doc.content.map((b) => ({ pid: b.attrs.pid, text: blockText(b), heading: b.type === "heading" }));
    const targets = blocks.filter((b) => !b.heading && wordCount(b.text) >= COACH_CONFIG.minWords).map((b) => b.pid);
    const textOf = new Map(blocks.map((b) => [b.pid, b.text]));
    const indexOf = new Map(blocks.map((b, i) => [b.pid, i + 1]));
    console.log(`${file}: ${targets.length} paragraphs`);

    for (const p of providers) {
      const flags: CoachFlag[] = [];
      try {
        // Claude checks a batch per call (as in the app); Jev one paragraph per request.
        for (let i = 0; i < targets.length; i += COACH_CONFIG.maxTargets) {
          const r = await p.check({ anchor, blocks, targets: targets.slice(i, i + COACH_CONFIG.maxTargets) });
          flags.push(...r.flags);
        }
      } catch (e) {
        errors.push(`${file} / ${p.name}: ${(e as Error).message}`);
        continue;
      }
      const flagged = new Set(flags.map((f) => f.pid));
      for (const f of flags) {
        rows.push({ file, pid: f.pid, index: indexOf.get(f.pid)!, paragraph: textOf.get(f.pid)!, provider: p.name, type: f.type, confidence: Number(f.confidence.toFixed(3)), note: f.note, other: f.otherPid ? `#${indexOf.get(f.otherPid)}` : "", section: f.targetSection || "" });
      }
      for (const t of targets) if (!flagged.has(t)) rows.push({ file, pid: t, index: indexOf.get(t)!, paragraph: textOf.get(t)!, provider: p.name, type: "none", confidence: "", note: "", other: "", section: "" });
    }
  }

  rows.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index || a.provider.localeCompare(b.provider) || a.type.localeCompare(b.type));
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const head = ["file", "paragraph_no", "pid", "provider", "flag", "confidence", "other_paragraph", "target_section", "note", "paragraph_start", "correct (y/n)"];
  const csv = [head.map(csvCell).join(","), ...rows.map((r) => [r.file, r.index, r.pid, r.provider, r.type, r.confidence, r.other, r.section, r.note, r.paragraph.slice(0, 160), ""].map(csvCell).join(","))].join("\n");
  writeFileSync(join(outDir, `coach-${stamp}.csv`), csv);

  // Markdown: one table per draft, one row per paragraph, providers side by side.
  const names = providers.map((p) => p.name);
  let md = `# Coach evaluation, ${new Date().toUTCString()}\n\nProviders: ${names.join(", ")}. Thresholds: repeat ≥ ${COACH_CONFIG.repeatMinConfidence}, drift ≥ ${COACH_CONFIG.driftMinConfidence}, order ≥ ${COACH_CONFIG.orderMinConfidence}.\n\n`;
  const totals = Object.fromEntries(names.map((n) => [n, { repeat: 0, drift: 0, order: 0 }]));
  for (const r of rows) if (r.type !== "none") (totals[r.provider] as any)[r.type]++;
  md += `| Provider | repeat | drift | order |\n|---|---|---|---|\n` + names.map((n) => `| ${n} | ${totals[n].repeat} | ${totals[n].drift} | ${totals[n].order} |`).join("\n") + "\n\n";
  for (const file of files) {
    md += `## ${basename(file)}\n\n| # | Paragraph | ${names.join(" | ")} |\n|---|---|${names.map(() => "---").join("|")}|\n`;
    const byPara = new Map<number, Row[]>();
    for (const r of rows.filter((r) => r.file === file)) byPara.set(r.index, [...(byPara.get(r.index) || []), r]);
    for (const [idx, rs] of [...byPara].sort((a, b) => a[0] - b[0])) {
      const cell = (n: string) => rs.filter((r) => r.provider === n && r.type !== "none")
        .map((r) => `**${r.type}** ${r.confidence}${r.other ? ` (${r.other})` : ""}${r.section ? ` → ${r.section}` : ""}`).join("<br>") || "–";
      md += `| ${idx} | ${mdCell(rs[0].paragraph.slice(0, 120))}… | ${names.map(cell).join(" | ")} |\n`;
    }
    md += "\n";
  }
  if (errors.length) md += `## Errors\n\n${errors.map((e) => `- ${e}`).join("\n")}\n`;
  writeFileSync(join(outDir, `coach-${stamp}.md`), md);
  console.log(`Wrote ${join(outDir, `coach-${stamp}.csv`)} and .md (${rows.length} rows${errors.length ? `, ${errors.length} errors` : ""}).`);
}

if (process.argv[1] && /eval-coach/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
