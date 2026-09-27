/**
 * Text/markdown document adapter — design/60-ingestion.md §5, design/70-stack.md §1.
 *
 * The only format this PoC can decode without a parsing dependency. pdf, docx and
 * pptx adapters implement the same `DocumentPort` behind the same seam once the
 * parsing libraries are chosen (design/70-stack.md §1); nothing in `core/` changes
 * when they arrive.
 */
import type {
 DocumentPort,
 DocumentSection,
 DocumentUpload,
 ExtractedDocument,
} from "../core/ports/documents.js";

const SUPPORTED_MEDIA_TYPES: readonly string[] = [
 "text/plain",
 "text/markdown",
 "text/x-markdown",
];

const SUPPORTED_EXTENSIONS: readonly string[] = [".txt", ".md", ".markdown"];

function extensionOf(filename: string): string {
 const dot = filename.lastIndexOf(".");
 return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

/** Split on markdown headings so a document's own sections become unit labels. */
export function sectionsFromText(text: string): DocumentSection[] {
 const lines = text.split(/\r?\n/u);
 const sections: DocumentSection[] = [];
 let title = "";
 let body: string[] = [];

 const flush = (): void => {
 const content = body.join("\n").trim();
 if (content.length > 0 || title.length > 0) {
 sections.push({ title, text: content });
 }
 body = [];
 };

 for (const line of lines) {
 const heading = /^\s{0,3}(?:#{1,6}\s+(.*)|\*\*(.+)\*\*)\s*$/u.exec(line);
 const headingText = heading?.[1] ?? heading?.[2];
 if (headingText !== undefined && headingText.trim().length > 0) {
 flush();
 title = headingText.trim();
 continue;
 }
 body.push(line);
 }
 flush();

 if (sections.length === 0) {
 return [{ title: "", text: text.trim() }];
 }
 return sections.filter((section) => section.title.length > 0 || section.text.length > 0);
}

export class TextDocumentAdapter implements DocumentPort {
 supports(mediaType: string, filename: string): boolean {
 return (
 SUPPORTED_MEDIA_TYPES.includes(mediaType.trim().toLowerCase()) ||
 SUPPORTED_EXTENSIONS.includes(extensionOf(filename))
 );
 }

 async extract(upload: DocumentUpload): Promise<ExtractedDocument> {
 return {
 filename: upload.filename,
 mediaType: upload.mediaType,
 text: new TextDecoder().decode(upload.bytes),
 sections: sectionsFromText(new TextDecoder().decode(upload.bytes)),
 };
 }
}
