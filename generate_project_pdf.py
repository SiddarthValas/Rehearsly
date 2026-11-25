from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors

output_path = "AI_Interviewer_Project_Proposal.pdf"
doc = SimpleDocTemplate(
    output_path,
    pagesize=letter,
    rightMargin=0.65 * inch,
    leftMargin=0.65 * inch,
    topMargin=0.55 * inch,
    bottomMargin=0.55 * inch,
)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="TitleCenter",
    parent=styles["Title"],
    alignment=TA_CENTER,
    fontSize=21,
    leading=25,
    textColor=colors.HexColor("#17324D"),
    spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="Subtitle",
    parent=styles["Normal"],
    alignment=TA_CENTER,
    fontSize=10,
    leading=13,
    textColor=colors.HexColor("#52606D"),
    spaceAfter=14,
))
styles.add(ParagraphStyle(
    name="Section",
    parent=styles["Heading2"],
    fontSize=12.5,
    leading=15,
    textColor=colors.HexColor("#0B7285"),
    spaceBefore=7,
    spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="BodySmall",
    parent=styles["BodyText"],
    fontSize=9.2,
    leading=12.2,
    textColor=colors.HexColor("#263238"),
    spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="BulletSmall",
    parent=styles["BodyText"],
    fontSize=9.1,
    leading=11.6,
    leftIndent=12,
    firstLineIndent=-8,
    textColor=colors.HexColor("#263238"),
    spaceAfter=2,
))

story = []
story.append(Paragraph("AI Interviewer", styles["TitleCenter"]))
story.append(Paragraph("GenAI-powered personalized mock interview platform", styles["Subtitle"]))

sections = [
    ("1. Problem Statement", [
        "Many candidates lack access to realistic, personalized interview practice. Generic question lists do not account for a candidate's resume, target role, technical background, or communication style. AI Interviewer creates adaptive mock interviews that help users practice with relevant questions and actionable feedback.",
    ]),
    ("2. Target Users and Use Case", [
        "The platform is designed for students preparing for placements, job seekers, career changers, and professionals improving technical or behavioral interview skills.",
        "A user uploads a resume, selects a role or specialty, configures the interviewer's personality and tone, and completes a text or voice-based mock interview.",
    ]),
    ("3. What the GenAI System Will Do", [
        "- Analyze resume skills, projects, experience, and achievements.",
        "- Generate a balanced mix of resume-based, role-specific, technical, situational, and behavioral questions.",
        "- Ask one question at a time and adapt difficulty based on the user's answers.",
        "- Avoid repeated questions and ask targeted follow-ups when claims need clarification.",
        "- Provide a summary, strengths, weaknesses, score, improvement suggestions, and sample answers.",
        "- Allow users to configure specialty, personality, tone, and optional focus area.",
    ]),
    ("4. Expected Input and Output", [
        "<b>Input:</b> Resume PDF, target role, interview specialty, user answers, personality, tone, and optional focus area such as SQL, Python, leadership, or system design.",
        "<b>Output:</b> Personalized questions, adaptive follow-ups, an interview transcript, evaluation, score, improvement recommendations, and optional audio responses.",
    ]),
    ("5. Proposed Angular Architecture", [
        "The Angular frontend will provide the responsive user interface, configuration controls, resume upload, interview chat, and feedback views. A FastAPI backend will handle document processing, retrieval, local model calls, and audio services.",
    ]),
]

for heading, paragraphs in sections:
    story.append(Paragraph(heading, styles["Section"]))
    for paragraph in paragraphs:
        style = styles["BulletSmall"] if paragraph.startswith("-") else styles["BodySmall"]
        story.append(Paragraph(paragraph, style))

story.append(Paragraph("6. Tools and Models", styles["Section"]))
tech_data = [
    [Paragraph("Layer", styles["BodySmall"]), Paragraph("Technology", styles["BodySmall"]), Paragraph("Purpose", styles["BodySmall"])],
    [Paragraph("Frontend", styles["BodySmall"]), Paragraph("Angular, TypeScript, Angular Material or Tailwind", styles["BodySmall"]), Paragraph("User interface, routing, forms, chat, and responsive design", styles["BodySmall"])],
    [Paragraph("Backend", styles["BodySmall"]), Paragraph("Python FastAPI", styles["BodySmall"]), Paragraph("API endpoints, session handling, and orchestration", styles["BodySmall"])],
    [Paragraph("LLM", styles["BodySmall"]), Paragraph("Ollama with Llama 3.2", styles["BodySmall"]), Paragraph("Local interview responses, question generation, and feedback", styles["BodySmall"])],
    [Paragraph("Embeddings", styles["BodySmall"]), Paragraph("Ollama nomic-embed-text with FAISS or ChromaDB", styles["BodySmall"]), Paragraph("Resume retrieval and relevant context selection", styles["BodySmall"])],
    [Paragraph("Speech", styles["BodySmall"]), Paragraph("faster-whisper and browser/macOS speech synthesis", styles["BodySmall"]), Paragraph("Local voice transcription and playback", styles["BodySmall"])],
    [Paragraph("Documents", styles["BodySmall"]), Paragraph("PyPDF2", styles["BodySmall"]), Paragraph("Resume text extraction", styles["BodySmall"])],
]
table = Table(tech_data, colWidths=[0.9 * inch, 2.2 * inch, 3.75 * inch], repeatRows=1)
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#D9F0F2")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#17324D")),
    ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#B0BEC5")),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 5),
    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ("TOPPADDING", (0, 0), (-1, -1), 4),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
]))
story.append(table)

story.append(Paragraph("7. Current Uncertainty and Evaluation Plan", styles["Section"]))
story.append(Paragraph(
    "The main uncertainty is whether a local model can consistently extract meaningful evidence from different resume formats and produce high-quality, role-specific questions. We will test multiple resumes, inspect extraction quality, measure question relevance and repetition, improve structured resume parsing and prompts, and add fallback behavior when information is missing.",
    styles["BodySmall"],
))

story.append(Spacer(1, 8))
story.append(Paragraph("Prepared for project planning", styles["Subtitle"]))
doc.build(story)
print(output_path)
