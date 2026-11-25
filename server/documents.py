"""Resume / document text extraction for PDF, DOCX and plain text."""

from __future__ import annotations

import re
from io import BytesIO

MAX_BYTES = 8 * 1024 * 1024


def _clean(text: str) -> str:
    text = text.replace(" ", " ").replace("​", "")
    text = re.sub(r"[•●▪◦‣⁃]", "\n• ", text)  # bullets onto own lines
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # re-join hyphenated line breaks
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(lines).strip()


def _pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - fallback for older installs
        from PyPDF2 import PdfReader
    try:
        reader = PdfReader(BytesIO(data))
    except Exception as error:
        raise ValueError("That file could not be read as a PDF.") from error
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception as error:
            raise ValueError("That PDF is password protected.") from error
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def _docx(data: bytes) -> str:
    try:
        import docx
    except ImportError as error:
        raise ValueError("Word files need python-docx. Upload a PDF instead.") from error
    document = docx.Document(BytesIO(data))
    parts = [paragraph.text for paragraph in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts)


def extract_text(filename: str, data: bytes) -> str:
    if not data:
        raise ValueError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise ValueError("That file is larger than 8 MB.")
    name = (filename or "").lower()
    if name.endswith(".pdf") or data[:4] == b"%PDF":
        text = _pdf(data)
    elif name.endswith(".docx"):
        text = _docx(data)
    elif name.endswith((".txt", ".md")):
        text = data.decode("utf-8", errors="ignore")
    else:
        raise ValueError("Upload a PDF, DOCX or TXT file.")
    text = _clean(text)
    if len(text) < 40:
        raise ValueError("That file has almost no readable text. If it is a scanned image, export a text-based PDF.")
    return text
