import { describe, expect, it } from "vitest";
import { docWordCount, plainText, sanitizeDoc, type DocJSON } from "@/lib/doc/model";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";
import { diffDocs } from "@/lib/doc/compare";
import { isPrivateAddress, sniffImage } from "@/lib/server/images";

const U = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222", F = "33333333-3333-4333-8333-333333333333";
const SRC = `/api/images/${U}/${P}/${F}.png`;
const para = (pid: string, text: string) => ({ type: "paragraph", attrs: { pid }, content: [{ type: "text", text }] });

describe("image blocks in the document model", () => {
  it("keeps stored images with caption and pid", () => {
    const d = sanitizeDoc({ type: "doc", content: [para("aaaa0001", "Hi there."), { type: "image", attrs: { pid: "imgx0001", src: SRC, alt: "  A  cat  " } }] });
    expect(d.content[1]).toEqual({ type: "image", attrs: { pid: "imgx0001", src: SRC, alt: "A cat" } });
  });

  it("keeps web images that haven't been copied yet, drops unsafe or local ones", () => {
    const d = sanitizeDoc({ type: "doc", content: [
      { type: "image", attrs: { origin: "https://example.com/a.png" } },
      { type: "image", attrs: { src: "https://evil.example/x.png" } },
      { type: "image", attrs: { src: "javascript:alert(1)" } },
      { type: "image", attrs: { origin: "data:image/png;base64,AAAA" } },
      { type: "image", attrs: { origin: "file:///C:/clip.png" } },
      { type: "image", attrs: { uploadId: "abc" } },
    ] } as unknown as DocJSON);
    expect(d.content.map((b) => b.attrs)).toEqual([{ pid: expect.any(String), origin: "https://example.com/a.png" }]);
  });

  it("counts words without images but includes them in plain text", () => {
    const d = sanitizeDoc({ type: "doc", content: [para("aaaa0001", "one two three"), { type: "image", attrs: { pid: "imgx0001", src: SRC, alt: "four five six" } }] });
    expect(docWordCount(d)).toBe(3);
    expect(plainText(d)).toBe(`one two three\n\n![four five six](${SRC})`);
  });

  it("round-trips images through Markdown, including absolute export links", () => {
    const d = sanitizeDoc({ type: "doc", content: [para("aaaa0001", "Text."), { type: "image", attrs: { pid: "imgx0001", src: SRC, alt: "Cat" } }, { type: "image", attrs: { pid: "imgx0002", origin: "https://ex.com/b.jpg" } }] });
    const md = docToMarkdown(d);
    expect(md).toBe(`Text.\n\n![Cat](${SRC})\n\n![](https://ex.com/b.jpg)`);
    const back = markdownToDoc(md);
    expect(back.content.map((b) => [b.type, b.attrs.src, b.attrs.origin, b.attrs.alt])).toEqual([
      ["paragraph", undefined, undefined, undefined], ["image", SRC, undefined, "Cat"], ["image", undefined, "https://ex.com/b.jpg", undefined],
    ]);
    const exported = docToMarkdown(d, "T", "https://writing-desk.onrender.com");
    expect(exported).toContain(`![Cat](https://writing-desk.onrender.com${SRC})`);
    expect(markdownToDoc(exported).content[2].attrs.src).toBe(SRC); // absolute app links come back as stored images
  });

  it("shows removed images in Compare so they can be brought back", () => {
    const then = sanitizeDoc({ type: "doc", content: [para("aaaa0001", "Text."), { type: "image", attrs: { pid: "imgx0001", src: SRC } }] });
    const now = sanitizeDoc({ type: "doc", content: [para("aaaa0001", "Text.")] });
    expect(diffDocs(then, now).removed.map((b) => b.pid)).toEqual(["imgx0001"]);
  });
});

describe("image upload checks", () => {
  it("identifies images by their bytes", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBe("gif");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<html>"))).toBeNull();
  });

  it("refuses to fetch from private or internal addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4005:80b::200e"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
