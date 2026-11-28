/**
 * A message's documents (PDF, Word, Excel, PowerPoint, text, CSV) as cards: an icon by kind, the
 * name, and "PDF · 1.2 MB". Tapping one opens it in the app's own file viewer
 * (features/files/FileViewer), with its preview and Download. Only people who can read the channel
 * can open it: the file is stored in the channel's own folder, and Storage follows the channel.
 */
import { useState } from "react";
import { CHAT_DOCUMENT_LABELS, chatDocumentType, chatFileKind, fileSize, type ChatDocumentType } from "@crewtavo/core/chatContent";
import { Icon, type IconName } from "@/components/ui/Icon";
import { FileViewer, type ViewerFile } from "@/features/files/FileViewer";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { ChatAttachment } from "./data";
import f from "./chatFiles.module.css";

export const DOCUMENT_ICONS: Record<ChatDocumentType, IconName> = { pdf: "filePdf", word: "fileDoc", sheet: "fileXls", slides: "filePpt", text: "fileTxt", csv: "fileCsv" };

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
};

/**
 * A file in a line of words (a pinned message, a search result): a photo or a voice note by what it
 * is (a voice note's stored name is English, "Voice note.webm"), a document by its name.
 */
export const attachmentLabel = (file: ChatAttachment) => {
  const kind = chatFileKind(file);
  return kind === "photo" ? t("Photo") : kind === "audio" ? t("Voice note") : file.name?.trim() || t("File");
};

/** The stored file's name: what it was called, or the name it's stored under. */
const nameOf = (file: ChatAttachment) => file.name?.trim() || file.path.split("/").pop() || t("File");

/** A chat file as the file viewer opens it: read-only, known by the id in its stored name. */
function viewerFile(file: ChatAttachment, companyId: string): ViewerFile {
  const stored = file.path.split("/").pop() ?? file.path;
  const ending = /\.([a-z0-9]+)$/i.exec(stored)?.[1]?.toLowerCase() ?? "";
  return {
    id: stored.replace(/\.[^.]+$/, ""),
    company_id: companyId,
    path: file.path,
    title: nameOf(file),
    file_name: nameOf(file),
    content_type: file.type || TYPES[ending] || null,
    size_bytes: typeof file.size === "number" ? file.size : null,
    crew_visible: true,
  };
}

export function FileCard({ file }: { file: ChatAttachment }) {
  const { company } = useSession();
  const [open, setOpen] = useState(false);
  const kind = chatDocumentType(file);
  const audio = chatFileKind(file) === "audio";
  const size = fileSize(file.size);
  const name = nameOf(file);
  return (
    <>
      <button type="button" className={f.card} onClick={() => setOpen(true)} title={name} aria-label={t("Open {name}", { name })}>
        <span className={f.icon} data-kind={audio ? "audio" : kind} aria-hidden="true"><Icon name={audio ? "voicemail" : DOCUMENT_ICONS[kind]} size={20} /></span>
        <span className={f.text}>
          <span className={f.name}>{name}</span>
          <span className={f.meta}>{[audio ? t("Voice note") : t(CHAT_DOCUMENT_LABELS[kind]), size].filter(Boolean).join(" · ")}</span>
        </span>
      </button>
      {/* The viewer is drawn over the page, but its taps would still reach the message under it. */}
      {open && <span style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}><FileViewer file={viewerFile(file, company.id)} canEdit={false} onClose={() => setOpen(false)} /></span>}
    </>
  );
}

export function FileCards({ files }: { files: ChatAttachment[] }) {
  if (!files.length) return null;
  return (
    <div className={f.cards}>
      {files.map((file) => <FileCard key={file.path} file={file} />)}
    </div>
  );
}
