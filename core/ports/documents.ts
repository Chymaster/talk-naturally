/**
 * Document text extraction — design/60-ingestion.md §5.
 *
 * The core needs the text of a learner-uploaded document; how a pdf/docx/pptx is
 * decoded is an adapter concern, and no parsing library may enter `core/`
 * (design/20-architecture.md §2, design/70-stack.md §1).
 */

export interface DocumentSection {
 /** Heading or slide title, as found in the document. */
 readonly title: string;
 readonly text: string;
}

export interface ExtractedDocument {
 readonly filename: string;
 readonly mediaType: string;
 readonly text: string;
 /** Headings/slides in order — a natural source of chapter/unit labels (design/60-ingestion.md §5). */
 readonly sections: readonly DocumentSection[];
}

export interface DocumentUpload {
 readonly filename: string;
 readonly mediaType: string;
 readonly bytes: Uint8Array;
}

export interface DocumentPort {
 /**
  * True when this adapter can decode the type. An unsupported type is reported
  * to the learner in conversation, never guessed at (design/60-ingestion.md §5).
  */
 supports(mediaType: string, filename: string): boolean;
 extract(upload: DocumentUpload): Promise<ExtractedDocument>;
}
